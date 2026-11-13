/**
 * Regression: extension trust bootstrap must force untrusted project settings.
 *
 * Fault under test: DefaultResourceLoader.loadProjectTrustExtensions() used to call
 * settingsManager.setProjectTrusted(true) before reloading settings. When the previous
 * state was trusted (or when the manager started trusted), the "pre-trust" pass therefore
 * reloaded project settings and resolved project-local extensions, leaking project code
 * into the trust bootstrap before any trust decision was made.
 *
 * This script loads the real production modules (resource-loader.ts, settings-manager.ts,
 * package-manager.ts) through .prale-eval/subject.mjs and only fakes true boundaries
 * (chalk/ignore/proper-lockfile, config paths, extension file loading, skills/prompts/themes).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolveNative } from "node:path";
import { createGraph } from "./subject.mjs";

const root = resolveNative(import.meta.dirname, "..");

const RESOURCE_LOADER = "packages/coding-agent/src/core/resource-loader.ts";
const SETTINGS_MANAGER = "packages/coding-agent/src/core/settings-manager.ts";
const PACKAGE_MANAGER = "packages/coding-agent/src/core/package-manager.ts";

// ---------------------------------------------------------------------------
// Boundary fakes
// ---------------------------------------------------------------------------

function resolvePath(input, baseDir = root, options = {}) {
  let normalized = options.trim ? input.trim() : input;
  if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
  return isAbsolute(normalized) ? resolveNative(normalized) : resolveNative(baseDir, normalized);
}

function canonicalizePath(value) {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

function isLocalPath(value) {
  const trimmed = value.trim();
  return !["npm:", "git:", "github:", "http:", "https:", "ssh:"].some((prefix) => trimmed.startsWith(prefix));
}

function stripBom(value) {
  return value.startsWith("\uFEFF") ? value.slice(1) : value;
}

/** ignore() matcher: enough for extension discovery in this fixture. */
function createIgnoreMatcher() {
  return { add() {}, ignores() { return false; }, filter: (entries) => entries, test: () => false };
}

// `bindings` is shared by every non-builtin specifier, so the single `default`
// export is used by chalk (resource-loader), ignore (package-manager) and
// proper-lockfile (settings-manager) at once.
const defaultExport = Object.assign(
  function defaultExportFn() {
    return createIgnoreMatcher();
  },
  {
    yellow: (value) => String(value),
    red: (value) => String(value),
    green: (value) => String(value),
    dim: (value) => String(value),
    bold: (value) => String(value),
    lockSync: () => () => {},
    lock: async () => async () => {},
    unlock: () => {},
  },
);

const bindings = {
  default: defaultExport,
  CONFIG_DIR_NAME: ".pi",
  getAgentDir: () => join(root, ".prale-eval", ".nonexistent-agent"),
  normalizePath: (value) => value,

  loadThemeFromPath: () => {
    throw new Error("unexpected theme load in regression");
  },
  canonicalizePath,
  isLocalPath,
  markPathIgnoredByCloudSync: () => {},
  resolvePath,
  stripBom,
  createEventBus: () => ({ emit() {}, on: () => () => {}, clear() {} }),
  clearExtensionCache: () => {},
  createExtensionRuntime: () => ({}),
  loadExtensionFromFactory: async () => {
    throw new Error("unexpected inline extension load in regression");
  },
  findGitPaths: () => undefined,
  loadPromptTemplates: () => ({ templates: [], diagnostics: [] }),
  loadSkills: () => ({ skills: [], diagnostics: [] }),
  createSourceInfo: (path, metadata) => ({
    path,
    source: metadata.source,
    scope: metadata.scope,
    origin: metadata.origin,
    baseDir: metadata.baseDir,
  }),
  resetTimings: () => {},

  DEFAULT_MAX_AGENT_RETRY_DELAY_MS: 60_000,
  DEFAULT_HTTP_IDLE_TIMEOUT_MS: 300_000,
  parseHttpIdleTimeoutMs: () => undefined,

  spawnProcess: async () => ({ stdout: "", stderr: "" }),
  spawnProcessSync: () => ({ stdout: "", stderr: "" }),
  parseGitUrl: () => undefined,
  isStdoutTakenOver: () => false,
  readPiManifest: () => undefined,
  minimatch: () => false,
  gt: () => false,
  maxSatisfying: () => null,
  rcompare: () => 0,
  satisfies: () => false,
  valid: () => null,
  validRange: () => null,
};

/** Records every extension path handed to the real loader boundary. */
function createLoadRecorder() {
  const calls = [];
  const loadExtensionsCached = async (paths, cwd, eventBus, runtime) => {
    calls.push([...paths]);
    return {
      extensions: paths.map((path) => ({
        path,
        resolvedPath: path,
        commands: new Map(),
        tools: new Map(),
        flags: new Map(),
      })),
      errors: [],
      warnings: [],
      runtime: runtime ?? {},
    };
  };
  return { calls, loadExtensionsCached };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const fixtureRoot = mkdtempSync(join(root, ".prale-eval", ".regression-"));
const agentDir = join(fixtureRoot, "agent");
const projectDir = join(fixtureRoot, "project");
const cliDir = join(fixtureRoot, "cli");
const userExtension = join(agentDir, "extensions", "user-extension.ts");
const projectExtension = join(projectDir, ".pi", "extensions", "project-extension.ts");
const cliExtension = join(cliDir, "cli-extension.ts");

function buildFixture() {
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(join(projectDir, ".pi", "extensions"), { recursive: true });
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(userExtension, "export default function userExtension() {}\n");
  writeFileSync(projectExtension, "export default function projectExtension() {}\n");
  writeFileSync(cliExtension, "export default function cliExtension() {}\n");
  writeFileSync(join(projectDir, ".pi", "settings.json"), `${JSON.stringify({ theme: "project-theme" })}\n`);
}

/** Copies VM-realm values into host arrays so assertions compare plain host values. */
function names(result) {
  return Array.from(result.extensions, (extension) => String(extension.path)).sort();
}

// ---------------------------------------------------------------------------
// Scenario 1: previous state was trusted -> bootstrap pass must still be untrusted
// ---------------------------------------------------------------------------

async function scenarioPreviousTrusted(graph, recorder) {
  const { DefaultResourceLoader } = await graph.module(RESOURCE_LOADER);
  const { SettingsManager } = await graph.module(SETTINGS_MANAGER);

  const settingsManager = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
  assert.equal(
    settingsManager.isProjectTrusted(),
    true,
    "fixture precondition: settings manager starts in the trusted state (the leak source)",
  );
  assert.equal(
    String(settingsManager.getProjectSettings().theme),
    "project-theme",
    "fixture precondition: project settings are readable while trusted",
  );

  const loader = new DefaultResourceLoader({
    cwd: projectDir,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [cliExtension],
  });

  const preTrust = await loader.loadProjectTrustExtensions();

  assert.equal(
    settingsManager.isProjectTrusted(),
    false,
    "bootstrap pass must force untrusted project settings even when the previous state was trusted",
  );
  assert.deepEqual(
    Object.keys(settingsManager.getProjectSettings()),
    [],
    "bootstrap pass must not expose project settings",
  );

  const loaded = names(preTrust);
  assert.deepEqual(
    loaded,
    [cliExtension, userExtension].sort(),
    `bootstrap pass must load only user/global and CLI extensions, got: ${JSON.stringify(loaded)}`,
  );
  assert.ok(
    !loaded.includes(projectExtension),
    "project-local extension must not leak into the trust bootstrap",
  );

  const recorded = recorder.calls.flat();
  assert.ok(
    !recorded.includes(projectExtension),
    "project-local extension path must never be resolved during the bootstrap pass",
  );
  assert.ok(recorded.includes(userExtension), "user/global extension must stay available");
  assert.ok(recorded.includes(cliExtension), "temporary CLI extension must stay available");

  return { settingsManager, loader };
}

// ---------------------------------------------------------------------------
// Scenario 2: full reload() -> pre-trust seen by callback, then trusted set is loaded
// ---------------------------------------------------------------------------

async function scenarioReloadResolvesTrust(graph, recorder) {
  const { DefaultResourceLoader } = await graph.module(RESOURCE_LOADER);
  const { SettingsManager } = await graph.module(SETTINGS_MANAGER);

  const settingsManager = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
  const loader = new DefaultResourceLoader({
    cwd: projectDir,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [cliExtension],
  });

  let observedDuringTrustPrompt;
  await loader.reload({
    resolveProjectTrust: async ({ extensionsResult }) => {
      observedDuringTrustPrompt = {
        names: names(extensionsResult),
        trusted: settingsManager.isProjectTrusted(),
      };
      return true;
    },
  });

  assert.equal(
    observedDuringTrustPrompt.trusted,
    false,
    "project_trust extensions must observe an untrusted settings manager",
  );
  assert.ok(
    !observedDuringTrustPrompt.names.includes(projectExtension),
    `project-local extension leaked into the trust prompt: ${JSON.stringify(observedDuringTrustPrompt.names)}`,
  );
  assert.ok(
    observedDuringTrustPrompt.names.includes(userExtension),
    "user/global extension must be available to the trust prompt",
  );
  assert.ok(
    observedDuringTrustPrompt.names.includes(cliExtension),
    "CLI extension must be available to the trust prompt",
  );

  assert.equal(settingsManager.isProjectTrusted(), true, "resolved trust must be applied");
  assert.deepEqual(
    names(loader.getExtensions()),
    [cliExtension, projectExtension, userExtension].sort(),
    "after the project is trusted, project extensions load on top of user/global extensions",
  );
}

// ---------------------------------------------------------------------------
// Scenario 3: reload() resolving "untrusted" keeps project extensions out
// ---------------------------------------------------------------------------

async function scenarioReloadDeniesTrust(graph, recorder) {
  const { DefaultResourceLoader } = await graph.module(RESOURCE_LOADER);
  const { SettingsManager } = await graph.module(SETTINGS_MANAGER);

  const settingsManager = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
  const loader = new DefaultResourceLoader({
    cwd: projectDir,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [cliExtension],
  });

  let observedDuringTrustPrompt;
  await loader.reload({
    resolveProjectTrust: async ({ extensionsResult }) => {
      observedDuringTrustPrompt = names(extensionsResult);
      return false;
    },
  });

  assert.ok(
    !observedDuringTrustPrompt.includes(projectExtension),
    "project-local extension leaked into an untrusted trust prompt",
  );
  assert.equal(settingsManager.isProjectTrusted(), false, "denied trust must be applied");
  assert.deepEqual(
    names(loader.getExtensions()),
    [cliExtension, userExtension].sort(),
    "denied project trust must keep project-local extensions out while user/CLI stay",
  );
}

// ---------------------------------------------------------------------------

async function main() {
  buildFixture();
  const modules = [RESOURCE_LOADER, SETTINGS_MANAGER, PACKAGE_MANAGER];
  const graph = createGraph(root, modules, bindings);

  // Sanity: the fixture must contain what the assertions rely on.
  assert.ok(existsSync(projectExtension), "fixture project extension must exist");
  assert.ok(existsSync(userExtension), "fixture user extension must exist");

  const recorder = createLoadRecorder();
  bindings.loadExtensionsCached = recorder.loadExtensionsCached;

  try {
    await scenarioPreviousTrusted(graph, recorder);
    recorder.calls.length = 0;
    await scenarioReloadResolvesTrust(graph, recorder);
    recorder.calls.length = 0;
    await scenarioReloadDeniesTrust(graph, recorder);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }

  console.log("extension-trust/learn regression: all assertions passed");
}

await main();
