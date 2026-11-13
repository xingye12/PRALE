/**
 * Regression: an explicit project-trust decision (true AND false) must be
 * applied to the settings manager after the bootstrap (untrusted) extension
 * pass, settings must be reloaded before the final resource resolution, and
 * the bootstrap pass itself must keep project-local extensions excluded.
 *
 * Exercises the real DefaultResourceLoader.reload() + the real SettingsManager
 * (in-memory storage) from packages/coding-agent/src/core.
 *
 * Run: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import { createGraph } from "./subject.mjs";

const root = path.resolve(import.meta.dirname, "..");

const RESOURCE_LOADER = "packages/coding-agent/src/core/resource-loader.ts";
const SETTINGS_MANAGER = "packages/coding-agent/src/core/settings-manager.ts";

const cwd = path.join(root, ".prale-eval", "tmp", "project");
const agentDir = path.join(root, ".prale-eval", "tmp", "agent");
const userExtensionPath = path.join(agentDir, "extensions", "user.ts");
const projectExtensionPath = path.join(cwd, ".pi", "extensions", "project.ts");
const PROJECT_THEME = "project-theme";
const INITIAL_GLOBAL_THEME = "initial-global-theme";
const UPDATED_GLOBAL_THEME = "updated-global-theme";

/** In-memory SettingsStorage so the real SettingsManager reads project settings on reload. */
class FakeSettingsStorage {
	constructor() {
		this.data = new Map();
	}
	withLock(scope, fn) {
		const current = this.data.get(scope);
		const next = fn(current);
		if (next !== undefined) this.data.set(scope, next);
	}
}

function makeExtension(extensionPath) {
	return {
		path: extensionPath,
		resolvedPath: extensionPath,
		sourceInfo: { path: extensionPath, source: "local", scope: "user", origin: "top-level" },
		tools: new Map(),
		flags: new Map(),
		commands: new Map(),
		hidden: false,
	};
}

/**
 * Builds boundary fakes around the real loader. The fake package manager models
 * the trust boundary: project-local extensions are only resolved when the
 * settings manager currently considers the project trusted, so the observed
 * extension set reveals the trust state seen at each resolution.
 */
function createFakes() {
	const state = { resolveCalls: [], loadCalls: [] };

	class FakePackageManager {
		constructor(options) {
			this.settingsManager = options.settingsManager;
		}
		async resolve() {
			const trusted = this.settingsManager.isProjectTrusted();
			state.resolveCalls.push({
				trusted,
				projectSettings: { ...this.settingsManager.getProjectSettings() },
				globalSettings: { ...this.settingsManager.getGlobalSettings() },
			});
			const extensions = trusted ? [projectExtensionPath, userExtensionPath] : [userExtensionPath];
			return {
				extensions: extensions.map((extensionPath) => ({
					path: extensionPath,
					enabled: true,
					metadata: {
						source: "local",
						scope: extensionPath === userExtensionPath ? "user" : "project",
						origin: "top-level",
					},
				})),
				skills: [],
				prompts: [],
				themes: [],
			};
		}
		async resolveExtensionSources() {
			return { extensions: [], skills: [], prompts: [], themes: [] };
		}
	}

	const bindings = {
		// DefaultResourceLoader boundaries
		DefaultPackageManager: FakePackageManager,
		clearExtensionCache: () => {},
		createExtensionRuntime: () => ({}),
		loadExtensionFromFactory: async () => makeExtension("<inline:test>"),
		loadExtensionsCached: async (extensionPaths, _cwd, _eventBus, runtime) => {
			state.loadCalls.push([...extensionPaths]);
			return {
				extensions: extensionPaths.map(makeExtension),
				errors: [],
				warnings: [],
				runtime: runtime ?? {},
			};
		},
		createEventBus: () => ({}),
		findGitPaths: () => undefined,
		loadPromptTemplates: () => ({ templates: [], diagnostics: [] }),
		loadSkills: () => ({ skills: [], diagnostics: [] }),
		loadThemeFromPath: () => {
			throw new Error("no themes expected");
		},
		createSourceInfo: (resourcePath, metadata) => ({ path: resourcePath, ...metadata }),
		resetTimings: () => {},
		// Shared path/text helpers
		CONFIG_DIR_NAME: ".pi",
		getAgentDir: () => agentDir,
		canonicalizePath: (value) => path.resolve(value),
		isLocalPath: (value) => !/^(npm:|git:|github:|https?:|ssh:)/.test(value.trim()),
		normalizePath: (value) => path.resolve(value),
		resolvePath: (value, base) => path.resolve(typeof base === "string" ? base : root, value),
		stripBom: (value) => (value.charCodeAt(0) === 0xfeff ? value.slice(1) : value),
		// SettingsManager boundaries
		DEFAULT_HTTP_IDLE_TIMEOUT_MS: 30_000,
		parseHttpIdleTimeoutMs: () => 30_000,
		DEFAULT_MAX_AGENT_RETRY_DELAY_MS: 60_000,
		lockfile: { lockSync: () => () => {} },
		// Misc
		chalk: Object.assign((value) => String(value), {
			red: (value) => String(value),
			yellow: (value) => String(value),
			dim: (value) => String(value),
			green: (value) => String(value),
		}),
	};

	return { state, bindings };
}

async function runScenario(decision) {
	const storage = new FakeSettingsStorage();
	storage.data.set("global", JSON.stringify({ theme: INITIAL_GLOBAL_THEME }));
	storage.data.set("project", JSON.stringify({ theme: PROJECT_THEME }));

	const { state, bindings } = createFakes();
	const graph = createGraph(root, [RESOURCE_LOADER, SETTINGS_MANAGER], bindings);
	const loaderNamespace = await graph.module(RESOURCE_LOADER);
	const settingsNamespace = await graph.module(SETTINGS_MANAGER);

	const settingsManager = settingsNamespace.SettingsManager.fromStorage(storage, { projectTrusted: false });
	const loader = new loaderNamespace.DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noContextFiles: true,
	});

	const observed = {
		callbackExtensions: undefined,
		callbackTrusted: undefined,
		callbackProjectSettings: undefined,
		callbackGlobalTheme: undefined,
	};

	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			observed.callbackExtensions = Array.from(extensionsResult.extensions, (extension) => extension.path);
			observed.callbackTrusted = settingsManager.isProjectTrusted();
			observed.callbackProjectSettings = { ...settingsManager.getProjectSettings() };
			observed.callbackGlobalTheme = settingsManager.getGlobalSettings().theme;
			// A settings write that lands while the trust prompt runs must be visible to the
			// final resource resolution: only a reload after the decision can pick it up.
			storage.data.set("global", JSON.stringify({ theme: UPDATED_GLOBAL_THEME }));
			return decision;
		},
	});

	return {
		state,
		observed,
		trusted: settingsManager.isProjectTrusted(),
		projectSettings: { ...settingsManager.getProjectSettings() },
		globalSettings: { ...settingsManager.getGlobalSettings() },
		extensions: Array.from(loader.getExtensions().extensions, (extension) => extension.path),
	};
}

const FAILED = [];

function check(message, fn) {
	try {
		fn();
	} catch (error) {
		FAILED.push(`${message}: ${error.message}`);
	}
}

// --- Trusted decision: the explicit "yes" must be honored after bootstrap ---
const trusted = await runScenario(true);

check("bootstrap pass keeps project extensions excluded", () => {
	assert.deepEqual(trusted.observed.callbackExtensions, [userExtensionPath]);
});
check("bootstrap pass runs with an untrusted settings manager", () => {
	assert.equal(trusted.observed.callbackTrusted, false);
});
check("bootstrap pass does not load project settings", () => {
	assert.deepEqual(trusted.observed.callbackProjectSettings, {});
});
check("trusted decision is applied to the settings manager", () => {
	assert.equal(trusted.trusted, true);
});
check("trusted project settings are loaded", () => {
	assert.equal(trusted.projectSettings.theme, PROJECT_THEME);
});
check("settings are reloaded before the final resource resolution", () => {
	assert.equal(trusted.observed.callbackGlobalTheme, INITIAL_GLOBAL_THEME);
	assert.equal(trusted.globalSettings.theme, UPDATED_GLOBAL_THEME);
	const finalResolve = trusted.state.resolveCalls.at(-1);
	assert.equal(finalResolve.trusted, true);
	assert.equal(finalResolve.projectSettings.theme, PROJECT_THEME);
	assert.equal(finalResolve.globalSettings.theme, UPDATED_GLOBAL_THEME);
});
check("project extensions load once the project is trusted", () => {
	assert.deepEqual(trusted.extensions, [projectExtensionPath, userExtensionPath]);
});
check("user extensions are loaded only once across bootstrap and final pass", () => {
	const userLoads = trusted.state.loadCalls.flat().filter((extensionPath) => extensionPath === userExtensionPath);
	assert.equal(userLoads.length, 1);
});

// --- Untrusted decision: the explicit "no" must also be honored ---
const untrusted = await runScenario(false);

check("bootstrap pass keeps project extensions excluded (untrusted)", () => {
	assert.deepEqual(untrusted.observed.callbackExtensions, [userExtensionPath]);
});
check("untrusted decision keeps the settings manager untrusted", () => {
	assert.equal(untrusted.trusted, false);
});
check("untrusted decision keeps project settings out", () => {
	assert.deepEqual(untrusted.projectSettings, {});
	const finalResolve = untrusted.state.resolveCalls.at(-1);
	assert.equal(finalResolve.trusted, false);
	assert.equal(finalResolve.projectSettings.theme, undefined);
});
check("settings are reloaded before final resolution for the untrusted decision", () => {
	assert.equal(untrusted.observed.callbackGlobalTheme, INITIAL_GLOBAL_THEME);
	assert.equal(untrusted.globalSettings.theme, UPDATED_GLOBAL_THEME);
	assert.equal(untrusted.state.resolveCalls.at(-1).globalSettings.theme, UPDATED_GLOBAL_THEME);
});
check("project extensions stay excluded for an untrusted project", () => {
	assert.deepEqual(untrusted.extensions, [userExtensionPath]);
});

if (FAILED.length > 0) {
	assert.fail(`project trust regression failed:\n- ${FAILED.join("\n- ")}`);
}
console.log("project trust regression passed");
