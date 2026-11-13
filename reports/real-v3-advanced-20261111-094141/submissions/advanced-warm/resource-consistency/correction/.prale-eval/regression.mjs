#!/usr/bin/env node
/**
 * Cross-module regression for the project-trust incident.
 *
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 *
 * The script links the real production modules (project-trust, trust-manager,
 * settings-manager, resource-loader) through the read-only subject helper and
 * replaces only the outer boundary collaborators (extension runner, lock file,
 * package manager, extension loader, theme/skill/prompt loaders). Every
 * assertion is observable at a module boundary:
 *
 *   - extension decision without `remember` must not persist consent
 *   - a session-only prompt answer must not persist consent
 *   - approvals and denials with `remember: true` must persist
 *   - trust changes must reload project settings
 *   - the resolver must run exactly once after the untrusted bootstrap and its
 *     result must drive the final settings/extensions load
 *   - global configuration must stay untouched
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph } from "./subject.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TMP_ROOT = join(ROOT, ".prale-eval", "tmp");

const PROJECT_TRUST = "packages/coding-agent/src/core/project-trust.ts";
const TRUST_MANAGER = "packages/coding-agent/src/core/trust-manager.ts";
const SETTINGS_MANAGER = "packages/coding-agent/src/core/settings-manager.ts";
const RESOURCE_LOADER = "packages/coding-agent/src/core/resource-loader.ts";

// ---------------------------------------------------------------------------
// Boundary fakes for the pure path/text helpers. Kept faithful to
// packages/coding-agent/src/utils/{paths,text}.ts so the real modules see the
// same absolute paths they would in production.
// ---------------------------------------------------------------------------
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizePath(input, options = {}) {
	let normalized = options.trim ? input.trim() : input;
	if (options.normalizeUnicodeSpaces) normalized = normalized.replace(UNICODE_SPACES, " ");
	if (options.stripAtPrefix && normalized.startsWith("@")) normalized = normalized.slice(1);
	if (options.expandTilde ?? true) {
		const home = options.homeDir ?? homedir();
		if (normalized === "~") return home;
		if (normalized.startsWith("~/")) return join(home, normalized.slice(2));
	}
	return normalized;
}

function resolvePath(input, baseDir = ROOT, options = {}) {
	const normalized = normalizePath(input, options);
	const normalizedBaseDir = normalizePath(baseDir);
	return isAbsolute(normalized) ? resolve(normalized) : resolve(normalizedBaseDir, normalized);
}

function canonicalizePath(path) {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function stripBom(content) {
	return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

/** One fake default export serving the two modules that import one. */
const defaultExportFake = {
	// proper-lockfile (trust store + settings storage)
	lockSync: () => () => {},
	// chalk (resource loader warnings)
	yellow: (value) => value,
	red: (value) => value,
	cyan: (value) => value,
	green: (value) => value,
};

const sharedPathBindings = { normalizePath, resolvePath, canonicalizePath, stripBom };

// ---------------------------------------------------------------------------
// Workspace-local scratch state. Everything is created under .prale-eval/tmp
// and removed again before the script finishes.
// ---------------------------------------------------------------------------
const cleanupTargets = [];

function scratchDir(label) {
	const dir = join(TMP_ROOT, `${label}-${cleanupTargets.length}-${process.pid}`);
	mkdirSync(dir, { recursive: true });
	cleanupTargets.push(dir);
	return dir;
}

function writeJson(filePath, value) {
	mkdirSync(join(filePath, ".."), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

/** Project that must be gated by trust (.pi/settings.json exists). */
function makeTrustRequiringProject(settings = { theme: "project" }) {
	const root = scratchDir("project");
	writeJson(join(root, ".pi", "settings.json"), settings);
	return root;
}

function makeAgentDir(settings = { theme: "global" }) {
	const root = scratchDir("agent");
	writeJson(join(root, "settings.json"), settings);
	return root;
}

/** Project without any trust-requiring resources. */
function makePlainProject() {
	return scratchDir("plain");
}

function assertGlobalConfigUntouched(agentDir, expected) {
	assert.equal(
		readFileSync(join(agentDir, "settings.json"), "utf-8"),
		`${JSON.stringify(expected, null, 2)}\n`,
		"resolving project trust must not mutate global configuration",
	);
}

// ---------------------------------------------------------------------------
// Graph A: project-trust.ts + trust-manager.ts (real) with the extension
// runner's project_trust aggregation replaced by a boundary fake.
// ---------------------------------------------------------------------------
async function loadTrustModules(state) {
	const graph = createGraph(
		ROOT,
		[PROJECT_TRUST, TRUST_MANAGER],
		{
			...sharedPathBindings,
			APP_NAME: "pi",
			CONFIG_DIR_NAME: ".pi",
			default: defaultExportFake,
			emitProjectTrustEvent: async (extensionsResult, event, ctx) => {
				state.extensionCalls.push({ extensionsResult, event, ctx });
				return { result: state.decision, errors: state.errors ?? [] };
			},
		},
	);
	return {
		projectTrust: await graph.module(PROJECT_TRUST),
		trustManager: await graph.module(TRUST_MANAGER),
	};
}

function trustContext(cwd, { hasUI = true, answer } = {}) {
	const prompts = [];
	return {
		prompts,
		ctx: {
			cwd,
			mode: "interactive",
			hasUI,
			ui: {
				select: async (title, options) => {
					prompts.push({ title, options: [...options] });
					return answer === undefined ? undefined : answer(options);
				},
				confirm: async () => false,
				input: async () => undefined,
				notify: () => {},
			},
		},
	};
}

function trustStoreHasEntry(store, cwd) {
	return store.get(cwd) !== null;
}

async function testExtensionDecisionWithoutRememberIsSessionOnly() {
	const agentDir = makeAgentDir();
	const cwd = makeTrustRequiringProject();
	const state = { decision: { trusted: "yes" }, extensionCalls: [] };
	const { projectTrust, trustManager } = await loadTrustModules(state);
	const store = new trustManager.ProjectTrustStore(agentDir);
	const { ctx } = trustContext(cwd);
	const extensionsResult = { extensions: [], errors: [], runtime: {} };

	const trusted = await projectTrust.resolveProjectTrusted({ cwd, trustStore: store, extensionsResult, projectTrustContext: ctx });

	assert.equal(trusted, true, "extension approval grants access for this session");
	assert.equal(state.extensionCalls.length, 1, "the extension trust handler runs exactly once per resolution");
	assert.equal(state.extensionCalls[0].event.type, "project_trust");
	assert.equal(trustStoreHasEntry(store, cwd), false, "extension approval without remember must not persist consent");
	assert.equal(existsSync(join(agentDir, "trust.json")), false, "no trust file is written for a session-only approval");
	assertGlobalConfigUntouched(agentDir, { theme: "global" });

	// An explicit `remember: false` is still a session-only decision.
	state.decision = { trusted: "yes", remember: false };
	assert.equal(
		await projectTrust.resolveProjectTrusted({ cwd, trustStore: store, extensionsResult, projectTrustContext: ctx }),
		true,
		"explicit remember: false still grants access for this session",
	);
	assert.equal(trustStoreHasEntry(store, cwd), false, "remember: false must not persist consent");
	assert.equal(existsSync(join(agentDir, "trust.json")), false, "remember: false writes no trust file");
	assertGlobalConfigUntouched(agentDir, { theme: "global" });
}

async function testExtensionDenialWithoutRememberIsSessionOnly() {
	const agentDir = makeAgentDir();
	const cwd = makeTrustRequiringProject();
	const state = { decision: { trusted: "no" }, extensionCalls: [] };
	const { projectTrust, trustManager } = await loadTrustModules(state);
	const store = new trustManager.ProjectTrustStore(agentDir);
	const { ctx } = trustContext(cwd);
	const extensionsResult = { extensions: [], errors: [], runtime: {} };

	const trusted = await projectTrust.resolveProjectTrusted({ cwd, trustStore: store, extensionsResult, projectTrustContext: ctx });

	assert.equal(trusted, false, "extension denial denies access without a persisted decision");
	assert.equal(trustStoreHasEntry(store, cwd), false, "extension denial without remember must not persist consent");
	assertGlobalConfigUntouched(agentDir, { theme: "global" });

	// An explicit `remember: false` denial must stay session-only as well.
	state.decision = { trusted: "no", remember: false };
	assert.equal(
		await projectTrust.resolveProjectTrusted({ cwd, trustStore: store, extensionsResult, projectTrustContext: ctx }),
		false,
		"explicit remember: false still denies access for this session",
	);
	assert.equal(trustStoreHasEntry(store, cwd), false, "remember: false must not persist a denial");
	assert.equal(existsSync(join(agentDir, "trust.json")), false, "remember: false writes no trust file");
	assertGlobalConfigUntouched(agentDir, { theme: "global" });
}

async function testRememberedExtensionDecisionsPersist() {
	const approvalAgent = makeAgentDir();
	const approvalCwd = makeTrustRequiringProject();
	const approvalState = { decision: { trusted: "yes", remember: true }, extensionCalls: [] };
	const approval = await loadTrustModules(approvalState);
	const approvalStore = new approval.trustManager.ProjectTrustStore(approvalAgent);
	const approvalCtx = trustContext(approvalCwd).ctx;
	const extensionsResult = { extensions: [], errors: [], runtime: {} };

	const approved = await approval.projectTrust.resolveProjectTrusted({
		cwd: approvalCwd,
		trustStore: approvalStore,
		extensionsResult,
		projectTrustContext: approvalCtx,
	});
	assert.equal(approved, true);
	assert.equal(approvalStore.get(approvalCwd), true, "remember: true persists the approval");

	const denialAgent = makeAgentDir();
	const denialCwd = makeTrustRequiringProject();
	const denialState = { decision: { trusted: "no", remember: true }, extensionCalls: [] };
	const denial = await loadTrustModules(denialState);
	const denialStore = new denial.trustManager.ProjectTrustStore(denialAgent);

	const denied = await denial.projectTrust.resolveProjectTrusted({
		cwd: denialCwd,
		trustStore: denialStore,
		extensionsResult,
		projectTrustContext: trustContext(denialCwd).ctx,
	});
	assert.equal(denied, false, "remembered denial denies access");
	assert.equal(denialStore.get(denialCwd), false, "remember: true persists the denial");

	// The remembered decision is what a later session resolves without any extension.
	const replayState = { decision: undefined, extensionCalls: [] };
	const replay = await loadTrustModules(replayState);
	const replayed = await replay.projectTrust.resolveProjectTrusted({
		cwd: denialCwd,
		trustStore: new replay.trustManager.ProjectTrustStore(denialAgent),
		projectTrustContext: trustContext(denialCwd, { hasUI: false }).ctx,
	});
	assert.equal(replayed, false, "a remembered denial is honoured by later sessions");
}

async function testSessionOnlyPromptAnswersDoNotPersist() {
	const agentDir = makeAgentDir();
	const cwd = makeTrustRequiringProject();
	const state = { decision: undefined, extensionCalls: [] };
	const { projectTrust, trustManager } = await loadTrustModules(state);
	const store = new trustManager.ProjectTrustStore(agentDir);

	const approve = trustContext(cwd, {
		answer: (options) => options.find((option) => option === "Trust (this session only)"),
	});
	assert.equal(
		await projectTrust.resolveProjectTrusted({ cwd, trustStore: store, projectTrustContext: approve.ctx }),
		true,
		"a session-only approval grants access",
	);
	assert.equal(approve.prompts.length, 1);
	assert.ok(approve.prompts[0].options.includes("Trust (this session only)"));
	assert.equal(trustStoreHasEntry(store, cwd), false, "a session-only approval must not persist consent");

	const deny = trustContext(cwd, {
		answer: (options) => options.find((option) => option === "Do not trust (this session only)"),
	});
	assert.equal(
		await projectTrust.resolveProjectTrusted({ cwd, trustStore: store, projectTrustContext: deny.ctx }),
		false,
		"a session-only denial denies access",
	);
	assert.equal(trustStoreHasEntry(store, cwd), false, "a session-only denial must not persist consent");

	// A later, non-interactive session must still ask again instead of inheriting consent.
	const later = await projectTrust.resolveProjectTrusted({
		cwd,
		trustStore: store,
		projectTrustContext: trustContext(cwd, { hasUI: false }).ctx,
	});
	assert.equal(later, false, "an earlier session-only approval is not permanent consent");
	assertGlobalConfigUntouched(agentDir, { theme: "global" });
}

async function testPersistedPromptAnswersWorkForApprovalAndDenial() {
	const approvalAgent = makeAgentDir();
	const approvalCwd = makeTrustRequiringProject();
	const state = { decision: undefined, extensionCalls: [] };
	const { projectTrust, trustManager } = await loadTrustModules(state);
	const approvalStore = new trustManager.ProjectTrustStore(approvalAgent);

	const approve = trustContext(approvalCwd, { answer: () => "Trust" });
	assert.equal(
		await projectTrust.resolveProjectTrusted({ cwd: approvalCwd, trustStore: approvalStore, projectTrustContext: approve.ctx }),
		true,
	);
	assert.equal(approvalStore.get(approvalCwd), true, "the persisted prompt approval is stored");

	const denialAgent = makeAgentDir();
	const denialCwd = makeTrustRequiringProject();
	const deny = trustContext(denialCwd, { answer: () => "Do not trust" });
	const denialStore = new trustManager.ProjectTrustStore(denialAgent);
	assert.equal(
		await projectTrust.resolveProjectTrusted({ cwd: denialCwd, trustStore: denialStore, projectTrustContext: deny.ctx }),
		false,
	);
	assert.equal(denialStore.get(denialCwd), false, "the persisted prompt denial is stored");
	assert.equal(
		await projectTrust.resolveProjectTrusted({
			cwd: denialCwd,
			trustStore: denialStore,
			projectTrustContext: trustContext(denialCwd, { hasUI: false }).ctx,
		}),
		false,
		"a persisted denial keeps denying later sessions",
	);
	assertGlobalConfigUntouched(denialAgent, { theme: "global" });
}

async function testBootstrapGatesUntrustedProjects() {
	const agentDir = makeAgentDir();
	const plainCwd = makePlainProject();
	const state = { decision: { trusted: "no" }, extensionCalls: [] };
	const { projectTrust, trustManager } = await loadTrustModules(state);
	const store = new trustManager.ProjectTrustStore(agentDir);

	// No project resources require trust: access is granted without prompting.
	assert.equal(
		await projectTrust.resolveProjectTrusted({
			cwd: plainCwd,
			trustStore: store,
			extensionsResult: { extensions: [], errors: [], runtime: {} },
			projectTrustContext: trustContext(plainCwd, { hasUI: false }).ctx,
		}),
		true,
	);
	assert.equal(state.extensionCalls.length, 0, "extensions are not consulted when no project resource needs trust");
	assert.equal(trustStoreHasEntry(store, plainCwd), false);

	// An explicit override wins and still leaves the store alone.
	const cwd = makeTrustRequiringProject();
	assert.equal(
		await projectTrust.resolveProjectTrusted({ cwd, trustStore: store, trustOverride: false, projectTrustContext: trustContext(cwd).ctx }),
		false,
	);
	assert.equal(
		await projectTrust.resolveProjectTrusted({ cwd, trustStore: store, trustOverride: true, projectTrustContext: trustContext(cwd).ctx }),
		true,
	);
	assert.equal(trustStoreHasEntry(store, cwd), false, "an override never persists consent");

	// defaultProjectTrust is honoured without persisting.
	assert.equal(
		await projectTrust.resolveProjectTrusted({
			cwd,
			trustStore: store,
			defaultProjectTrust: "always",
			projectTrustContext: trustContext(cwd, { hasUI: false }).ctx,
		}),
		true,
	);
	assert.equal(
		await projectTrust.resolveProjectTrusted({
			cwd,
			trustStore: store,
			defaultProjectTrust: "never",
			projectTrustContext: trustContext(cwd, { hasUI: false }).ctx,
		}),
		false,
	);
	assert.equal(trustStoreHasEntry(store, cwd), false);
}

// ---------------------------------------------------------------------------
// Graph B: settings-manager.ts (real) with the file system as the boundary.
// A trust change must actually reload project settings and unblock project
// writes only while trusted.
// ---------------------------------------------------------------------------
async function loadSettingsManager() {
	return createGraph(ROOT, [SETTINGS_MANAGER], {
		...sharedPathBindings,
		CONFIG_DIR_NAME: ".pi",
		getAgentDir: () => join(ROOT, ".prale-eval", "tmp", "unused-agent-dir"),
		DEFAULT_HTTP_IDLE_TIMEOUT_MS: 300_000,
		parseHttpIdleTimeoutMs: (value) => (typeof value === "number" ? value : undefined),
		default: defaultExportFake,
	}).module(SETTINGS_MANAGER);
}

async function testTrustChangeReloadsProjectSettings() {
	const settingsManager = await loadSettingsManager();
	const agentDir = makeAgentDir({ theme: "global" });
	const cwd = makeTrustRequiringProject({ theme: "project" });

	const manager = settingsManager.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	assert.equal(manager.isProjectTrusted(), false);
	assert.equal(manager.getTheme(), "global", "untrusted projects do not contribute settings");
	assert.deepEqual(manager.getProjectSettings(), {});
	assert.throws(
		() => manager.setProjectPackages(["npm:blocked"]),
		/Project is not trusted/,
		"untrusted projects cannot write project settings",
	);

	manager.setProjectTrusted(true);
	assert.equal(manager.isProjectTrusted(), true, "changing trust updates the trust state");
	assert.deepEqual(manager.getProjectSettings(), { theme: "project" }, "trusting a project loads its settings");
	assert.equal(manager.getTheme(), "project", "project settings take effect after trust is granted");

	// Writes become legal only after the trust change was applied.
	manager.setProjectPackages(["npm:allowed"]);
	await manager.flush();
	assert.deepEqual(JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf-8")), {
		theme: "project",
		packages: ["npm:allowed"],
	});

	manager.setProjectTrusted(false);
	assert.equal(manager.isProjectTrusted(), false, "revoking trust updates the trust state");
	assert.deepEqual(manager.getProjectSettings(), {}, "revoking trust drops project settings");
	assert.equal(manager.getTheme(), "global", "global settings apply again after trust is revoked");
	assertGlobalConfigUntouched(agentDir, { theme: "global" });
}

// ---------------------------------------------------------------------------
// Graph C: resource-loader.ts + settings-manager.ts (real). The bootstrap pass,
// the single resolver call and the final load must share one trust decision,
// and project settings/system prompt must follow it.
// ---------------------------------------------------------------------------
class FakePackageManager {
	constructor(options) {
		this.options = options;
	}
	async resolve() {
		return { extensions: [], skills: [], prompts: [], themes: [] };
	}
	async resolveExtensionSources() {
		return { extensions: [], skills: [], prompts: [], themes: [] };
	}
}

async function loadResourceModules(tracker) {
	const graph = createGraph(ROOT, [RESOURCE_LOADER, SETTINGS_MANAGER], {
		...sharedPathBindings,
		CONFIG_DIR_NAME: ".pi",
		getAgentDir: () => join(ROOT, ".prale-eval", "tmp", "unused-agent-dir"),
		DEFAULT_HTTP_IDLE_TIMEOUT_MS: 300_000,
		parseHttpIdleTimeoutMs: (value) => (typeof value === "number" ? value : undefined),
		default: defaultExportFake,
		loadThemeFromPath: (path) => ({ name: "fake", sourcePath: path }),
		isLocalPath: () => true,
		createEventBus: () => ({ emit() {}, on() {}, off() {} }),
		clearExtensionCache: () => {},
		createExtensionRuntime: () => ({}),
		loadExtensionFromFactory: async () => {
			throw new Error("unexpected in-memory extension factory");
		},
		loadExtensionsCached: async (paths, cwd, eventBus, runtime) => {
			tracker.extensionLoads.push({ paths: [...paths], runtime });
			return { extensions: [], errors: [], warnings: [], runtime: runtime ?? {} };
		},
		findGitPaths: () => undefined,
		DefaultPackageManager: FakePackageManager,
		loadPromptTemplates: () => ({ templates: [], diagnostics: [] }),
		loadSkills: () => ({ skills: [], diagnostics: [] }),
		createSourceInfo: (path, metadata) => ({ path, ...metadata }),
		resetTimings: () => {},
	});
	return {
		resourceLoader: await graph.module(RESOURCE_LOADER),
		settingsManager: await graph.module(SETTINGS_MANAGER),
	};
}

function makeTrustProjectWithSystemPrompt() {
	const cwd = makeTrustRequiringProject({ theme: "project" });
	writeFileSync(join(cwd, ".pi", "SYSTEM.md"), "project system prompt\n", "utf-8");
	return cwd;
}

async function testResolverRunsOnceAfterUntrustedBootstrap() {
	const tracker = { extensionLoads: [] };
	const { resourceLoader, settingsManager } = await loadResourceModules(tracker);
	const agentDir = makeAgentDir({ theme: "global" });
	const cwd = makeTrustProjectWithSystemPrompt();
	const settings = settingsManager.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const loader = new resourceLoader.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings });

	const observed = [];
	let resolverCalls = 0;
	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			resolverCalls += 1;
			observed.push({
				trusted: settings.isProjectTrusted(),
				theme: settings.getTheme(),
				bootstrapExtensionCount: extensionsResult.extensions.length,
				bootstrapErrorCount: extensionsResult.errors.length,
			});
			return true;
		},
	});

	assert.equal(resolverCalls, 1, "the resolver runs exactly once after the untrusted bootstrap");
	assert.deepEqual(
		observed,
		[{ trusted: false, theme: "global", bootstrapExtensionCount: 0, bootstrapErrorCount: 0 }],
		"the resolver sees the untrusted bootstrap state before the final load",
	);
	assert.equal(settings.isProjectTrusted(), true, "the resolver decision is applied to the settings manager");
	assert.equal(settings.getTheme(), "project", "project settings load for the resolved trust state");
	assert.equal(loader.getSystemPrompt(), "project system prompt\n", "trust-gated project resources load after approval");
	assertGlobalConfigUntouched(agentDir, { theme: "global" });
}

async function testDenialKeepsProjectResourcesGated() {
	const tracker = { extensionLoads: [] };
	const { resourceLoader, settingsManager } = await loadResourceModules(tracker);
	const agentDir = makeAgentDir({ theme: "global" });
	const cwd = makeTrustProjectWithSystemPrompt();
	const settings = settingsManager.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const loader = new resourceLoader.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings });

	let resolverCalls = 0;
	await loader.reload({
		resolveProjectTrust: async () => {
			resolverCalls += 1;
			return false;
		},
	});

	assert.equal(resolverCalls, 1, "the resolver also runs exactly once when it denies");
	assert.equal(settings.isProjectTrusted(), false, "a denial leaves the project untrusted");
	assert.equal(settings.getTheme(), "global", "project settings stay unloaded after denial");
	assert.equal(loader.getSystemPrompt(), undefined, "project system prompt stays gated after denial");
	assertGlobalConfigUntouched(agentDir, { theme: "global" });
}

async function testTrustStateSurvivesRepeatedReloads() {
	const tracker = { extensionLoads: [] };
	const { resourceLoader, settingsManager } = await loadResourceModules(tracker);
	const agentDir = makeAgentDir({ theme: "global" });
	const cwd = makeTrustProjectWithSystemPrompt();
	const settings = settingsManager.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const loader = new resourceLoader.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings });

	let resolverCalls = 0;
	await loader.reload({
		resolveProjectTrust: async () => {
			resolverCalls += 1;
			return true;
		},
	});
	// Later reloads (e.g. /reload) must not re-run the trust resolver.
	await loader.reload();

	assert.equal(resolverCalls, 1, "only the reload that carries a resolver resolves trust");
	assert.equal(settings.isProjectTrusted(), true);
	assert.equal(settings.getTheme(), "project");
	assert.equal(loader.getSystemPrompt(), "project system prompt\n");
	assertGlobalConfigUntouched(agentDir, { theme: "global" });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(TMP_ROOT, { recursive: true });

try {
	await testExtensionDecisionWithoutRememberIsSessionOnly();
	await testExtensionDenialWithoutRememberIsSessionOnly();
	await testRememberedExtensionDecisionsPersist();
	await testSessionOnlyPromptAnswersDoNotPersist();
	await testPersistedPromptAnswersWorkForApprovalAndDenial();
	await testBootstrapGatesUntrustedProjects();
	await testTrustChangeReloadsProjectSettings();
	await testResolverRunsOnceAfterUntrustedBootstrap();
	await testDenialKeepsProjectResourcesGated();
	await testTrustStateSurvivesRepeatedReloads();
	console.log("project trust regression: all assertions passed");
} finally {
	rmSync(TMP_ROOT, { recursive: true, force: true });
}
