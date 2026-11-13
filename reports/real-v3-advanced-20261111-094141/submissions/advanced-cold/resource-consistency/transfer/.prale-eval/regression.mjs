/**
 * Cross-module regression for the project-trust incident.
 *
 * Links the real production modules (project-trust resolver, settings manager,
 * resource assembly) and drives them across their boundaries with local fakes:
 *   - SettingsManager  -> project settings only load while trusted, project
 *                         values override globals, nested global defaults survive
 *   - resolveProjectTrusted -> a remembered boolean (including `false`) wins over
 *                              the default policy; the default/prompt path still works
 *   - DefaultResourceLoader -> the accepted trust decision reaches settings reload
 *                              and final resource (system prompt) resolution
 *
 * Run: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph } from "./subject.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CORE = "packages/coding-agent/src/core/";
const SETTINGS = `${CORE}settings-manager.ts`;
const PROJECT_TRUST = `${CORE}project-trust.ts`;
const RESOURCE_LOADER = `${CORE}resource-loader.ts`;
const TEMP_ROOT = path.join(here, ".tmp-regression");

/* ------------------------------------------------------------------ */
/* Local boundary fakes (no real time, randomness or external calls)   */
/* ------------------------------------------------------------------ */

function resolvePath(input, base, options) {
	let value = String(input);
	if (options?.trim) value = value.trim();
	if (options?.stripAtPrefix && value.startsWith("@")) value = value.slice(1);
	if (value.startsWith("~/")) value = path.join(root, value.slice(2));
	return path.isAbsolute(value) ? path.resolve(value) : path.resolve(base ?? root, value);
}

function canonicalizePath(value) {
	try {
		return realpathSync(value);
	} catch {
		return value;
	}
}

const stripBom = (value) => (value.startsWith("\uFEFF") ? value.slice(1) : value);
const normalizePath = (value) => value;
const isLocalPath = (value) => value.startsWith(".") || path.isAbsolute(value);

const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300000;
function parseHttpIdleTimeoutMs(value) {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(value)}`);
	}
	return value;
}

// `chalk` (resource-loader) and `proper-lockfile` (settings-manager) are both
// default imports, so one shared boundary object covers both.
const defaultPackageFake = {
	yellow: (value) => String(value),
	red: (value) => String(value),
	lockSync: () => () => {},
	unlockSync: () => {},
};

function boundaryBindings() {
	return {
		default: defaultPackageFake,
		APP_NAME: "pi",
		CONFIG_DIR_NAME: ".pi",
		getAgentDir: () => path.join(TEMP_ROOT, "agent"),
		resolvePath,
		normalizePath,
		canonicalizePath,
		isLocalPath,
		stripBom,
		DEFAULT_HTTP_IDLE_TIMEOUT_MS,
		parseHttpIdleTimeoutMs,
		DEFAULT_MAX_AGENT_RETRY_DELAY_MS: 60000,
		getProjectTrustOptions: (cwd) => [
			{ label: "Trust", trusted: true, updates: [{ path: cwd, decision: true }], savedPath: cwd },
			{ label: "Do not trust", trusted: false, updates: [{ path: cwd, decision: false }], savedPath: cwd },
		],
		hasTrustRequiringProjectResources: () => true,
		emitProjectTrustEvent: async () => ({ result: undefined, errors: [] }),
		createEventBus: () => ({ emit: () => {}, on: () => () => {} }),
		clearExtensionCache: () => {},
		createExtensionRuntime: () => ({ fake: true }),
		loadExtensionFromFactory: async () => {
			throw new Error("unexpected inline extension factory");
		},
		loadExtensionsCached: async (_paths, _cwd, _eventBus, runtime) => ({
			extensions: [],
			errors: [],
			warnings: [],
			runtime: runtime ?? { fake: true },
		}),
		findGitPaths: () => undefined,
		loadPromptTemplates: () => ({ templates: [], diagnostics: [] }),
		loadSkills: () => ({ skills: [], diagnostics: [] }),
		loadThemeFromPath: () => {
			throw new Error("unexpected theme load");
		},
		createSourceInfo: (sourcePath, metadata) => ({
			path: sourcePath,
			source: metadata?.source,
			scope: metadata?.scope,
			origin: metadata?.origin,
			baseDir: metadata?.baseDir,
		}),
		resetTimings: () => {},
		DefaultPackageManager: class FakePackageManager {
			constructor(options) {
				this.options = options;
			}
			async resolve() {
				return { extensions: [], skills: [], prompts: [], themes: [], diagnostics: [] };
			}
			async resolveExtensionSources() {
				return { extensions: [], skills: [], prompts: [], themes: [], diagnostics: [] };
			}
		},
	};
}

/** Storage boundary for SettingsManager: JSON strings per scope. */
function createStorage(globalSettings, projectSettings) {
	const files = {
		global: globalSettings === undefined ? undefined : JSON.stringify(globalSettings),
		project: projectSettings === undefined ? undefined : JSON.stringify(projectSettings),
	};
	return {
		files,
		withLock(scope, fn) {
			const next = fn(files[scope]);
			if (next !== undefined) files[scope] = next;
		},
	};
}

/** Trust-store boundary: remembers booleans, `null`/missing means "no decision". */
function createTrustStore(initial = {}) {
	const entries = new Map(Object.entries(initial));
	const writes = [];
	return {
		entries,
		writes,
		get: (cwd) => (entries.has(cwd) ? entries.get(cwd) : null),
		getEntry: (cwd) => (entries.has(cwd) ? { path: cwd, decision: entries.get(cwd) } : null),
		set: (cwd, decision) => {
			writes.push({ path: cwd, decision });
			if (decision === null) entries.delete(cwd);
			else entries.set(cwd, decision);
		},
		setMany: (updates) => {
			for (const update of updates) {
				writes.push(update);
				if (update.decision === null) entries.delete(update.path);
				else entries.set(update.path, update.decision);
			}
		},
	};
}

const silentContext = (overrides = {}) => ({
	hasUI: false,
	...overrides,
});

/* ------------------------------------------------------------------ */
/* 1. Settings manager: trust-gated precedence, nested defaults        */
/* ------------------------------------------------------------------ */

async function assertSettingsPrecedence() {
	const graph = createGraph(root, [SETTINGS], boundaryBindings());
	const { SettingsManager } = await graph.module(SETTINGS);
	assert.equal(typeof SettingsManager, "function", "settings-manager.ts must export SettingsManager");

	const storage = createStorage(
		{
			theme: "global-theme",
			prompts: ["global-prompt.md"],
			compaction: { reserveTokens: 1000, keepRecentTokens: 5000 },
			retry: { maxRetries: 7, baseDelayMs: 1234 },
		},
		{
			theme: "project-theme",
			prompts: ["project-prompt.md"],
			compaction: { reserveTokens: 42 },
		},
	);

	// Trusted project: project values win, nested global defaults survive.
	const trusted = SettingsManager.fromStorage(storage, { projectTrusted: true });
	assert.equal(trusted.isProjectTrusted(), true);
	assert.equal(trusted.getThemeSetting(), "project-theme", "project theme must override global theme");
	assert.deepEqual([...trusted.getPromptTemplatePaths()], ["project-prompt.md"], "project arrays must override globals");
	assert.equal(trusted.getCompactionReserveTokens(), 42, "project nested compaction value must override global");
	assert.equal(
		trusted.getCompactionKeepRecentTokens(),
		5000,
		"nested global default must survive a partial project override",
	);
	assert.equal(trusted.getRetrySettings().maxRetries, 7, "untouched global nested values must survive");
	assert.equal(trusted.getRetrySettings().baseDelayMs, 1234);
	assert.equal(trusted.getGlobalSettings().theme, "global-theme", "global settings must stay unmodified");

	// Revoked trust: project configuration must not leak into resolution.
	trusted.setProjectTrusted(false);
	assert.equal(trusted.isProjectTrusted(), false);
	assert.equal(trusted.getThemeSetting(), "global-theme", "untrusted project values must be ignored");
	assert.equal(trusted.getCompactionReserveTokens(), 1000);
	assert.equal(trusted.getCompactionKeepRecentTokens(), 5000);

	// Accepted trust again: project configuration returns.
	trusted.setProjectTrusted(true);
	assert.equal(trusted.isProjectTrusted(), true);
	assert.equal(trusted.getThemeSetting(), "project-theme", "re-trusted project configuration must reload");
	assert.equal(trusted.getCompactionReserveTokens(), 42);

	// An accepted reload keeps project configuration and still merges globals.
	storage.files.project = JSON.stringify({ theme: "reloaded-theme", compaction: { reserveTokens: 24 } });
	await trusted.reload();
	assert.equal(trusted.isProjectTrusted(), true);
	assert.equal(trusted.getThemeSetting(), "reloaded-theme", "reload must apply project overrides");
	assert.equal(trusted.getCompactionReserveTokens(), 24);
	assert.equal(trusted.getCompactionKeepRecentTokens(), 5000, "reload must keep nested global defaults");
	assert.equal(trusted.getRetrySettings().maxRetries, 7);

	// A reload after trust is revoked keeps ignoring project settings.
	const observer = SettingsManager.fromStorage(storage, { projectTrusted: false });
	await observer.reload();
	assert.equal(observer.getThemeSetting(), "global-theme");
	assert.equal(observer.getCompactionReserveTokens(), 1000);
}

/* ------------------------------------------------------------------ */
/* 2. Resolver: a remembered boolean is authoritative                  */
/* ------------------------------------------------------------------ */

async function assertTrustResolver() {
	const graph = createGraph(root, [PROJECT_TRUST], boundaryBindings());
	const { resolveProjectTrusted } = await graph.module(PROJECT_TRUST);
	assert.equal(typeof resolveProjectTrusted, "function", "project-trust.ts must export resolveProjectTrusted");

	const cwd = path.join(TEMP_ROOT, "project");
	const baseOptions = { cwd, projectTrustContext: silentContext() };

	// Stored denial must beat an allow-by-default policy.
	const deniedStore = createTrustStore({ [cwd]: false });
	const denied = await resolveProjectTrusted({
		...baseOptions,
		trustStore: deniedStore,
		defaultProjectTrust: "always",
	});
	assert.equal(denied, false, "a stored denial must not fall through to the allow-by-default policy");
	assert.deepEqual(deniedStore.writes, [], "a stored decision must not be rewritten by the default policy");

	// Stored approval must beat a deny-by-default policy.
	const allowedStore = createTrustStore({ [cwd]: true });
	const allowed = await resolveProjectTrusted({
		...baseOptions,
		trustStore: allowedStore,
		defaultProjectTrust: "never",
	});
	assert.equal(allowed, true, "a stored approval must not fall through to the deny-by-default policy");
	assert.deepEqual(allowedStore.writes, []);

	// With no stored decision the default policy still applies in both directions.
	const emptyAllow = createTrustStore();
	assert.equal(
		await resolveProjectTrusted({
			...baseOptions,
			trustStore: emptyAllow,
			defaultProjectTrust: "always",
		}),
		true,
		"defaultProjectTrust=always must still allow an undecided project",
	);
	const emptyDeny = createTrustStore();
	assert.equal(
		await resolveProjectTrusted({
			...baseOptions,
			trustStore: emptyDeny,
			defaultProjectTrust: "never",
		}),
		false,
		"defaultProjectTrust=never must still deny an undecided project",
	);

	// Ask mode without UI keeps the safe default of "not trusted".
	const noUi = createTrustStore();
	assert.equal(
		await resolveProjectTrusted({
			...baseOptions,
			trustStore: noUi,
			defaultProjectTrust: "ask",
			projectTrustContext: silentContext({ hasUI: false }),
		}),
		false,
		"ask mode without UI must deny",
	);

	// Interactive selection still persists the chosen decision.
	const promptedStore = createTrustStore();
	const prompted = await resolveProjectTrusted({
		...baseOptions,
		trustStore: promptedStore,
		defaultProjectTrust: "ask",
		projectTrustContext: silentContext({
			hasUI: true,
			ui: { select: async (_prompt, labels) => labels[0] },
		}),
	});
	assert.equal(prompted, true, "the interactive choice must be honoured");
	assert.deepEqual(promptedStore.entries.get(cwd), true, "the interactive choice must be stored");

	// An extension decision still takes precedence over the stored decision.
	const extensionStore = createTrustStore({ [cwd]: true });
	const extensionGraph = createGraph(root, [PROJECT_TRUST], {
		...boundaryBindings(),
		emitProjectTrustEvent: async () => ({ result: { trusted: "no", remember: true }, errors: [] }),
	});
	const extensionResolver = (await extensionGraph.module(PROJECT_TRUST)).resolveProjectTrusted;
	assert.equal(
		await extensionResolver({
			...baseOptions,
			trustStore: extensionStore,
			defaultProjectTrust: "always",
			extensionsResult: { extensions: [], errors: [], runtime: {} },
		}),
		false,
		"an extension denial must win over the stored decision",
	);
	assert.deepEqual(extensionStore.writes, [{ path: cwd, decision: false }], "remembered extension denial is stored");
}

/* ------------------------------------------------------------------ */
/* 3. Resource assembly: accepted decision reaches resolution          */
/* ------------------------------------------------------------------ */

async function assertResourceAssembly() {
	const projectDir = path.join(TEMP_ROOT, "assembly-project");
	const agentDir = path.join(TEMP_ROOT, "assembly-agent");
	mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const projectSystemPrompt = path.join(projectDir, ".pi", "SYSTEM.md");
	writeFileSync(projectSystemPrompt, "project system prompt\n", "utf-8");
	writeFileSync(path.join(agentDir, "SYSTEM.md"), "global system prompt\n", "utf-8");

	const graph = createGraph(root, [RESOURCE_LOADER, SETTINGS, PROJECT_TRUST], boundaryBindings());
	const { DefaultResourceLoader } = await graph.module(RESOURCE_LOADER);
	const { SettingsManager } = await graph.module(SETTINGS);
	const { resolveProjectTrusted } = await graph.module(PROJECT_TRUST);
	assert.equal(typeof DefaultResourceLoader, "function", "resource-loader.ts must export DefaultResourceLoader");

	const storage = createStorage({ theme: "global-theme" }, { theme: "project-theme" });
	const settingsManager = SettingsManager.fromStorage(storage, { projectTrusted: false });
	const loader = new DefaultResourceLoader({
		cwd: projectDir,
		agentDir,
		settingsManager,
		noContextFiles: true,
	});

	// Accepted trust must be carried into settings reload and resource resolution.
	await loader.reload({ resolveProjectTrust: async () => true });
	assert.equal(settingsManager.isProjectTrusted(), true, "accepted trust must reach the settings manager");
	assert.equal(settingsManager.getThemeSetting(), "project-theme", "accepted trust must reload project settings");
	assert.equal(loader.getSystemPrompt(), "project system prompt\n", "accepted trust must resolve project resources");
	assert.equal(loader.getSystemPromptSource()?.path, projectSystemPrompt);

	// A rejected trust decision must not leak project configuration or resources.
	const deniedStorage = createStorage({ theme: "global-theme" }, { theme: "project-theme" });
	const deniedSettings = SettingsManager.fromStorage(deniedStorage, { projectTrusted: true });
	const deniedLoader = new DefaultResourceLoader({
		cwd: projectDir,
		agentDir,
		settingsManager: deniedSettings,
		noContextFiles: true,
	});
	await deniedLoader.reload({ resolveProjectTrust: async () => false });
	assert.equal(deniedSettings.isProjectTrusted(), false, "a rejected decision must revoke project trust");
	assert.equal(deniedSettings.getThemeSetting(), "global-theme", "a rejected decision must drop project settings");
	assert.equal(deniedLoader.getSystemPrompt(), "global system prompt\n", "a rejected decision must use globals");

	// End to end with the real resolver: a remembered denial wins over the
	// allow-by-default policy and therefore never reaches project resources.
	const trustStore = createTrustStore({ [projectDir]: false });
	const endToEndStorage = createStorage({ theme: "global-theme" }, { theme: "project-theme" });
	const endToEndSettings = SettingsManager.fromStorage(endToEndStorage, { projectTrusted: true });
	const endToEndLoader = new DefaultResourceLoader({
		cwd: projectDir,
		agentDir,
		settingsManager: endToEndSettings,
		noContextFiles: true,
	});
	await endToEndLoader.reload({
		resolveProjectTrust: ({ extensionsResult }) =>
			resolveProjectTrusted({
				cwd: projectDir,
				trustStore,
				defaultProjectTrust: "always",
				extensionsResult,
				projectTrustContext: silentContext(),
			}),
	});
	assert.equal(endToEndSettings.isProjectTrusted(), false, "a remembered denial must survive the loader reload");
	assert.equal(endToEndSettings.getThemeSetting(), "global-theme");
	assert.equal(endToEndLoader.getSystemPrompt(), "global system prompt\n");
}

/* ------------------------------------------------------------------ */

async function main() {
	rmSync(TEMP_ROOT, { recursive: true, force: true });
	try {
		await assertSettingsPrecedence();
		await assertTrustResolver();
		await assertResourceAssembly();
	} finally {
		rmSync(TEMP_ROOT, { recursive: true, force: true });
	}
	process.stdout.write("regression: all cross-module assertions passed\n");
}

await main();
