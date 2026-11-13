/**
 * Cross-module regression for project-trust revocation.
 *
 * Loads the real production modules and links them with boundary fakes:
 *   - core/project-trust.ts     (producer: decides trust, prompts, persists)
 *   - core/settings-manager.ts  (consumer: caches global/project settings per trust state)
 *   - core/resource-loader.ts   (consumer: resolves extensions after a trust change)
 *
 * Run with: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph } from "./subject.mjs";

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(evalDir, "..");

const PROJECT_TRUST = "packages/coding-agent/src/core/project-trust.ts";
const SETTINGS_MANAGER = "packages/coding-agent/src/core/settings-manager.ts";
const RESOURCE_LOADER = "packages/coding-agent/src/core/resource-loader.ts";

/** Shared boundary fakes. Values are host functions/objects called from the linked modules. */
const stripBom = (value) => (value.charCodeAt(0) === 0xfeff ? value.slice(1) : value);

function resolvePath(input, baseDir = root, options = {}) {
	let normalized = options.trim ? input.trim() : input;
	if (options.normalizeUnicodeSpaces) {
		normalized = normalized.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	}
	return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(baseDir, normalized);
}

function canonicalizePath(value) {
	try {
		return fs.realpathSync(value);
	} catch {
		return value;
	}
}

function isLocalPath(value) {
	const trimmed = value.trim();
	return !/^(npm|git|github|https?|ssh):/.test(trimmed);
}

/** Callable/chainable stand-in for `chalk` (only used on warning paths) and `proper-lockfile` (write paths). */
const boundaryStub = new Proxy(function boundaryStub() {}, {
	get(_target, property) {
		if (property === "then") return undefined;
		return boundaryStub;
	},
	apply() {
		return "";
	},
});

const sharedBindings = {
	default: boundaryStub,
	CONFIG_DIR_NAME: ".pi",
	stripBom,
	resolvePath,
	canonicalizePath,
	normalizePath: (input, options = {}) => (options.trim ? input.trim() : input),
	getAgentDir: () => path.join(root, ".pi-eval-agent"),
	isLocalPath,
	DEFAULT_MAX_AGENT_RETRY_DELAY_MS: 60_000,
	DEFAULT_HTTP_IDLE_TIMEOUT_MS: 120_000,
	parseHttpIdleTimeoutMs: (value) =>
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined,
};

/* ------------------------------------------------------------------ */
/* 1. core/project-trust.ts: a headless decision must not assume trust  */
/* ------------------------------------------------------------------ */

async function loadProjectTrust(options = {}) {
	const state = {
		hasProtectedResources: options.hasProtectedResources ?? true,
		emitResult: options.emitResult ?? undefined,
		emitErrors: options.emitErrors ?? [],
	};
	const graph = createGraph(root, [PROJECT_TRUST], {
		APP_NAME: "pi",
		CONFIG_DIR_NAME: ".pi",
		emitProjectTrustEvent: async () => {
			state.emitCalls = (state.emitCalls ?? 0) + 1;
			return { result: state.emitResult, errors: state.emitErrors };
		},
		getProjectTrustOptions: (cwd, opts = {}) => {
			const entries = [
				{ label: "Trust", trusted: true, updates: [{ path: cwd, decision: true }], savedPath: cwd },
			];
			if (opts.includeSessionOnly) {
				entries.push({ label: "Trust (this session only)", trusted: true, updates: [] });
			}
			entries.push({ label: "Do not trust", trusted: false, updates: [{ path: cwd, decision: false }], savedPath: cwd });
			return entries;
		},
		hasTrustRequiringProjectResources: () => state.hasProtectedResources,
	});
	const module = await graph.module(PROJECT_TRUST);
	return { module, state };
}

function trustContext({ hasUI, selection } = {}) {
	const calls = { select: [], confirm: 0, input: 0, notify: [] };
	return {
		calls,
		context: {
			cwd: "/work/project",
			mode: hasUI ? "tui" : "print",
			hasUI,
			ui: {
				select: async (title, options) => {
					calls.select.push(options);
					return selection === undefined ? undefined : selection(options);
				},
				confirm: async () => {
					calls.confirm += 1;
					return false;
				},
				input: async () => {
					calls.input += 1;
					return undefined;
				},
				notify: (message) => calls.notify.push(message),
			},
		},
	};
}

function recordingStore(initial = null) {
	const writes = [];
	return {
		writes,
		store: {
			get: () => initial,
			getEntry: () => (initial === null ? null : { path: "/work/project", decision: initial }),
			set: (cwd, decision) => writes.push({ cwd, decision }),
			setMany: (updates) => writes.push(...updates),
		},
	};
}

async function testHeadlessTrustIsDenied() {
	const { module } = await loadProjectTrust();
	const { context, calls } = trustContext({ hasUI: false });
	const { store, writes } = recordingStore(null);

	const trusted = await module.resolveProjectTrusted({
		cwd: "/work/project",
		trustStore: store,
		defaultProjectTrust: "ask",
		projectTrustContext: context,
	});

	assert.equal(trusted, false, "headless ask policy with no stored decision must deny project trust");
	assert.deepEqual(calls.select, [], "a context without UI must never be prompted for trust");
	assert.deepEqual(writes, [], "denying must not silently persist a trust decision");
}

async function testHeadlessDefaultsAndStoredDecisions() {
	const { module, state } = await loadProjectTrust();

	for (const [defaultProjectTrust, expected] of [
		["always", true],
		["never", false],
		["ask", false],
	]) {
		const { context } = trustContext({ hasUI: false });
		const { store } = recordingStore(null);
		assert.equal(
			await module.resolveProjectTrusted({
				cwd: "/work/project",
				trustStore: store,
				defaultProjectTrust,
				projectTrustContext: context,
			}),
			expected,
			`headless defaultProjectTrust=${defaultProjectTrust}`,
		);
	}

	for (const [stored, expected] of [
		[true, true],
		[false, false],
	]) {
		const { context } = trustContext({ hasUI: false });
		const { store } = recordingStore(stored);
		assert.equal(
			await module.resolveProjectTrusted({
				cwd: "/work/project",
				trustStore: store,
				defaultProjectTrust: "ask",
				projectTrustContext: context,
			}),
			expected,
			`stored decision ${stored} must win over the ask policy`,
		);
	}

	// A command-line override still wins, and projects without protected resources stay trusted.
	{
		const { context } = trustContext({ hasUI: false });
		const { store } = recordingStore(null);
		assert.equal(
			await module.resolveProjectTrusted({
				cwd: "/work/project",
				trustStore: store,
				trustOverride: true,
				defaultProjectTrust: "never",
				projectTrustContext: context,
			}),
			true,
			"--approve override must win",
		);
	}

	state.hasProtectedResources = false;
	{
		const { context } = trustContext({ hasUI: false });
		const { store } = recordingStore(null);
		assert.equal(
			await module.resolveProjectTrusted({
				cwd: "/work/project",
				trustStore: store,
				defaultProjectTrust: "ask",
				projectTrustContext: context,
			}),
			true,
			"a project without trust-requiring resources is trusted",
		);
	}
}

async function testInteractiveAndExtensionDecisionsStillWork() {
	const { module } = await loadProjectTrust();

	// Interactive selection is persisted and honored.
	{
		const { context, calls } = trustContext({ hasUI: true, selection: () => "Trust" });
		const { store, writes } = recordingStore(null);
		assert.equal(
			await module.resolveProjectTrusted({
				cwd: "/work/project",
				trustStore: store,
				defaultProjectTrust: "ask",
				projectTrustContext: context,
			}),
			true,
		);
		assert.equal(calls.select.length, 1, "an interactive context is prompted exactly once");
		assert.deepEqual(writes, [{ path: "/work/project", decision: true }], "the selection is saved");
	}

	// Dismissing the prompt denies without persisting.
	{
		const { context } = trustContext({ hasUI: true, selection: () => undefined });
		const { store, writes } = recordingStore(null);
		assert.equal(
			await module.resolveProjectTrusted({
				cwd: "/work/project",
				trustStore: store,
				defaultProjectTrust: "ask",
				projectTrustContext: context,
			}),
			false,
		);
		assert.deepEqual(writes, [], "a dismissed prompt must not persist a decision");
	}

	// A user-level extension can still decide through the project_trust event.
	{
		const { module: extModule } = await loadProjectTrust({
			emitResult: { trusted: "no", remember: true },
		});
		const { context } = trustContext({ hasUI: false });
		const { store, writes } = recordingStore(null);
		assert.equal(
			await extModule.resolveProjectTrusted({
				cwd: "/work/project",
				trustStore: store,
				defaultProjectTrust: "always",
				extensionsResult: { extensions: [], errors: [], runtime: {} },
				projectTrustContext: context,
			}),
			false,
			"an extension decision must win over defaultProjectTrust",
		);
		assert.deepEqual(writes, [{ cwd: "/work/project", decision: false }], "remember=true persists the decision");
	}

	// Extension errors are reported through the diagnostics callback.
	{
		const { module: extModule } = await loadProjectTrust({
			emitErrors: [{ extensionPath: "/home/user/ext.ts", error: "boom" }],
		});
		const messages = [];
		const { context } = trustContext({ hasUI: false });
		const { store } = recordingStore(true);
		assert.equal(
			await extModule.resolveProjectTrusted({
				cwd: "/work/project",
				trustStore: store,
				defaultProjectTrust: "ask",
				extensionsResult: { extensions: [], errors: [], runtime: {} },
				projectTrustContext: context,
				onExtensionError: (message) => messages.push(message),
			}),
			true,
			"a failing project_trust handler falls back to the stored decision",
		);
		assert.deepEqual(messages, ['Extension "/home/user/ext.ts" project_trust error: boom']);
	}
}

/* ------------------------------------------------------------------ */
/* 2. core/settings-manager.ts: revocation drops cached project config */
/* ------------------------------------------------------------------ */

async function loadSettingsManager() {
	const graph = createGraph(root, [SETTINGS_MANAGER], sharedBindings);
	return graph.module(SETTINGS_MANAGER);
}

function seededSettings(module) {
	const storage = new module.InMemorySettingsStorage();
	storage.withLock("global", () =>
		JSON.stringify({
			theme: "global-theme",
			defaultModel: "global-model",
			compaction: { reserveTokens: 111 },
		}),
	);
	storage.withLock("project", () =>
		JSON.stringify({
			theme: "project-theme",
			defaultModel: "project-model",
			extensions: ["./.pi/extensions/project.ts"],
			compaction: { keepRecentTokens: 222 },
		}),
	);
	return module.SettingsManager.fromStorage(storage);
}

async function testRevocationDiscardsProjectSettings() {
	const module = await loadSettingsManager();
	const manager = seededSettings(module);

	assert.equal(manager.isProjectTrusted(), true, "a manager created with trust loads project settings");
	assert.equal(manager.getTheme(), "project-theme");
	assert.deepEqual(plain(manager.getProjectSettings()).extensions, ["./.pi/extensions/project.ts"]);

	manager.setProjectTrusted(false);

	assert.equal(manager.isProjectTrusted(), false);
	assert.deepEqual(plain(manager.getProjectSettings()), {}, "revoking trust must discard cached project configuration");
	assert.equal(manager.getTheme(), "global-theme", "global settings survive revocation");
	assert.equal(manager.getDefaultModel(), "global-model");
	assert.equal(manager.getCompactionReserveTokens(), 111, "global nested settings survive revocation");
	assert.equal(manager.getCompactionKeepRecentTokens(), 20_000, "project nested settings are gone");
	assert.deepEqual(plain(manager.getExtensionPaths()), [], "project extension paths are gone");
	assert.deepEqual(plain(manager.drainErrors()), []);

	// Re-granting trust reloads project configuration from storage.
	manager.setProjectTrusted(true);
	assert.equal(manager.getTheme(), "project-theme");
	assert.equal(manager.getCompactionKeepRecentTokens(), 222);

	// Revoking again, then reloading while untrusted, keeps project config out.
	manager.setProjectTrusted(false);
	await manager.reload();
	assert.equal(manager.isProjectTrusted(), false);
	assert.deepEqual(plain(manager.getProjectSettings()), {});
	assert.equal(manager.getTheme(), "global-theme");
}

/* ------------------------------------------------------------------ */
/* 3. core/resource-loader.ts + core/settings-manager.ts: revocation  */
/*    removes project extensions and keeps global/CLI resources        */
/* ------------------------------------------------------------------ */

async function loadResourceLoader(extensionPaths) {
	const loadedFrom = [];
	const graph = createGraph(
		root,
		[RESOURCE_LOADER, SETTINGS_MANAGER],
		{
			...sharedBindings,
			loadThemeFromPath: (filePath) => ({ name: path.basename(filePath), sourcePath: filePath }),
			createEventBus: () => ({ on: () => () => {}, emit: () => {} }),
			resetTimings: () => {},
			findGitPaths: () => undefined,
			createSourceInfo: (resourcePath, metadata) => ({ path: resourcePath, ...metadata }),
			loadSkills: () => ({ skills: [], diagnostics: [] }),
			loadPromptTemplates: () => ({ templates: [], diagnostics: [] }),
			createExtensionRuntime: () => ({}),
			clearExtensionCache: () => {},
			loadExtensionFromFactory: async () => {
				throw new Error("inline extension factories are not part of this scenario");
			},
			loadExtensionsCached: async (paths, _cwd, _eventBus, runtime) => {
				loadedFrom.push(...paths);
				return {
					extensions: paths.map((extensionPath) => ({
						path: extensionPath,
						resolvedPath: extensionPath,
						commands: new Map(),
						tools: new Map(),
						flags: new Map(),
					})),
					errors: [],
					warnings: [],
					runtime: runtime ?? {},
				};
			},
			DefaultPackageManager: class FakePackageManager {
				constructor(options) {
					this.settingsManager = options.settingsManager;
				}

				async resolve() {
					// Real package resolution gates project resources on the trust state of the
					// settings manager it was constructed with.
					const projectTrusted = this.settingsManager.isProjectTrusted();
					const extensions = [];
					if (projectTrusted) {
						extensions.push({
							path: extensionPaths.project,
							enabled: true,
							metadata: { source: "auto", scope: "project", origin: "top-level" },
						});
					}
					extensions.push({
						path: extensionPaths.global,
						enabled: true,
						metadata: { source: "auto", scope: "user", origin: "top-level" },
					});
					return { extensions, skills: [], prompts: [], themes: [] };
				}

				async resolveExtensionSources(paths) {
					return {
						extensions: paths.map((extensionPath) => ({
							path: extensionPath,
							enabled: true,
							metadata: { source: "cli", scope: "temporary", origin: "top-level" },
						})),
						skills: [],
						prompts: [],
						themes: [],
					};
				}
			},
		},
		{},
		{},
	);
	const modules = {
		resourceLoader: await graph.module(RESOURCE_LOADER),
		settingsManager: await graph.module(SETTINGS_MANAGER),
	};
	return { modules, loadedFrom };
}

/** Copy a value out of the VM realm so strict deep equality compares plain host values. */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function extensionPathsOf(result) {
	return Array.from(result.extensions, (extension) => extension.path).sort();
}

async function testRevocationClearsResolvedResources() {
	const tmpRoot = fs.mkdtempSync(path.join(evalDir, "tmp-revocation-"));
	const cwd = path.join(tmpRoot, "project");
	const agentDir = path.join(tmpRoot, "agent");
	const extensionPaths = {
		project: path.join(cwd, ".pi", "extensions", "project.ts"),
		global: path.join(agentDir, "extensions", "global.ts"),
		cli: path.join(tmpRoot, "cli", "cli.ts"),
	};

	try {
		fs.mkdirSync(path.dirname(extensionPaths.project), { recursive: true });
		fs.mkdirSync(path.dirname(extensionPaths.global), { recursive: true });
		fs.mkdirSync(path.dirname(extensionPaths.cli), { recursive: true });
		fs.writeFileSync(extensionPaths.project, "export default function () {}\n");
		fs.writeFileSync(extensionPaths.global, "export default function () {}\n");
		fs.writeFileSync(extensionPaths.cli, "export default function () {}\n");
		fs.writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ theme: "global-theme", defaultModel: "global-model" }),
		);
		fs.writeFileSync(
			path.join(cwd, ".pi", "settings.json"),
			JSON.stringify({ theme: "project-theme", defaultModel: "project-model" }),
		);

		const { modules } = await loadResourceLoader(extensionPaths);
		const { SettingsManager } = modules.settingsManager;
		const { DefaultResourceLoader } = modules.resourceLoader;

		// A previous approval: the project was trusted and its extensions were resolved.
		const approvedSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const approvedLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: approvedSettings,
			additionalExtensionPaths: [extensionPaths.cli],
		});
		await approvedLoader.reload({
			resolveProjectTrust: async () => true,
		});
		assert.deepEqual(
			extensionPathsOf(approvedLoader.getExtensions()),
			[extensionPaths.cli, extensionPaths.global, extensionPaths.project].sort(),
			"a trusted project resolves project, global and CLI extensions",
		);
		assert.equal(approvedSettings.getProjectSettings().theme, "project-theme");

		// Revocation: the same loader reloads and the resolver now denies trust.
		await approvedLoader.reload({
			resolveProjectTrust: async () => false,
		});
		assert.equal(approvedSettings.isProjectTrusted(), false, "revocation must reach the settings manager");
		assert.deepEqual(
			plain(approvedSettings.getProjectSettings()),
			{},
			"revocation must discard cached project configuration",
		);
		assert.equal(approvedSettings.getTheme(), "global-theme", "global settings survive revocation");
		assert.deepEqual(
			extensionPathsOf(approvedLoader.getExtensions()),
			[extensionPaths.cli, extensionPaths.global].sort(),
			"the next resolved resource set must not contain project extensions",
		);

		// A later reload without a resolver must preserve the revoked state.
		await approvedLoader.reload();
		assert.equal(approvedSettings.isProjectTrusted(), false, "reload without a resolver keeps the trust state");
		assert.deepEqual(plain(approvedSettings.getProjectSettings()), {});
		assert.deepEqual(
			extensionPathsOf(approvedLoader.getExtensions()),
			[extensionPaths.cli, extensionPaths.global].sort(),
			"reload without a resolver keeps project extensions out",
		);

		// Trust granted through the resolver still loads project resources.
		const trustedSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const trustedLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: trustedSettings,
			additionalExtensionPaths: [extensionPaths.cli],
		});
		await trustedLoader.reload({ resolveProjectTrust: async () => true });
		assert.equal(trustedSettings.isProjectTrusted(), true);
		assert.equal(trustedSettings.getTheme(), "project-theme");
		assert.deepEqual(
			extensionPathsOf(trustedLoader.getExtensions()),
			[extensionPaths.cli, extensionPaths.global, extensionPaths.project].sort(),
			"approval through the resolver loads project extensions",
		);

		// The pre-trust pass must expose only global and CLI extensions to the resolver.
		let preTrustPaths;
		const observedSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const observedLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: observedSettings,
			additionalExtensionPaths: [extensionPaths.cli],
		});
		await observedLoader.reload({
			resolveProjectTrust: async ({ extensionsResult }) => {
				preTrustPaths = extensionPathsOf(extensionsResult);
				return false;
			},
		});
		assert.deepEqual(
			preTrustPaths,
			[extensionPaths.cli, extensionPaths.global].sort(),
			"the pre-trust pass must not hand project extensions to the trust resolver",
		);
		assert.equal(observedSettings.isProjectTrusted(), false);
		assert.deepEqual(plain(observedSettings.getProjectSettings()), {});
	} finally {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
}

/* ------------------------------------------------------------------ */

const scenarios = [
	testHeadlessTrustIsDenied,
	testHeadlessDefaultsAndStoredDecisions,
	testInteractiveAndExtensionDecisionsStillWork,
	testRevocationDiscardsProjectSettings,
	testRevocationClearsResolvedResources,
];

for (const scenario of scenarios) {
	await scenario();
	console.log(`ok - ${scenario.name}`);
}

console.log("regression: all cross-module trust revocation checks passed");
