/**
 * Cross-module regression coverage for project trust:
 *
 *   - core/settings-manager.ts  : setProjectTrusted() must actually switch trust
 *                                 state and reload project settings.
 *   - core/resource-loader.ts   : reload({ resolveProjectTrust }) must bootstrap
 *                                 untrusted, ask the resolver exactly once, then
 *                                 apply the returned decision to settings and to
 *                                 the final resource set.
 *   - core/project-trust.ts     : an extension decision is persisted only when
 *                                 `remember === true`; approvals and denials both
 *                                 work and session-only decisions stay ephemeral.
 *
 * Every graph links the real production modules; only genuine process boundaries
 * (filesystem locations, chalk, proper-lockfile, package/extension discovery and
 * the extension event emitter) are supplied as fakes.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { createGraph } from "./subject.mjs";

const root = process.cwd();
const tmpRoot = path.join(root, ".prale-eval", "tmp");

const SETTINGS_MANAGER = "packages/coding-agent/src/core/settings-manager.ts";
const RESOURCE_LOADER = "packages/coding-agent/src/core/resource-loader.ts";
const PROJECT_TRUST = "packages/coding-agent/src/core/project-trust.ts";
const TRUST_MANAGER = "packages/coding-agent/src/core/trust-manager.ts";

const CONFIG_DIR_NAME = ".pi";

// ---------------------------------------------------------------------------
// Boundary fakes
// ---------------------------------------------------------------------------

/** chalk (resource-loader) and proper-lockfile (settings/trust managers) both
 * arrive as a default import, so one inert object serves both boundaries. */
const sharedDefault = {
	yellow: (value) => String(value),
	red: (value) => String(value),
	dim: (value) => String(value),
	cyan: (value) => String(value),
	green: (value) => String(value),
	lockSync: () => () => {},
	lock: async () => () => {},
};

function fakeResolvePath(value, base) {
	if (typeof value !== "string") return value;
	if (path.isAbsolute(value)) return path.normalize(value);
	return path.resolve(base ?? root, value);
}

function baseBindings(extra = {}) {
	return {
		APP_NAME: "pi",
		CONFIG_DIR_NAME,
		getAgentDir: () => path.join(root, ".prale-eval", "tmp", "agent"),
		resolvePath: fakeResolvePath,
		normalizePath: (value) => value,
		canonicalizePath: (value) => path.resolve(value),
		isLocalPath: () => true,
		stripBom: (value) => value.replace(/^\uFEFF/, ""),
		default: sharedDefault,
		DEFAULT_MAX_AGENT_RETRY_DELAY_MS: 60_000,
		DEFAULT_HTTP_IDLE_TIMEOUT_MS: 60_000,
		parseHttpIdleTimeoutMs: () => undefined,
		createEventBus: () => ({ emit: async () => {}, on: () => () => {} }),
		createExtensionRuntime: () => ({
			pendingProviderRegistrations: [],
			pendingNativeProviderRegistrations: [],
		}),
		clearExtensionCache: () => {},
		loadExtensionFromFactory: async () => {
			throw new Error("inline extension factories are not used in this regression");
		},
		findGitPaths: () => undefined,
		loadPromptTemplates: () => ({ templates: [], diagnostics: [] }),
		loadSkills: () => ({ skills: [], diagnostics: [] }),
		loadThemeFromPath: () => {
			throw new Error("theme loading is not used in this regression");
		},
		createSourceInfo: (resourcePath, metadata) => ({
			path: resourcePath,
			source: metadata.source,
			scope: metadata.scope,
			origin: metadata.origin,
			baseDir: metadata.baseDir,
		}),
		resetTimings: () => {},
		...extra,
	};
}

function freshDir(...segments) {
	const dir = path.join(tmpRoot, ...segments);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeJson(file, value) {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function readJson(file) {
	return JSON.parse(readFileSync(file, "utf-8"));
}

function makeExtension(extensionPath) {
	return {
		path: extensionPath,
		resolvedPath: path.resolve(extensionPath),
		handlers: new Map(),
		tools: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		messageRenderers: new Map(),
	};
}

/** Production values arrive from the VM realm; rebuild plain host arrays and
 * compare cross-realm objects through JSON so assertions stay realm agnostic. */
function extensionPathsOf(extensions) {
	return Array.from(extensions, (extension) => extension.path);
}

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function makeRuntime() {
	return { pendingProviderRegistrations: [], pendingNativeProviderRegistrations: [] };
}

// ---------------------------------------------------------------------------
// 1. settings-manager: switching trust must reload project settings
// ---------------------------------------------------------------------------

async function testSettingsManagerTrustSwitch() {
	const projectDir = freshDir("settings", "project");
	const agentDir = freshDir("settings", "agent");
	writeJson(path.join(agentDir, "settings.json"), { theme: "global-theme" });
	writeJson(path.join(projectDir, CONFIG_DIR_NAME, "settings.json"), { theme: "project-theme", packages: [] });

	const graph = createGraph(root, [SETTINGS_MANAGER], baseBindings());
	const { SettingsManager } = await graph.module(SETTINGS_MANAGER);

	const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

	// Bootstrap: untrusted managers must not read project settings.
	assert.equal(manager.isProjectTrusted(), false);
	assert.equal(manager.getTheme(), "global-theme");
	assert.deepEqual(plain(manager.getProjectSettings()), {});

	// Granting trust for this session must take effect immediately, without
	// requiring a process restart and without touching the global settings file.
	manager.setProjectTrusted(true);
	assert.equal(manager.isProjectTrusted(), true, "setProjectTrusted(true) must update the trust state");
	assert.equal(manager.getTheme(), "project-theme", "trusted project settings must be loaded after the switch");
	assert.deepEqual(plain(manager.getProjectSettings()), { theme: "project-theme", packages: [] });

	// Re-applying the same decision is a no-op that keeps the trusted state.
	manager.setProjectTrusted(true);
	assert.equal(manager.isProjectTrusted(), true);
	assert.equal(manager.getTheme(), "project-theme");

	// Denial must also take effect: project settings are dropped again.
	manager.setProjectTrusted(false);
	assert.equal(manager.isProjectTrusted(), false, "setProjectTrusted(false) must update the trust state");
	assert.equal(manager.getTheme(), "global-theme");
	assert.deepEqual(plain(manager.getProjectSettings()), {});

	// And a later grant still works (state is not stuck).
	manager.setProjectTrusted(true);
	assert.equal(manager.getTheme(), "project-theme");
	await manager.reload();
	assert.equal(manager.getTheme(), "project-theme");

	// The global settings file was never rewritten by trust changes.
	assert.deepEqual(readJson(path.join(agentDir, "settings.json")), { theme: "global-theme" });
}

// ---------------------------------------------------------------------------
// 2. resource-loader: bootstrap untrusted, resolve once, then apply
// ---------------------------------------------------------------------------

async function testResourceLoaderReResolvesAfterBootstrap() {
	const projectDir = freshDir("loader", "project");
	const agentDir = freshDir("loader", "agent");
	writeJson(path.join(agentDir, "settings.json"), { theme: "global-theme" });
	writeJson(path.join(projectDir, CONFIG_DIR_NAME, "settings.json"), { theme: "project-theme" });

	const projectExtension = path.join(projectDir, CONFIG_DIR_NAME, "extensions", "project.ts");
	const userExtension = path.join(agentDir, "extensions", "user.ts");
	mkdirSync(path.dirname(projectExtension), { recursive: true });
	mkdirSync(path.dirname(userExtension), { recursive: true });
	writeFileSync(projectExtension, "export default function () {}\n", "utf-8");
	writeFileSync(userExtension, "export default function () {}\n", "utf-8");

	const loadedBatches = [];

	class FakePackageManager {
		constructor(options) {
			this.settingsManager = options.settingsManager;
		}

		async resolve() {
			const trusted = this.settingsManager.isProjectTrusted();
			const extensions = [];
			if (trusted) {
				extensions.push({
					path: projectExtension,
					enabled: true,
					metadata: { source: "auto", scope: "project", origin: "top-level" },
				});
			}
			extensions.push({
				path: userExtension,
				enabled: true,
				metadata: { source: "auto", scope: "user", origin: "top-level" },
			});
			return { extensions, skills: [], prompts: [], themes: [] };
		}

		async resolveExtensionSources() {
			return { extensions: [], skills: [], prompts: [], themes: [] };
		}
	}

	async function loadExtensionsCached(paths, _cwd, _eventBus, runtime) {
		loadedBatches.push([...paths]);
		return {
			extensions: Array.from(paths, (extensionPath) => makeExtension(extensionPath)),
			errors: [],
			runtime: runtime ?? makeRuntime(),
		};
	}

	const bindings = baseBindings({
		DefaultPackageManager: FakePackageManager,
		loadExtensionsCached,
	});

	const graph = createGraph(root, [RESOURCE_LOADER, SETTINGS_MANAGER], bindings);
	const { DefaultResourceLoader } = await graph.module(RESOURCE_LOADER);
	const { SettingsManager } = await graph.module(SETTINGS_MANAGER);

	const settingsManager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });
	const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir, settingsManager });

	const resolverCalls = [];
	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			resolverCalls.push({
				paths: extensionPathsOf(extensionsResult.extensions),
				trustedDuringBootstrap: settingsManager.isProjectTrusted(),
			});
			return true;
		},
	});

	// Exactly one resolution, driven by the untrusted bootstrap set.
	assert.equal(resolverCalls.length, 1, "the trust resolver must run exactly once per reload");
	assert.deepEqual(
		resolverCalls[0].paths,
		[userExtension],
		"the resolver must see only the extensions loaded during the untrusted bootstrap",
	);
	assert.equal(
		resolverCalls[0].trustedDuringBootstrap,
		false,
		"the bootstrap pass must stay untrusted while the resolver runs",
	);

	// The decision the resolver returned is the session's trust state.
	assert.equal(settingsManager.isProjectTrusted(), true, "the resolver decision must be applied to settings");
	assert.equal(settingsManager.getTheme(), "project-theme", "project settings must reload for a trusted session");

	// ... and the final resource set reflects that trust decision.
	const finalPaths = extensionPathsOf(loader.getExtensions().extensions);
	assert.deepEqual(finalPaths, [projectExtension, userExtension], "trusted sessions must load project extensions");
	assert.deepEqual(
		loadedBatches[0],
		[userExtension],
		"the untrusted bootstrap must not load project extensions",
	);
	assert.deepEqual(
		loadedBatches,
		[[userExtension], [projectExtension]],
		"bootstrap extensions must be reused instead of loaded twice",
	);

	// A plain reload without a resolver keeps the current trust state and does
	// not ask anybody again.
	await loader.reload();
	assert.equal(resolverCalls.length, 1, "reload without a resolver must not re-run trust resolution");
	assert.equal(settingsManager.isProjectTrusted(), true);
	assert.deepEqual(extensionPathsOf(loader.getExtensions().extensions), [projectExtension, userExtension]);

	// Denial must be honoured just as well: no project settings, no project
	// extensions, and still exactly one resolution.
	const denialProjectDir = freshDir("loader", "denied-project");
	const denialAgentDir = freshDir("loader", "denied-agent");
	writeJson(path.join(denialAgentDir, "settings.json"), { theme: "global-theme" });
	writeJson(path.join(denialProjectDir, CONFIG_DIR_NAME, "settings.json"), { theme: "project-theme" });
	const deniedProjectExtension = path.join(denialProjectDir, CONFIG_DIR_NAME, "extensions", "project.ts");
	const deniedUserExtension = path.join(denialAgentDir, "extensions", "user.ts");
	mkdirSync(path.dirname(deniedProjectExtension), { recursive: true });
	mkdirSync(path.dirname(deniedUserExtension), { recursive: true });
	writeFileSync(deniedProjectExtension, "export default function () {}\n", "utf-8");
	writeFileSync(deniedUserExtension, "export default function () {}\n", "utf-8");

	class DeniedPackageManager extends FakePackageManager {
		async resolve() {
			const trusted = this.settingsManager.isProjectTrusted();
			const extensions = [];
			if (trusted) {
				extensions.push({
					path: deniedProjectExtension,
					enabled: true,
					metadata: { source: "auto", scope: "project", origin: "top-level" },
				});
			}
			extensions.push({
				path: deniedUserExtension,
				enabled: true,
				metadata: { source: "auto", scope: "user", origin: "top-level" },
			});
			return { extensions, skills: [], prompts: [], themes: [] };
		}
	}

	const denialGraph = createGraph(
		root,
		[RESOURCE_LOADER, SETTINGS_MANAGER],
		baseBindings({ DefaultPackageManager: DeniedPackageManager, loadExtensionsCached }),
	);
	const denialLoaderModule = await denialGraph.module(RESOURCE_LOADER);
	const denialSettingsModule = await denialGraph.module(SETTINGS_MANAGER);
	const denialSettings = denialSettingsModule.SettingsManager.create(denialProjectDir, denialAgentDir, {
		projectTrusted: false,
	});
	const denialLoader = new denialLoaderModule.DefaultResourceLoader({
		cwd: denialProjectDir,
		agentDir: denialAgentDir,
		settingsManager: denialSettings,
	});

	const denialCalls = [];
	await denialLoader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			denialCalls.push(extensionPathsOf(extensionsResult.extensions));
			return false;
		},
	});

	assert.equal(denialCalls.length, 1, "a denial must still be resolved exactly once");
	assert.equal(denialSettings.isProjectTrusted(), false, "a denial must keep the session untrusted");
	assert.equal(denialSettings.getTheme(), "global-theme", "denied sessions must not load project settings");
	assert.deepEqual(
		extensionPathsOf(denialLoader.getExtensions().extensions),
		[deniedUserExtension],
		"denied sessions must not load project extensions",
	);
}

// ---------------------------------------------------------------------------
// 3. project-trust: only explicit `remember: true` persists a decision
// ---------------------------------------------------------------------------

function trustContext({ hasUI = false, selected = undefined } = {}) {
	return {
		cwd: "",
		mode: "tui",
		hasUI,
		ui: {
			select: async () => selected,
			confirm: async () => false,
			input: async () => undefined,
			notify: () => {},
		},
	};
}

async function testProjectTrustPersistence() {
	const caseDir = freshDir("trust");
	const projectDir = path.join(caseDir, "project");
	mkdirSync(path.join(projectDir, CONFIG_DIR_NAME), { recursive: true });
	writeJson(path.join(projectDir, CONFIG_DIR_NAME, "settings.json"), { theme: "project-theme" });
	const agentDir = path.join(caseDir, "agent");
	const homeDir = path.join(caseDir, "home");
	mkdirSync(homeDir, { recursive: true });
	const globalSettingsPath = path.join(agentDir, "settings.json");
	writeJson(globalSettingsPath, { theme: "global-theme", defaultProjectTrust: "ask" });
	const trustFilePath = path.join(agentDir, "trust.json");

	let scriptedResult;
	const graph = createGraph(
		root,
		[PROJECT_TRUST, TRUST_MANAGER],
		baseBindings({
			emitProjectTrustEvent: async () => ({ result: scriptedResult, errors: [] }),
		}),
		{ [TRUST_MANAGER]: { "node:os": { homedir: () => homeDir } } },
	);
	const { resolveProjectTrusted } = await graph.module(PROJECT_TRUST);
	const { ProjectTrustStore } = await graph.module(TRUST_MANAGER);

	const extensionsResult = { extensions: [], errors: [], runtime: makeRuntime() };

	const resolveWithExtension = async (result) => {
		const trustStore = new ProjectTrustStore(agentDir);
		scriptedResult = result;
		const trusted = await resolveProjectTrusted({
			cwd: projectDir,
			trustStore,
			defaultProjectTrust: "ask",
			extensionsResult,
			projectTrustContext: trustContext({ hasUI: true, selected: "Trust" }),
		});
		return { trusted, persisted: trustStore.get(projectDir) };
	};

	// The scenario needs project resources, otherwise trust is never asked.
	const { hasTrustRequiringProjectResources } = await graph.module(TRUST_MANAGER);
	assert.equal(hasTrustRequiringProjectResources(projectDir), true, "fixture must require project trust");

	// 1. Session-only approval: granted, nothing persisted.
	assert.deepEqual(await resolveWithExtension({ trusted: "yes" }), { trusted: true, persisted: null });
	assert.equal(existsSync(trustFilePath), false, "session-only approval must not create a trust store");

	// 2. Explicit `remember: false` approval is still session-only.
	assert.deepEqual(await resolveWithExtension({ trusted: "yes", remember: false }), {
		trusted: true,
		persisted: null,
	});
	assert.equal(existsSync(trustFilePath), false, "remember: false must not persist an approval");

	// 3. Explicit `remember: false` denial is session-only too.
	assert.deepEqual(await resolveWithExtension({ trusted: "no", remember: false }), {
		trusted: false,
		persisted: null,
	});
	assert.equal(existsSync(trustFilePath), false, "remember: false must not persist a denial");

	// 4. Session-only denial.
	assert.deepEqual(await resolveWithExtension({ trusted: "no" }), { trusted: false, persisted: null });
	assert.equal(existsSync(trustFilePath), false);

	// 5. Explicit `remember: true` approval persists consent.
	assert.deepEqual(await resolveWithExtension({ trusted: "yes", remember: true }), {
		trusted: true,
		persisted: true,
	});
	assert.deepEqual(readJson(trustFilePath), { [path.resolve(projectDir)]: true });

	// A later process (no extension decision) uses the saved consent.
	const savedStore = new ProjectTrustStore(agentDir);
	scriptedResult = undefined;
	assert.equal(
		await resolveProjectTrusted({
			cwd: projectDir,
			trustStore: savedStore,
			defaultProjectTrust: "never",
			projectTrustContext: trustContext({ hasUI: false }),
		}),
		true,
		"a remembered approval must be reused",
	);

	// 6. Explicit `remember: true` denial persists denial.
	const denyDir = path.join(caseDir, "denied-project");
	mkdirSync(path.join(denyDir, CONFIG_DIR_NAME), { recursive: true });
	writeJson(path.join(denyDir, CONFIG_DIR_NAME, "settings.json"), { theme: "project-theme" });
	const denyStore = new ProjectTrustStore(agentDir);
	scriptedResult = { trusted: "no", remember: true };
	assert.equal(
		await resolveProjectTrusted({
			cwd: denyDir,
			trustStore: denyStore,
			defaultProjectTrust: "always",
			extensionsResult,
			projectTrustContext: trustContext({ hasUI: true, selected: "Do not trust" }),
		}),
		false,
		"a remembered denial must be honoured",
	);
	assert.equal(denyStore.get(denyDir), false, "remember: true must persist a denial");
	assert.equal(readJson(trustFilePath)[path.resolve(denyDir)], false);

	// 7. Built-in prompt: session-only choices never write the trust store.
	const promptDir = path.join(caseDir, "prompt-project");
	mkdirSync(path.join(promptDir, CONFIG_DIR_NAME), { recursive: true });
	writeJson(path.join(promptDir, CONFIG_DIR_NAME, "settings.json"), { theme: "project-theme" });
	const promptStore = new ProjectTrustStore(agentDir);
	scriptedResult = undefined;

	assert.equal(
		await resolveProjectTrusted({
			cwd: promptDir,
			trustStore: promptStore,
			defaultProjectTrust: "ask",
			projectTrustContext: trustContext({ hasUI: true, selected: "Trust (this session only)" }),
		}),
		true,
		"the session-only prompt option must grant access",
	);
	assert.equal(promptStore.get(promptDir), null, "the session-only prompt option must not persist consent");

	assert.equal(
		await resolveProjectTrusted({
			cwd: promptDir,
			trustStore: promptStore,
			defaultProjectTrust: "ask",
			projectTrustContext: trustContext({ hasUI: true, selected: "Do not trust (this session only)" }),
		}),
		false,
		"the session-only denial option must deny access",
	);
	assert.equal(promptStore.get(promptDir), null, "the session-only denial option must not persist denial");

	// 8. Built-in prompt: explicit choices are persisted, denial included.
	const deniedPromptDir = path.join(caseDir, "denied-prompt-project");
	mkdirSync(path.join(deniedPromptDir, CONFIG_DIR_NAME), { recursive: true });
	writeJson(path.join(deniedPromptDir, CONFIG_DIR_NAME, "settings.json"), { theme: "project-theme" });
	const deniedPromptStore = new ProjectTrustStore(agentDir);
	assert.equal(
		await resolveProjectTrusted({
			cwd: deniedPromptDir,
			trustStore: deniedPromptStore,
			defaultProjectTrust: "ask",
			projectTrustContext: trustContext({ hasUI: true, selected: "Do not trust" }),
		}),
		false,
	);
	assert.equal(deniedPromptStore.get(deniedPromptDir), false, "an explicit built-in denial must be persisted");

	const trustedPromptDir = path.join(caseDir, "trusted-prompt-project");
	mkdirSync(path.join(trustedPromptDir, CONFIG_DIR_NAME), { recursive: true });
	writeJson(path.join(trustedPromptDir, CONFIG_DIR_NAME, "settings.json"), { theme: "project-theme" });
	const trustedPromptStore = new ProjectTrustStore(agentDir);
	assert.equal(
		await resolveProjectTrusted({
			cwd: trustedPromptDir,
			trustStore: trustedPromptStore,
			defaultProjectTrust: "ask",
			projectTrustContext: trustContext({ hasUI: true, selected: "Trust" }),
		}),
		true,
	);
	assert.equal(trustedPromptStore.get(trustedPromptDir), true, "an explicit built-in approval must be persisted");

	// The saved decision is then reused without prompting again.
	assert.equal(
		await resolveProjectTrusted({
			cwd: trustedPromptDir,
			trustStore: new ProjectTrustStore(agentDir),
			defaultProjectTrust: "never",
			projectTrustContext: trustContext({ hasUI: false }),
		}),
		true,
		"saved approvals must survive into the next session",
	);
	assert.equal(
		await resolveProjectTrusted({
			cwd: deniedPromptDir,
			trustStore: new ProjectTrustStore(agentDir),
			defaultProjectTrust: "always",
			projectTrustContext: trustContext({ hasUI: false }),
		}),
		false,
		"saved denials must survive into the next session",
	);

	// 9. Cancelling the prompt denies access without persisting anything.
	const cancelDir = path.join(caseDir, "cancel-project");
	mkdirSync(path.join(cancelDir, CONFIG_DIR_NAME), { recursive: true });
	writeJson(path.join(cancelDir, CONFIG_DIR_NAME, "settings.json"), { theme: "project-theme" });
	const cancelStore = new ProjectTrustStore(agentDir);
	assert.equal(
		await resolveProjectTrusted({
			cwd: cancelDir,
			trustStore: cancelStore,
			defaultProjectTrust: "ask",
			projectTrustContext: trustContext({ hasUI: true, selected: undefined }),
		}),
		false,
	);
	assert.equal(cancelStore.get(cancelDir), null);

	// 10. No UI + no saved decision + "ask" denies without persisting.
	assert.equal(
		await resolveProjectTrusted({
			cwd: cancelDir,
			trustStore: cancelStore,
			defaultProjectTrust: "ask",
			projectTrustContext: trustContext({ hasUI: false }),
		}),
		false,
	);
	assert.equal(cancelStore.get(cancelDir), null);

	// 11. --approve / --no-approve style overrides win and persist nothing.
	const overrideStore = new ProjectTrustStore(agentDir);
	assert.equal(
		await resolveProjectTrusted({
			cwd: cancelDir,
			trustStore: overrideStore,
			trustOverride: false,
			defaultProjectTrust: "always",
			projectTrustContext: trustContext({ hasUI: true, selected: "Trust" }),
		}),
		false,
		"a false override must deny access even with defaultProjectTrust=always",
	);
	assert.equal(
		await resolveProjectTrusted({
			cwd: cancelDir,
			trustStore: overrideStore,
			trustOverride: true,
			defaultProjectTrust: "never",
			projectTrustContext: trustContext({ hasUI: false }),
		}),
		true,
		"a true override must grant access even with defaultProjectTrust=never",
	);
	assert.equal(overrideStore.get(cancelDir), null, "overrides must not persist a decision");

	// 12. Projects without trust-requiring resources are always usable.
	const bareDir = path.join(caseDir, "bare-project");
	mkdirSync(bareDir, { recursive: true });
	assert.equal(hasTrustRequiringProjectResources(bareDir), false);
	const bareStore = new ProjectTrustStore(agentDir);
	assert.equal(
		await resolveProjectTrusted({
			cwd: bareDir,
			trustStore: bareStore,
			defaultProjectTrust: "never",
			projectTrustContext: trustContext({ hasUI: false }),
		}),
		true,
		"projects without protected resources must not be gated",
	);
	assert.equal(bareStore.get(bareDir), null);

	// 13. Global configuration was never mutated by any trust decision.
	assert.deepEqual(readJson(globalSettingsPath), { theme: "global-theme", defaultProjectTrust: "ask" });
	assert.equal(existsSync(path.join(caseDir, "agent", CONFIG_DIR_NAME)), false);
	assert.equal(existsSync(path.join(projectDir, CONFIG_DIR_NAME, "trust.json")), false);
}

// ---------------------------------------------------------------------------

async function main() {
	rmSync(tmpRoot, { recursive: true, force: true });
	mkdirSync(tmpRoot, { recursive: true });
	try {
		await testSettingsManagerTrustSwitch();
		await testResourceLoaderReResolvesAfterBootstrap();
		await testProjectTrustPersistence();
	} finally {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
	console.log("project trust regression checks passed");
}

await main();
