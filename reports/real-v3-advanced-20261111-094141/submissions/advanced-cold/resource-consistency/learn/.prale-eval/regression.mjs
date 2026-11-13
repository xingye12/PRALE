/**
 * Regression coverage for: "Untrusted startup leaks project configuration".
 *
 * The incident: an already-trusted process bootstraps a fresh project and sees
 * project resources before consent, and an explicit `--no-approve` (false)
 * override is silently dropped.
 *
 * The script links the real production modules that form the boundary:
 *   - packages/coding-agent/src/core/settings-manager.ts   (trust-gated settings)
 *   - packages/coding-agent/src/core/resource-loader.ts    (bootstrap + reload)
 *   - packages/coding-agent/src/core/project-trust.ts       (trust resolution)
 *
 * Everything outside those modules (package manager, extension loader, skills,
 * prompts, themes, trust store, prompt UI) is a boundary fake, so the assertions
 * observe behavior that crosses module boundaries instead of private helpers.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { createGraph, loadModule } from "./subject.mjs";

const root = path.dirname(import.meta.dirname);
const CORE = "packages/coding-agent/src/core";
const SETTINGS_MODULE = `${CORE}/settings-manager.ts`;
const LOADER_MODULE = `${CORE}/resource-loader.ts`;
const TRUST_MODULE = `${CORE}/project-trust.ts`;

// Local project layout used by the scenarios. It lives inside `.prale-eval/`,
// is rebuilt before the run and removed afterwards. The extension files are
// placeholders: the package manager / extension loader are boundary fakes, so
// which resources a trust state exposes is decided by the fake, not by content.
const FIXTURE_DIR = path.join(root, ".prale-eval", "fixture");
const PROJECT = {
	cwd: path.join(FIXTURE_DIR, "project"),
	agentDir: path.join(FIXTURE_DIR, "agent"),
};
const GLOBAL_EXTENSION = path.join(PROJECT.agentDir, "extensions", "global-ext.ts");
const PROJECT_EXTENSION = path.join(PROJECT.cwd, ".pi", "extensions", "project-ext.ts");
const CLI_EXTENSION = path.join(PROJECT.cwd, "cli-ext.ts");

function setupFixture() {
	rmSync(FIXTURE_DIR, { recursive: true, force: true });
	for (const extensionPath of [GLOBAL_EXTENSION, PROJECT_EXTENSION, CLI_EXTENSION]) {
		mkdirSync(path.dirname(extensionPath), { recursive: true });
		writeFileSync(extensionPath, "export default function boundaryFixture() {}\n");
	}
}

function cleanupFixture() {
	rmSync(FIXTURE_DIR, { recursive: true, force: true });
}

/**
 * Boundary bindings shared by every graph. Named imports are replaced by these
 * values; only the three production modules above execute for real.
 */
function boundaryBindings() {
	return {
		// Default imports (`chalk`, `proper-lockfile`) share the single "default" slot.
		default: {
			lockSync: () => () => {},
			yellow: (value) => String(value),
			red: (value) => String(value),
			dim: (value) => String(value),
		},
		CONFIG_DIR_NAME: ".pi",
		APP_NAME: "pi",
		getAgentDir: () => PROJECT.agentDir,
		normalizePath: (input) => input,
		resolvePath: (input, baseDir = root) => (path.isAbsolute(input) ? path.resolve(input) : path.resolve(baseDir, input)),
		canonicalizePath: (input) => input,
		isLocalPath: () => true,
		stripBom: (value) => value,
		DEFAULT_HTTP_IDLE_TIMEOUT_MS: 30_000,
		parseHttpIdleTimeoutMs: (value) => (typeof value === "number" ? value : undefined),
		DEFAULT_MAX_AGENT_RETRY_DELAY_MS: 60_000,
		randomUUID: () => "00000000-0000-4000-8000-000000000000",
		createEventBus: () => ({ emit() {}, on: () => () => {} }),
		resetTimings: () => {},
		loadThemeFromPath: (filePath) => ({ name: "boundary-theme", sourcePath: filePath }),
		loadPromptTemplates: () => ({ templates: [], diagnostics: [] }),
		loadSkills: () => ({ skills: [], diagnostics: [] }),
		createSourceInfo: (filePath, metadata) => ({ path: filePath, ...metadata }),
		findGitPaths: () => undefined,
		clearExtensionCache: () => {},
		createExtensionRuntime: () => ({ hooks: new Map() }),
		loadExtensionFromFactory: async () => {
			throw new Error("inline extension factories are not part of this scenario");
		},
		loadExtensionsCached: async (extensionPaths) => ({
			extensions: extensionPaths.map((extensionPath) => ({
				path: extensionPath,
				resolvedPath: extensionPath,
				commands: new Map(),
				tools: new Map(),
				flags: new Map(),
			})),
			errors: [],
			warnings: [],
			runtime: { hooks: new Map() },
		}),
		emitProjectTrustEvent: async () => ({ result: undefined, errors: [] }),
		getProjectTrustOptions: () => [
			{ label: "Trust", trusted: true, updates: [], savedPath: PROJECT.cwd },
			{ label: "Do not trust", trusted: false, updates: [], savedPath: PROJECT.cwd },
		],
		hasTrustRequiringProjectResources: () => true,
	};
}

/** Minimal SettingsStorage fake: the trust gate is the subject, not file I/O. */
function fakeSettingsStorage(globalSettings, projectSettings) {
	const contents = new Map([
		["global", JSON.stringify(globalSettings)],
		["project", JSON.stringify(projectSettings)],
	]);
	return {
		read(scope) {
			const value = contents.get(scope);
			return value === undefined ? {} : JSON.parse(value);
		},
		write(scope, settings) {
			contents.set(scope, JSON.stringify(settings));
		},
		withLock(scope, fn) {
			const next = fn(contents.get(scope));
			if (next !== undefined) contents.set(scope, next);
		},
	};
}

/**
 * Boundary fake for the package manager. Like the real implementation, it only
 * surfaces `.pi` project resources while the settings manager reports the
 * project as trusted; user/global and temporary CLI resources always appear.
 */
function makeFakePackageManager(registry) {
	class FakePackageManager {
		constructor(options) {
			this.settingsManager = options.settingsManager;
			registry.packageManagers.push(options);
		}

		async resolve() {
			const projectTrusted = this.settingsManager.isProjectTrusted();
			registry.resolveTrustStates.push(projectTrusted);
			return {
				extensions: [
					...(projectTrusted
						? [
								{
									path: PROJECT_EXTENSION,
									enabled: true,
									metadata: {
										source: "auto",
										scope: "project",
										origin: "top-level",
										baseDir: PROJECT.cwd,
									},
								},
							]
						: []),
					{
						path: GLOBAL_EXTENSION,
						enabled: true,
						metadata: { source: "auto", scope: "user", origin: "top-level", baseDir: PROJECT.agentDir },
					},
				],
				skills: [],
				prompts: [],
				themes: [],
			};
		}

		async resolveExtensionSources(extensionPaths) {
			// Temporary CLI extensions are never trust-gated.
			return {
				extensions: extensionPaths.map((extensionPath) => ({
					path: extensionPath,
					enabled: true,
					metadata: { source: "cli", scope: "temporary", origin: "top-level" },
				})),
				skills: [],
				prompts: [],
				themes: [],
			};
		}
	}
	return FakePackageManager;
}

function freshRegistry() {
	return { packageManagers: [], resolveTrustStates: [] };
}

const GLOBAL_SETTINGS = {
	theme: "global-theme",
	compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 },
};
const PROJECT_SETTINGS = {
	theme: "project-theme",
	compaction: { reserveTokens: 12 },
};

async function graphForLoader(registry) {
	const graph = createGraph(root, [LOADER_MODULE, SETTINGS_MODULE, TRUST_MODULE], {
		...boundaryBindings(),
		DefaultPackageManager: makeFakePackageManager(registry),
	});
	return {
		loaderModule: await graph.module(LOADER_MODULE),
		settingsModule: await graph.module(SETTINGS_MODULE),
		trustModule: await graph.module(TRUST_MODULE),
	};
}

function makeLoader(modules, storage, registry) {
	const settingsManager = modules.settingsModule.SettingsManager.fromStorage(storage, { projectTrusted: false });
	const loader = new modules.loaderModule.DefaultResourceLoader({
		cwd: PROJECT.cwd,
		agentDir: PROJECT.agentDir,
		settingsManager,
		eventBus: { emit() {}, on: () => () => {} },
		additionalExtensionPaths: [CLI_EXTENSION],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	return { loader, settingsManager, registry };
}

// The linked modules run in a separate VM realm, so their arrays/objects have a
// different prototype. Copy primitives into realm-neutral host values before
// comparing them with assert/strict.
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const extensionPathsOf = (result) => Array.from(result.extensions, (extension) => extension.path);

// ---------------------------------------------------------------------------
// 1. Settings manager: project settings stay behind the trust gate.
// ---------------------------------------------------------------------------
async function testSettingsManagerRespectsTrust() {
	const { SettingsManager } = await loadModule(root, SETTINGS_MODULE, boundaryBindings());

	const storage = fakeSettingsStorage(GLOBAL_SETTINGS, PROJECT_SETTINGS);
	const untrusted = SettingsManager.fromStorage(storage, { projectTrusted: false });

	assert.equal(untrusted.isProjectTrusted(), false, "an untrusted bootstrap manager must report untrusted");
	assert.deepEqual(
		plain(untrusted.getProjectSettings()),
		{},
		"project settings must not be read before consent",
	);
	assert.equal(untrusted.getTheme(), "global-theme", "global settings must still apply before consent");
	assert.deepEqual(
		plain(untrusted.getCompactionSettings()),
		{ enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 },
		"global configuration must be complete before consent",
	);

	// Trusting the project admits project settings on top of the global ones,
	// and nested objects keep inheriting from the global scope.
	untrusted.setProjectTrusted(true);
	assert.equal(untrusted.isProjectTrusted(), true);
	assert.equal(untrusted.getTheme(), "project-theme", "trusted sessions must see project settings");
	assert.deepEqual(
		plain(untrusted.getCompactionSettings()),
		{ enabled: false, reserveTokens: 12, keepRecentTokens: 2000 },
		"nested settings inheritance must survive the trust transition",
	);
	assert.deepEqual(plain(untrusted.getProjectSettings()), PROJECT_SETTINGS);

	// Reload after an external edit keeps the trusted view.
	storage.write("project", { theme: "project-theme-edited", compaction: { reserveTokens: 34 } });
	await untrusted.reload();
	assert.equal(untrusted.getTheme(), "project-theme-edited", "trusted reload must re-read project settings");
	assert.deepEqual(
		plain(untrusted.getCompactionSettings()),
		{ enabled: false, reserveTokens: 34, keepRecentTokens: 2000 },
		"nested inheritance must survive reload",
	);

	// Dropping trust again must evict project settings and keep them out on reload.
	const relocked = SettingsManager.fromStorage(fakeSettingsStorage(GLOBAL_SETTINGS, PROJECT_SETTINGS), {
		projectTrusted: true,
	});
	assert.equal(relocked.getTheme(), "project-theme");
	relocked.setProjectTrusted(false);
	assert.equal(relocked.getTheme(), "global-theme", "untrusting a project must drop project settings");
	await relocked.reload();
	assert.deepEqual(plain(relocked.getProjectSettings()), {}, "an untrusted reload must not read project settings");
	assert.equal(relocked.getTheme(), "global-theme");
}

// ---------------------------------------------------------------------------
// 2. Trust resolution: explicit overrides win without prompting.
// ---------------------------------------------------------------------------
async function testExplicitTrustOverrides() {
	const { resolveProjectTrusted } = await loadModule(root, TRUST_MODULE, boundaryBindings());

	const prompts = [];
	const writes = [];
	const makeContext = () => ({
		hasUI: true,
		ui: {
			select: async (message) => {
				prompts.push(message);
				return "Trust";
			},
		},
	});
	const makeStore = (savedDecision) => ({
		get: () => savedDecision,
		set: (target, decision) => writes.push([target, decision]),
		setMany: (updates) => writes.push([...updates]),
	});

	const trustedWithFalseOverride = await resolveProjectTrusted({
		cwd: PROJECT.cwd,
		trustStore: makeStore(true),
		trustOverride: false,
		defaultProjectTrust: "always",
		projectTrustContext: makeContext(),
	});
	assert.equal(trustedWithFalseOverride, false, "an explicit false override must win over saved trust");
	assert.deepEqual(prompts, [], "an explicit false override must not prompt");
	assert.deepEqual(writes, [], "an explicit false override must not rewrite the trust store");

	const trustedWithTrueOverride = await resolveProjectTrusted({
		cwd: PROJECT.cwd,
		trustStore: makeStore(false),
		trustOverride: true,
		defaultProjectTrust: "never",
		projectTrustContext: makeContext(),
	});
	assert.equal(trustedWithTrueOverride, true, "an explicit true override must win over a saved denial");
	assert.deepEqual(prompts, [], "an explicit true override must not prompt");

	// Without an override the saved decision still decides, without prompting.
	assert.equal(
		await resolveProjectTrusted({
			cwd: PROJECT.cwd,
			trustStore: makeStore(false),
			projectTrustContext: makeContext(),
		}),
		false,
		"a saved denial must be honored",
	);
	assert.equal(
		await resolveProjectTrusted({
			cwd: PROJECT.cwd,
			trustStore: makeStore(true),
			projectTrustContext: makeContext(),
		}),
		true,
		"a saved approval must be honored",
	);
	assert.deepEqual(prompts, [], "saved decisions must not prompt");

	// Unasked project + headless mode stays untrusted.
	assert.equal(
		await resolveProjectTrusted({
			cwd: PROJECT.cwd,
			trustStore: makeStore(null),
			projectTrustContext: { hasUI: false, ui: { select: async () => "Trust" } },
		}),
		false,
		"headless sessions must not trust a project without a decision",
	);
}

// ---------------------------------------------------------------------------
// 3. Resource loader: bootstrap is global-only, trusted reload admits project.
// ---------------------------------------------------------------------------
async function testBootstrapLoadsOnlyGlobalAndCliResources() {
	const registry = freshRegistry();
	const modules = await graphForLoader(registry);
	const storage = fakeSettingsStorage(GLOBAL_SETTINGS, PROJECT_SETTINGS);
	const { loader, settingsManager } = makeLoader(modules, storage, registry);

	const bootstrap = await loader.loadProjectTrustExtensions();

	assert.deepEqual(
		extensionPathsOf(bootstrap),
		[CLI_EXTENSION, GLOBAL_EXTENSION],
		"the pre-consent bootstrap must load only global and temporary CLI extensions",
	);
	assert.equal(
		extensionPathsOf(bootstrap).includes(PROJECT_EXTENSION),
		false,
		"the pre-consent bootstrap must never load project extensions",
	);
	assert.equal(settingsManager.isProjectTrusted(), false, "the bootstrap must leave the project untrusted");
	assert.equal(settingsManager.getTheme(), "global-theme", "the bootstrap must not apply project settings");
	assert.deepEqual(plain(settingsManager.getProjectSettings()), {}, "the bootstrap must not read project settings");
	assert.ok(registry.resolveTrustStates.length > 0);
	assert.ok(
		registry.resolveTrustStates.every((trusted) => trusted === false),
		"the package manager must be consulted while untrusted during bootstrap",
	);
	assert.equal(bootstrap.errors.length, 0, "the pre-consent bootstrap must not report extension errors");
}

async function testTrustedReloadAdmitsProjectResources() {
	const registry = freshRegistry();
	const modules = await graphForLoader(registry);
	const storage = fakeSettingsStorage(GLOBAL_SETTINGS, PROJECT_SETTINGS);
	const { loader, settingsManager } = makeLoader(modules, storage, registry);

	let preTrustPaths;
	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			preTrustPaths = extensionPathsOf(extensionsResult);
			return true;
		},
	});

	assert.deepEqual(
		preTrustPaths,
		[CLI_EXTENSION, GLOBAL_EXTENSION],
		"the trust decision must be made from global and CLI extensions only",
	);
	assert.deepEqual(
		extensionPathsOf(loader.getExtensions()),
		[CLI_EXTENSION, PROJECT_EXTENSION, GLOBAL_EXTENSION],
		"after consent the reload must admit project resources",
	);
	assert.equal(settingsManager.isProjectTrusted(), true);
	assert.equal(settingsManager.getTheme(), "project-theme", "after consent project settings must apply");
	assert.deepEqual(
		plain(settingsManager.getCompactionSettings()),
		{ enabled: false, reserveTokens: 12, keepRecentTokens: 2000 },
		"nested inheritance must be preserved across consent",
	);
	assert.equal(loader.getExtensions().errors.length, 0, "a trusted reload must not report extension errors");
}

async function testFalseOverrideKeepsProjectResourcesOut() {
	const registry = freshRegistry();
	const modules = await graphForLoader(registry);
	const storage = fakeSettingsStorage(GLOBAL_SETTINGS, PROJECT_SETTINGS);
	const { loader, settingsManager } = makeLoader(modules, storage, registry);
	const prompts = [];

	// The real trust resolver decides through the loader's reload boundary,
	// exactly like main.ts wires it, with an explicit CLI false override.
	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) =>
			modules.trustModule.resolveProjectTrusted({
				cwd: PROJECT.cwd,
				trustStore: {
					get: () => true,
					set: () => {
						throw new Error("an explicit override must not persist a decision");
					},
					setMany: () => {
						throw new Error("an explicit override must not persist a decision");
					},
				},
				trustOverride: false,
				defaultProjectTrust: "always",
				extensionsResult,
				projectTrustContext: {
					hasUI: true,
					ui: {
						select: async (message) => {
							prompts.push(message);
							return "Trust";
						},
					},
				},
			}),
	});

	assert.deepEqual(prompts, [], "an explicit false override must not prompt even with a saved approval");
	assert.equal(settingsManager.isProjectTrusted(), false, "an explicit false override must keep the project untrusted");
	assert.deepEqual(
		extensionPathsOf(loader.getExtensions()),
		[CLI_EXTENSION, GLOBAL_EXTENSION],
		"an explicit false override must keep project extensions out, including a saved trust entry",
	);
	assert.equal(settingsManager.getTheme(), "global-theme");
	assert.deepEqual(plain(settingsManager.getProjectSettings()), {});
}

async function testSavedApprovalStillAdmitsProjectResources() {
	const registry = freshRegistry();
	const modules = await graphForLoader(registry);
	const storage = fakeSettingsStorage(GLOBAL_SETTINGS, PROJECT_SETTINGS);
	const { loader, settingsManager } = makeLoader(modules, storage, registry);
	const prompts = [];

	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) =>
			modules.trustModule.resolveProjectTrusted({
				cwd: PROJECT.cwd,
				trustStore: {
					get: () => true,
					set: () => {},
					setMany: () => {},
				},
				defaultProjectTrust: "ask",
				extensionsResult,
				projectTrustContext: {
					hasUI: true,
					ui: {
						select: async (message) => {
							prompts.push(message);
							return "Do not trust";
						},
					},
				},
			}),
	});

	assert.deepEqual(prompts, [], "a saved approval must not prompt again");
	assert.equal(settingsManager.isProjectTrusted(), true);
	assert.deepEqual(
		extensionPathsOf(loader.getExtensions()),
		[CLI_EXTENSION, PROJECT_EXTENSION, GLOBAL_EXTENSION],
		"a saved approval must admit project resources",
	);
}

const scenarios = [
	["settings manager keeps project settings behind the trust gate", testSettingsManagerRespectsTrust],
	["explicit project trust overrides win without prompting", testExplicitTrustOverrides],
	["bootstrap loads only global and CLI resources", testBootstrapLoadsOnlyGlobalAndCliResources],
	["trusted reload admits project resources", testTrustedReloadAdmitsProjectResources],
	["explicit false override keeps project resources out", testFalseOverrideKeepsProjectResourcesOut],
	["saved approval still admits project resources", testSavedApprovalStillAdmitsProjectResources],
];

setupFixture();
try {
	for (const [name, scenario] of scenarios) {
		await scenario();
		console.log(`ok - ${name}`);
	}
} finally {
	cleanupFixture();
}
console.log(`\n${scenarios.length} regression scenarios passed`);
