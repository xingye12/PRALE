/**
 * Regression coverage for the "revocation must clear cached resources and settings" incident.
 *
 * The real production modules are linked into vm module graphs:
 *   - packages/coding-agent/src/core/project-trust.ts     (trust resolution policy)
 *   - packages/coding-agent/src/core/settings-manager.ts  (settings cache / trust transfer)
 *   - packages/coding-agent/src/core/resource-loader.ts   (resolved resource set)
 *
 * Everything the modules touch outside the workspace (filesystem probes, persistence,
 * extension loading, package resolution, chalk, config) is injected as a boundary fake,
 * so the observable behavior asserted here is produced by the production code itself.
 *
 * Run from the workspace root: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph, loadModule } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE = "packages/coding-agent/src/core/";
const PROJECT_TRUST = `${CORE}project-trust.ts`;
const SETTINGS_MANAGER = `${CORE}settings-manager.ts`;
const RESOURCE_LOADER = `${CORE}resource-loader.ts`;

/** Run one scenario. Assertion failures propagate uncaught on purpose. */
async function scenario(name, fn) {
	await fn();
	console.log(`# ok - ${name}`);
}

// ---------------------------------------------------------------------------
// Shared boundary doubles
// ---------------------------------------------------------------------------

/** In-memory stand-in for ProjectTrustStore (the on-disk trust.json owner). */
function createTrustStore(initial = {}) {
	const decisions = new Map(Object.entries(initial));
	const writes = [];
	return {
		decisions,
		writes,
		get(cwd) {
			return decisions.has(cwd) ? decisions.get(cwd) : null;
		},
		getEntry(cwd) {
			return decisions.has(cwd) ? { path: cwd, decision: decisions.get(cwd) } : null;
		},
		set(cwd, decision) {
			writes.push([cwd, decision]);
			if (decision === null) decisions.delete(cwd);
			else decisions.set(cwd, decision);
		},
		setMany(updates) {
			for (const update of updates) {
				writes.push([update.path, update.decision]);
				if (update.decision === null) decisions.delete(update.path);
				else decisions.set(update.path, update.decision);
			}
		},
	};
}

const TRUST_OPTIONS = (cwd) => [
	{ label: "Trust", trusted: true, updates: [{ path: cwd, decision: true }], savedPath: cwd },
	{ label: "Do not trust", trusted: false, updates: [{ path: cwd, decision: false }], savedPath: cwd },
];

/** Boundary fake for the extension `project_trust` event bus. */
function createTrustEventSource() {
	const state = { result: undefined, errors: [], calls: 0 };
	return {
		state,
		emit: async () => {
			state.calls += 1;
			return { result: state.result, errors: state.errors };
		},
	};
}

/** Fake UI context: records prompts and answers with a scripted selection. */
function createUIContext({ hasUI, answer }) {
	const prompts = [];
	return {
		prompts,
		context: {
			cwd: "/proj",
			mode: hasUI ? "tui" : "print",
			hasUI,
			ui: {
				select: async (title, options) => {
					prompts.push({ title, options });
					return typeof answer === "function" ? answer(options) : answer;
				},
				confirm: async () => false,
				input: async () => undefined,
				notify: () => {},
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Scenario 1: trust policy (project-trust.ts)
// ---------------------------------------------------------------------------

await scenario("headless reload without a stored decision and ask policy denies access", async () => {
	const state = { hasProjectResources: true };
	const events = createTrustEventSource();
	const projectTrust = await loadModule(root, PROJECT_TRUST, {
		APP_NAME: "pi",
		CONFIG_DIR_NAME: ".pi",
		emitProjectTrustEvent: events.emit,
		hasTrustRequiringProjectResources: () => state.hasProjectResources,
		getProjectTrustOptions: (cwd) => TRUST_OPTIONS(cwd),
	});

	const cwd = "/proj";
	const headless = createUIContext({ hasUI: false, answer: undefined }).context;

	// No UI means nobody can be asked; an unresolved "ask" policy must not grant access.
	const store = createTrustStore();
	assert.equal(
		await projectTrust.resolveProjectTrusted({
			cwd,
			trustStore: store,
			defaultProjectTrust: "ask",
			projectTrustContext: headless,
		}),
		false,
		"a headless ask without a stored decision must deny access",
	);
	assert.deepEqual(store.writes, [], "denying headless access must not persist a trust decision");

	// A stored approval is a real decision and is honored even headless.
	const approved = createTrustStore({ [cwd]: true });
	assert.equal(
		await projectTrust.resolveProjectTrusted({
			cwd,
			trustStore: approved,
			defaultProjectTrust: "ask",
			projectTrustContext: headless,
		}),
		true,
		"a stored approval must be honored in headless mode",
	);

	// A stored revocation stays a revocation.
	const revoked = createTrustStore({ [cwd]: false });
	assert.equal(
		await projectTrust.resolveProjectTrusted({
			cwd,
			trustStore: revoked,
			defaultProjectTrust: "always",
			projectTrustContext: headless,
		}),
		false,
		"a stored revocation must win over the default policy",
	);

	// Explicit policies and CLI overrides keep their existing meaning.
	assert.equal(
		await projectTrust.resolveProjectTrusted({
			cwd,
			trustStore: createTrustStore(),
			defaultProjectTrust: "always",
			projectTrustContext: headless,
		}),
		true,
		"defaultProjectTrust=always must trust without a UI",
	);
	assert.equal(
		await projectTrust.resolveProjectTrusted({
			cwd,
			trustStore: createTrustStore(),
			defaultProjectTrust: "never",
			projectTrustContext: headless,
		}),
		false,
		"defaultProjectTrust=never must deny",
	);
	assert.equal(
		await projectTrust.resolveProjectTrusted({
			cwd,
			trustStore: createTrustStore(),
			trustOverride: true,
			defaultProjectTrust: "never",
			projectTrustContext: headless,
		}),
		true,
		"a CLI trust override must win",
	);

	// Projects without trust-requiring resources never need a decision.
	state.hasProjectResources = false;
	assert.equal(
		await projectTrust.resolveProjectTrusted({
			cwd,
			trustStore: createTrustStore(),
			defaultProjectTrust: "never",
			projectTrustContext: headless,
		}),
		true,
		"projects without trust-requiring resources must not be gated",
	);
	state.hasProjectResources = true;

	// Interactive ask still prompts and persists the answer.
	const interactive = createUIContext({ hasUI: true, answer: () => "Trust" });
	const promptedStore = createTrustStore();
	assert.equal(
		await projectTrust.resolveProjectTrusted({
			cwd,
			trustStore: promptedStore,
			defaultProjectTrust: "ask",
			projectTrustContext: interactive.context,
		}),
		true,
		"an interactive approval must trust the project",
	);
	assert.equal(interactive.prompts.length, 1, "interactive ask must prompt exactly once");
	assert.deepEqual(promptedStore.writes, [[cwd, true]], "the interactive answer must be persisted");

	// Cancelling the prompt is not consent.
	const cancelled = createUIContext({ hasUI: true, answer: () => undefined });
	const cancelledStore = createTrustStore();
	assert.equal(
		await projectTrust.resolveProjectTrusted({
			cwd,
			trustStore: cancelledStore,
			defaultProjectTrust: "ask",
			projectTrustContext: cancelled.context,
		}),
		false,
		"cancelling the trust prompt must deny access",
	);
	assert.deepEqual(cancelledStore.writes, [], "cancelling must not persist a decision");
});

await scenario("extension-supplied project_trust decisions are honored", async () => {
	const events = createTrustEventSource();
	const projectTrust = await loadModule(root, PROJECT_TRUST, {
		APP_NAME: "pi",
		CONFIG_DIR_NAME: ".pi",
		emitProjectTrustEvent: events.emit,
		hasTrustRequiringProjectResources: () => true,
		getProjectTrustOptions: (cwd) => TRUST_OPTIONS(cwd),
	});

	const cwd = "/proj";
	const headless = createUIContext({ hasUI: false, answer: undefined }).context;
	const extensionsResult = { extensions: [], errors: [], runtime: {} };

	events.state.result = { trusted: "yes", remember: true };
	const remembering = createTrustStore();
	assert.equal(
		await projectTrust.resolveProjectTrusted({
			cwd,
			trustStore: remembering,
			defaultProjectTrust: "ask",
			extensionsResult,
			projectTrustContext: headless,
		}),
		true,
		"an extension approval must trust the project",
	);
	assert.deepEqual(remembering.writes, [[cwd, true]], "a remember=true approval must be persisted");

	events.state.result = { trusted: "no", remember: true };
	const denying = createTrustStore();
	assert.equal(
		await projectTrust.resolveProjectTrusted({
			cwd,
			trustStore: denying,
			defaultProjectTrust: "always",
			extensionsResult,
			projectTrustContext: headless,
		}),
		false,
		"an extension denial must win over the default policy",
	);
	assert.deepEqual(denying.writes, [[cwd, false]], "a remember=true denial must be persisted");

	events.state.result = undefined;
	events.state.errors = [{ extensionPath: "/ext/trust.ts", error: "boom" }];
	const reported = [];
	const deniedByDefault = createTrustStore();
	assert.equal(
		await projectTrust.resolveProjectTrusted({
			cwd,
			trustStore: deniedByDefault,
			defaultProjectTrust: "ask",
			extensionsResult,
			projectTrustContext: headless,
			onExtensionError: (message) => reported.push(message),
		}),
		false,
		"a failing project_trust extension must fall through to the headless ask policy",
	);
	assert.deepEqual(reported, ['Extension "/ext/trust.ts" project_trust error: boom']);
});

// ---------------------------------------------------------------------------
// Scenario 2: settings cache transfer (settings-manager.ts)
// ---------------------------------------------------------------------------

await scenario("revoking trust discards cached project settings but keeps global settings", async () => {
	const settings = await loadModule(root, SETTINGS_MANAGER, {
		CONFIG_DIR_NAME: ".pi",
		getAgentDir: () => "/agent",
		normalizePath: (value) => value,
		resolvePath: (value) => value,
		stripBom: (value) => value.replace(/^\uFEFF/, ""),
		DEFAULT_HTTP_IDLE_TIMEOUT_MS: 60000,
		parseHttpIdleTimeoutMs: () => undefined,
	});

	const storage = new settings.InMemorySettingsStorage();
	storage.withLock("global", () =>
		JSON.stringify({ theme: "global-theme", defaultProvider: "global-provider", compaction: { reserveTokens: 4096 } }),
	);
	storage.withLock("project", () =>
		JSON.stringify({ theme: "project-theme", defaultModel: "project-model", compaction: { reserveTokens: 1024 } }),
	);

	const manager = settings.SettingsManager.fromStorage(storage, { projectTrusted: false });
	assert.equal(manager.isProjectTrusted(), false);
	assert.deepEqual(manager.getProjectSettings(), {}, "project settings stay unloaded while untrusted");
	assert.equal(manager.getTheme(), "global-theme");

	// Approval loads the project configuration.
	manager.setProjectTrusted(true);
	assert.equal(manager.isProjectTrusted(), true);
	assert.equal(manager.getTheme(), "project-theme", "approval must apply project configuration");
	assert.equal(manager.getDefaultModel(), "project-model");
	assert.equal(manager.getCompactionReserveTokens(), 1024);

	// Revocation must drop the cached project configuration immediately.
	manager.setProjectTrusted(false);
	assert.deepEqual(manager.getProjectSettings(), {}, "revocation must discard cached project settings");
	assert.equal(manager.getTheme(), "global-theme", "project settings must not survive revocation");
	assert.equal(manager.getDefaultModel(), undefined, "project-only values must not survive revocation");
	assert.equal(manager.getCompactionReserveTokens(), 4096, "project overrides must not survive revocation");

	// Global settings are untouched by the trust transfer.
	const globalSettings = manager.getGlobalSettings();
	assert.equal(globalSettings.defaultProvider, "global-provider", "global settings must be preserved");
	assert.equal(globalSettings.compaction?.reserveTokens, 4096);
	assert.equal(manager.getDefaultProvider(), "global-provider");

	// Writes to project settings are refused while untrusted.
	assert.throws(
		() => manager.setProjectExtensionPaths(["/ext/project.ts"]),
		/Project is not trusted; refusing to write project settings/,
	);
	await manager.flush();
	assert.deepEqual(manager.getProjectSettings(), {});
});

// ---------------------------------------------------------------------------
// Scenario 3: resolved resource set across reload/revoke (resource-loader.ts)
// ---------------------------------------------------------------------------

const tempRoot = path.join(root, ".prale-eval", "tmp");
fs.mkdirSync(tempRoot, { recursive: true });
const cwd = path.join(tempRoot, "project");
const agentDir = path.join(tempRoot, "agent");
const globalExtPath = path.join(agentDir, "extensions", "global-ext.ts");
const projectExtPath = path.join(cwd, ".pi", "extensions", "project-ext.ts");
const cliExtPath = path.join(tempRoot, "cli", "cli-ext.ts");
for (const file of [globalExtPath, projectExtPath, cliExtPath]) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "export default function () {}\n");
}

try {
	await scenario("revocation removes project extensions from the next resolved resource set", async () => {
		const resolvePath = (value, base) => (path.isAbsolute(value) ? path.normalize(value) : path.resolve(base ?? cwd, value));
		const globalMetadata = { source: "auto", scope: "user", origin: "top-level", baseDir: agentDir };
		const projectMetadata = { source: "auto", scope: "project", origin: "top-level", baseDir: path.join(cwd, ".pi") };
		const cliMetadata = { source: "cli", scope: "temporary", origin: "top-level" };
		const resource = (file, metadata) => ({ path: file, metadata, enabled: true });

		// Boundary fakes: package resolution and extension loading.
		class FakePackageManager {
			constructor(options) {
				this.settingsManager = options.settingsManager;
			}
			async resolve() {
				// Mirrors the production rule: project resources exist only while the project is trusted.
				const projectTrusted = this.settingsManager.isProjectTrusted();
				return {
					extensions: [
						...(projectTrusted ? [resource(projectExtPath, projectMetadata)] : []),
						resource(globalExtPath, globalMetadata),
					],
					skills: [],
					prompts: [],
					themes: [],
				};
			}
			async resolveExtensionSources(paths) {
				return {
					extensions: paths.map((file) => resource(resolvePath(file), cliMetadata)),
					skills: [],
					prompts: [],
					themes: [],
				};
			}
		}

		const events = createTrustEventSource();
		const bindings = {
			APP_NAME: "pi",
			CONFIG_DIR_NAME: ".pi",
			getAgentDir: () => agentDir,
			normalizePath: (value) => value,
			resolvePath,
			canonicalizePath: (value) => resolvePath(value),
			isLocalPath: (value) => !/^(npm|git|github|https?|ssh):/.test(value.trim()),
			stripBom: (value) => value.replace(/^\uFEFF/, ""),
			DEFAULT_HTTP_IDLE_TIMEOUT_MS: 60000,
			parseHttpIdleTimeoutMs: () => undefined,
			loadThemeFromPath: (file) => ({ name: path.basename(file) }),
			findGitPaths: () => undefined,
			createEventBus: () => ({ emit() {}, on() {}, off() {} }),
			resetTimings: () => {},
			createSourceInfo: (file, metadata) => ({ ...metadata, path: file }),
			loadSkills: () => ({ skills: [], diagnostics: [] }),
			loadPromptTemplates: () => ({ templates: [], diagnostics: [] }),
			clearExtensionCache: () => {},
			createExtensionRuntime: () => ({ pendingProviderRegistrations: [], pendingNativeProviderRegistrations: [] }),
			loadExtensionFromFactory: async () => {
				throw new Error("unexpected inline extension factory");
			},
			loadExtensionsCached: async (paths) => ({
				extensions: paths.map((file) => ({
					path: file,
					resolvedPath: resolvePath(file),
					commands: new Map(),
					tools: new Map(),
					flags: new Map(),
				})),
				errors: [],
				runtime: { pendingProviderRegistrations: [], pendingNativeProviderRegistrations: [] },
			}),
			DefaultPackageManager: FakePackageManager,
			emitProjectTrustEvent: events.emit,
			hasTrustRequiringProjectResources: () => true,
			getProjectTrustOptions: (target) => TRUST_OPTIONS(target),
			// `chalk` default export used only on read-error paths.
			default: {
				yellow: (value) => value,
				cyan: (value) => value,
				red: (value) => value,
			},
		};

		const graph = createGraph(root, [RESOURCE_LOADER, SETTINGS_MANAGER, PROJECT_TRUST], bindings);
		const settingsModule = await graph.module(SETTINGS_MANAGER);
		const projectTrust = await graph.module(PROJECT_TRUST);
		const resourceLoader = await graph.module(RESOURCE_LOADER);

		const storage = new settingsModule.InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ theme: "global-theme" }));
		storage.withLock("project", () => JSON.stringify({ theme: "project-theme" }));
		const settingsManager = settingsModule.SettingsManager.fromStorage(storage, { projectTrusted: false });

		const trustStore = createTrustStore();
		const headless = createUIContext({ hasUI: false, answer: undefined }).context;
		const seenPreTrust = [];
		const resolveProjectTrust = async ({ extensionsResult }) => {
			// Copy into host-realm arrays so cross-realm prototypes do not affect deep equality.
			seenPreTrust.push(Array.from(extensionsResult.extensions, (extension) => extension.path));
			return projectTrust.resolveProjectTrusted({
				cwd,
				trustStore,
				defaultProjectTrust: "ask",
				extensionsResult,
				projectTrustContext: headless,
			});
		};

		const loader = new resourceLoader.DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalExtensionPaths: [cliExtPath],
		});
		const loadedPaths = () => Array.from(loader.getExtensions().extensions, (extension) => extension.path);
		const untouched = [cliExtPath, globalExtPath];

		// Bootstrap (no stored decision, headless, ask): project resources are never handed to the resolver.
		await loader.reload({ resolveProjectTrust });
		assert.deepEqual(
			seenPreTrust.at(-1),
			untouched,
			"the pre-trust extension set must not contain project extensions",
		);
		assert.deepEqual(loadedPaths(), untouched, "headless ask without a decision must not load project extensions");
		assert.equal(settingsManager.isProjectTrusted(), false, "the loader must not trust the project implicitly");
		assert.equal(settingsManager.getTheme(), "global-theme", "project settings must not be applied");

		// Previous approval: project resources come back.
		trustStore.set(cwd, true);
		await loader.reload({ resolveProjectTrust });
		assert.deepEqual(
			loadedPaths(),
			[cliExtPath, projectExtPath, globalExtPath],
			"an approved project must contribute its extensions next to global and CLI resources",
		);
		assert.equal(settingsManager.isProjectTrusted(), true);
		assert.equal(settingsManager.getTheme(), "project-theme", "an approved project must contribute its settings");

		// Revocation: the next resolved resource set drops project extensions and project settings.
		trustStore.set(cwd, false);
		await loader.reload({ resolveProjectTrust });
		assert.deepEqual(
			seenPreTrust.at(-1),
			untouched,
			"the pre-trust extension set must be trusted-independent",
		);
		assert.deepEqual(
			loadedPaths(),
			untouched,
			"revoking trust must remove project extensions while keeping global and CLI resources",
		);
		assert.equal(settingsManager.isProjectTrusted(), false, "the loader must adopt the revoked decision");
		assert.deepEqual(
			settingsManager.getProjectSettings(),
			{},
			"revocation must clear cached project configuration",
		);
		assert.equal(settingsManager.getTheme(), "global-theme", "revocation must fall back to global settings");

		// Reload without a resolver keeps the current (revoked) trust state.
		await loader.reload();
		assert.deepEqual(loadedPaths(), untouched, "a resolver-less reload must keep project extensions out");
		assert.equal(settingsManager.isProjectTrusted(), false, "a resolver-less reload must keep the trust state");
		assert.equal(settingsManager.getTheme(), "global-theme");
	});
} finally {
	fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("# all regression scenarios passed");
