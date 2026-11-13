/**
 * Regression coverage for the "stored denial falls through to an allow-by-default policy"
 * and "accepted reloads lose project configuration" incident.
 *
 * The tests link the real production modules (project trust resolver, settings manager and
 * resource loader) through `.prale-eval/subject.mjs` and only fake the boundaries:
 * filesystem, path helpers, package manager, extension/skill/prompt/theme loaders and the
 * trust store. Every assertion is observable behaviour across one of those boundaries.
 *
 * Run with: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph, loadModule } from "./subject.mjs";

const root = nodePath.resolve(fileURLToPath(new URL("..", import.meta.url)));

const CONFIG_DIR_NAME = ".pi";
const PROJECT_DIR = "/virtual/project";
const AGENT_DIR = "/virtual/agent";

const PROJECT_TRUST_MODULE = "packages/coding-agent/src/core/project-trust.ts";
const SETTINGS_MANAGER_MODULE = "packages/coding-agent/src/core/settings-manager.ts";
const RESOURCE_LOADER_MODULE = "packages/coding-agent/src/core/resource-loader.ts";

// ---------------------------------------------------------------------------
// Shared deterministic boundary fakes
// ---------------------------------------------------------------------------

/** Deterministic, separator independent path resolution (no real filesystem access). */
function fakeResolvePath(input, base, options) {
	let value = String(input);
	if (options?.normalizeUnicodeSpaces) {
		value = value.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	}
	if (options?.trim) {
		value = value.trim();
	}
	return nodePath.posix.resolve(base === undefined ? "/" : String(base), value);
}

function fakeCanonicalizePath(input) {
	return nodePath.posix.resolve("/", String(input));
}

function fakeIsLocalPath(value) {
	return typeof value === "string" && (value.startsWith("/") || value.startsWith(".") || value.startsWith("~"));
}

function fakeStripBom(content) {
	return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function toKey(value) {
	return nodePath.posix.resolve("/", String(value));
}

/** Virtual filesystem limited to the files a scenario declares. */
function createVirtualFs(entries) {
	const files = new Map(Object.entries(entries).map(([file, content]) => [toKey(file), content]));
	return {
		files,
		existsSync: (target) => files.has(toKey(target)),
		readFileSync: (target) => {
			const key = toKey(target);
			if (!files.has(key)) {
				throw new Error(`ENOENT: no such file or directory, open '${key}'`);
			}
			return files.get(key);
		},
		statSync: (target) => ({
			isFile: () => files.has(toKey(target)),
			isDirectory: () => false,
		}),
		readdirSync: () => [],
		mkdirSync: () => undefined,
		writeFileSync: () => undefined,
	};
}

const noop = () => undefined;

/** Boundary bindings shared by the settings manager and resource loader graphs. */
function baseBindings(extra = {}) {
	return {
		// ../config.ts
		CONFIG_DIR_NAME,
		APP_NAME: "pi",
		getAgentDir: () => AGENT_DIR,
		// ../utils/paths.ts
		resolvePath: fakeResolvePath,
		canonicalizePath: fakeCanonicalizePath,
		normalizePath: fakeCanonicalizePath,
		isLocalPath: fakeIsLocalPath,
		// ../utils/text.ts
		stripBom: fakeStripBom,
		// ./http-dispatcher.ts
		DEFAULT_HTTP_IDLE_TIMEOUT_MS: 300000,
		parseHttpIdleTimeoutMs: (value) =>
			value === undefined || value === null || value === "" ? undefined : Number(value),
		// @earendil-works/pi-ai
		DEFAULT_MAX_AGENT_RETRY_DELAY_MS: 60000,
		// proper-lockfile (only used by FileSettingsStorage, which these scenarios avoid)
		lockfile: { lockSync: () => () => undefined },
		...extra,
	};
}

/** Storage double matching SettingsStorage: keeps the last serialized file per scope. */
function createMemoryStorage(global, project) {
	const files = { global, project };
	return {
		files,
		withLock(scope, fn) {
			const next = fn(files[scope]);
			if (next !== undefined) {
				files[scope] = next;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// 1. Project trust resolver: a stored boolean is authoritative
// ---------------------------------------------------------------------------

async function projectTrustScenario() {
	const selectCalls = [];
	const trustReads = [];
	const bindings = baseBindings({
		// ./extensions/runner.ts - no extension answers the project_trust event.
		emitProjectTrustEvent: async () => ({ result: undefined, errors: [] }),
		// ./trust-manager.ts
		hasTrustRequiringProjectResources: () => true,
		getProjectTrustOptions: () => [
			{ label: "Trust", trusted: true, updates: [{ path: PROJECT_DIR, decision: true }] },
			{ label: "Do not trust", trusted: false, updates: [{ path: PROJECT_DIR, decision: false }] },
		],
	});
	const { resolveProjectTrusted } = await loadModule(root, PROJECT_TRUST_MODULE, bindings);

	const stored = (decision) => ({
		get(cwd) {
			trustReads.push(cwd);
			return decision;
		},
		set() {
			throw new Error("unexpected trust write");
		},
	});
	const headless = { hasUI: false };
	const interactive = {
		hasUI: true,
		ui: {
			select: async (_prompt, options) => {
				selectCalls.push(options);
				return "Trust";
			},
		},
	};
	const resolve = (overrides) =>
		resolveProjectTrusted({
			cwd: PROJECT_DIR,
			projectTrustContext: headless,
			...overrides,
		});

	// A stored denial must win over an allow-by-default policy.
	assert.equal(
		await resolve({ trustStore: stored(false), defaultProjectTrust: "always" }),
		false,
		"stored `false` decision must be authoritative instead of falling through to defaultProjectTrust=always",
	);
	// A stored approval must win over a deny-by-default policy (guard against inverting the fix).
	assert.equal(
		await resolve({ trustStore: stored(true), defaultProjectTrust: "never" }),
		true,
		"stored `true` decision must be authoritative instead of falling through to defaultProjectTrust=never",
	);
	// Only a missing decision (null) falls through to the default policy.
	assert.equal(await resolve({ trustStore: stored(null), defaultProjectTrust: "always" }), true);
	assert.equal(await resolve({ trustStore: stored(null), defaultProjectTrust: "never" }), false);
	// A stored denial must never reach the interactive prompt.
	selectCalls.length = 0;
	assert.equal(
		await resolve({ trustStore: stored(false), defaultProjectTrust: "ask", projectTrustContext: interactive }),
		false,
		"stored denial must not prompt the user",
	);
	assert.equal(selectCalls.length, 0, "stored denial must not open the trust prompt");
	// An explicit CLI override still wins over the store.
	assert.equal(await resolve({ trustStore: stored(true), trustOverride: false }), false);
	// The resolver consults the store for the requested cwd.
	assert.equal(trustReads.at(-1), PROJECT_DIR, "trust store must be consulted for the project cwd");

	console.log("ok 1 - project trust resolver treats a stored boolean decision as authoritative");
}

// ---------------------------------------------------------------------------
// 2. Settings manager: project overrides global while trusted, nested defaults survive
// ---------------------------------------------------------------------------

async function loadSettingsManagerGraph() {
	const fs = createVirtualFs({});
	return createGraph(
		root,
		[SETTINGS_MANAGER_MODULE],
		baseBindings(),
		{
			[SETTINGS_MANAGER_MODULE]: {
				existsSync: fs.existsSync,
				mkdirSync: fs.mkdirSync,
				readFileSync: fs.readFileSync,
				writeFileSync: fs.writeFileSync,
			},
		},
	).module(SETTINGS_MANAGER_MODULE);
}

async function settingsScenario() {
	const { SettingsManager } = await loadSettingsManagerGraph();

	const globalSettings = {
		theme: "global-theme",
		retry: { enabled: true, maxRetries: 5, baseDelayMs: 111 },
		compaction: { reserveTokens: 1024, keepRecentTokens: 2048 },
	};
	const projectSettings = {
		theme: "project-theme",
		retry: { maxRetries: 9 },
	};

	const storage = createMemoryStorage(JSON.stringify(globalSettings), JSON.stringify(projectSettings));
	const manager = SettingsManager.fromStorage(storage, { projectTrusted: true });

	assert.equal(manager.getTheme(), "project-theme", "trusted project value must override the global value");
	assert.equal(manager.getRetrySettings().maxRetries, 9, "trusted project nested value must override the global one");
	assert.equal(
		manager.getRetrySettings().baseDelayMs,
		111,
		"nested global defaults must survive the project/global merge",
	);
	assert.equal(manager.getRetrySettings().enabled, true, "untouched global nested defaults must survive");
	assert.equal(
		manager.getCompactionSettings().keepRecentTokens,
		2048,
		"project settings must not discard unrelated global nested defaults",
	);

	// Overrides applied on top of the merged settings win, without dropping nested defaults.
	manager.applyOverrides({ compaction: { reserveTokens: 42 } });
	assert.equal(manager.getCompactionReserveTokens(), 42, "applyOverrides must override merged settings");
	assert.equal(manager.getCompactionKeepRecentTokens(), 2048, "applyOverrides must keep nested merged defaults");

	// Project configuration only applies while the project is trusted.
	const untrustedStorage = createMemoryStorage(
		JSON.stringify(globalSettings),
		JSON.stringify(projectSettings),
	);
	const untrusted = SettingsManager.fromStorage(untrustedStorage, { projectTrusted: false });
	assert.equal(untrusted.isProjectTrusted(), false);
	assert.equal(untrusted.getTheme(), "global-theme", "untrusted project settings must be ignored");
	assert.equal(untrusted.getRetrySettings().maxRetries, 5, "untrusted project nested values must be ignored");
	assert.equal(untrusted.getRetrySettings().baseDelayMs, 111, "global nested defaults must still apply");

	// An accepted reload re-reads project settings instead of dropping them.
	untrusted.setProjectTrusted(true);
	assert.equal(untrusted.getTheme(), "project-theme", "granting trust must load project settings");
	await untrusted.reload();
	assert.equal(untrusted.isProjectTrusted(), true, "reload must preserve the granted trust");
	assert.equal(untrusted.getTheme(), "project-theme", "an accepted reload must keep project configuration");
	assert.equal(untrusted.getProjectSettings().theme, "project-theme");
	assert.equal(untrusted.getRetrySettings().maxRetries, 9, "reload must re-merge nested project values");
	assert.equal(untrusted.getRetrySettings().baseDelayMs, 111, "reload must keep nested global defaults");

	// Revoking trust clears the project layer again.
	untrusted.setProjectTrusted(false);
	assert.equal(untrusted.getTheme(), "global-theme", "revoking trust must drop the project layer");
	assert.equal(untrusted.getRetrySettings().maxRetries, 5);

	console.log("ok 2 - settings merge keeps trusted project overrides and nested global defaults");
}

// ---------------------------------------------------------------------------
// 3. Resource loader: an approved decision reaches final resource resolution
// ---------------------------------------------------------------------------

const PROJECT_SYSTEM_PROMPT = "project system prompt";
const PROJECT_APPEND_PROMPT = "project append prompt";

const VIRTUAL_FILES = {
	[`${PROJECT_DIR}/${CONFIG_DIR_NAME}/SYSTEM.md`]: PROJECT_SYSTEM_PROMPT,
	[`${PROJECT_DIR}/${CONFIG_DIR_NAME}/APPEND_SYSTEM.md`]: PROJECT_APPEND_PROMPT,
};

function emptyResourceSet() {
	return { extensions: [], skills: [], prompts: [], themes: [] };
}

function createResourceLoaderGraph() {
	const fs = createVirtualFs(VIRTUAL_FILES);
	const loadCalls = { extensionsCached: 0, packageResolve: 0 };

	class FakePackageManager {
		async resolve() {
			loadCalls.packageResolve += 1;
			return emptyResourceSet();
		}

		async resolveExtensionSources() {
			return emptyResourceSet();
		}
	}

	const bindings = baseBindings({
		// ./event-bus.ts
		createEventBus: () => ({ emit: noop, on: noop }),
		// ./extensions/loader.ts
		clearExtensionCache: noop,
		createExtensionRuntime: () => ({ tools: new Map(), commands: new Map() }),
		loadExtensionFromFactory: async () => ({}),
		loadExtensionsCached: async (...args) => {
			loadCalls.extensionsCached += 1;
			const runtime = args.find((arg) => arg && typeof arg === "object" && !Array.isArray(arg));
			return { extensions: [], errors: [], runtime: runtime ?? { tools: new Map(), commands: new Map() } };
		},
		// ./footer-data-provider.ts
		findGitPaths: () => null,
		// ./package-manager.ts
		DefaultPackageManager: FakePackageManager,
		// ./prompt-templates.ts
		loadPromptTemplates: () => ({ templates: [], diagnostics: [] }),
		// ./skills.ts
		loadSkills: () => ({ skills: [], diagnostics: [] }),
		// ./source-info.ts
		createSourceInfo: (path, metadata) => ({ path, ...metadata }),
		// ./timings.ts
		resetTimings: noop,
		// ../modes/interactive/theme/theme.ts
		loadThemeFromPath: () => ({}),
		// chalk
		default: { yellow: (value) => value, red: (value) => value, dim: (value) => value },
	});

	return {
		loadCalls,
		graph: createGraph(
			root,
			[RESOURCE_LOADER_MODULE, SETTINGS_MANAGER_MODULE],
			bindings,
			{
				[RESOURCE_LOADER_MODULE]: {
					existsSync: fs.existsSync,
					readFileSync: fs.readFileSync,
					statSync: fs.statSync,
					readdirSync: fs.readdirSync,
				},
				[SETTINGS_MANAGER_MODULE]: {
					existsSync: fs.existsSync,
					mkdirSync: fs.mkdirSync,
					readFileSync: fs.readFileSync,
					writeFileSync: fs.writeFileSync,
				},
			},
		),
	};
}

async function resourceLoaderScenario() {
	const { graph, loadCalls } = createResourceLoaderGraph();
	const resourceLoaderModule = await graph.module(RESOURCE_LOADER_MODULE);
	const { SettingsManager } = await graph.module(SETTINGS_MANAGER_MODULE);

	// --- approved decision -------------------------------------------------
	// Mirrors startup: the runtime settings manager starts untrusted and the
	// resource loader asks for the trust decision during reload().
	const approvedStorage = createMemoryStorage(
		JSON.stringify({ theme: "global-theme" }),
		JSON.stringify({ theme: "project-theme" }),
	);
	const approvedSettings = SettingsManager.fromStorage(approvedStorage, { projectTrusted: false });
	const approvedLoader = new resourceLoaderModule.DefaultResourceLoader({
		cwd: PROJECT_DIR,
		agentDir: AGENT_DIR,
		settingsManager: approvedSettings,
	});

	let observedDuringBootstrap;
	await approvedLoader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			observedDuringBootstrap = {
				trusted: approvedSettings.isProjectTrusted(),
				theme: approvedSettings.getTheme(),
				preTrustExtensionsIsResult: Array.isArray(extensionsResult?.extensions),
			};
			return true;
		},
	});

	assert.equal(
		observedDuringBootstrap.preTrustExtensionsIsResult,
		true,
		"the pre-trust extension set must be handed to the trust resolver",
	);
	assert.equal(
		observedDuringBootstrap.trusted,
		false,
		"the bootstrap pass must resolve trust without project resources",
	);
	assert.equal(
		observedDuringBootstrap.theme,
		"global-theme",
		"project settings must stay out of the bootstrap pass",
	);
	assert.equal(
		approvedSettings.isProjectTrusted(),
		true,
		"the approved decision must reach the settings manager after reload",
	);
	assert.equal(
		approvedSettings.getTheme(),
		"project-theme",
		"an accepted reload must apply project configuration",
	);
	assert.equal(
		approvedLoader.getSystemPrompt(),
		PROJECT_SYSTEM_PROMPT,
		"the approved decision must reach final resource resolution (project SYSTEM.md)",
	);
	assert.equal(
		approvedLoader.getSystemPromptSource()?.path,
		`${PROJECT_DIR}/${CONFIG_DIR_NAME}/SYSTEM.md`,
		"resolved system prompt must point at the trusted project file",
	);
	assert.equal(
		approvedLoader.getAppendSystemPrompt()[0],
		PROJECT_APPEND_PROMPT,
		"approved trust must resolve project append-system resources",
	);
	assert.ok(loadCalls.packageResolve > 0, "reload must resolve resources through the package manager");

	// --- stored denial -----------------------------------------------------
	const deniedStorage = createMemoryStorage(
		JSON.stringify({ theme: "global-theme" }),
		JSON.stringify({ theme: "project-theme" }),
	);
	const deniedSettings = SettingsManager.fromStorage(deniedStorage, { projectTrusted: false });
	const deniedLoader = new resourceLoaderModule.DefaultResourceLoader({
		cwd: PROJECT_DIR,
		agentDir: AGENT_DIR,
		settingsManager: deniedSettings,
	});

	await deniedLoader.reload({ resolveProjectTrust: async () => false });

	assert.equal(deniedSettings.isProjectTrusted(), false, "a denied decision must stay untrusted after reload");
	assert.equal(deniedSettings.getTheme(), "global-theme", "denied projects must not apply project configuration");
	assert.equal(
		deniedLoader.getSystemPrompt(),
		undefined,
		"denied projects must not resolve project-only system prompt resources",
	);
	assert.equal(deniedLoader.getAppendSystemPrompt().length, 0, "denied projects must not resolve project resources");

	console.log("ok 3 - the resolved trust decision reaches final resource resolution");
}

await projectTrustScenario();
await settingsScenario();
await resourceLoaderScenario();

console.log("regression ok");
