/**
 * Regression: project extensions must never leak into the trust-bootstrap extension set.
 *
 * `DefaultResourceLoader.loadProjectTrustExtensions()` is the pass that runs BEFORE the
 * project trust decision is known. It must force the settings manager into the *untrusted*
 * state (and reload settings in that state) before resolving packages and loading
 * extensions, otherwise project-local extensions execute before the user is ever asked
 * about trust. This must hold even when the settings manager was previously trusted.
 * User/global extensions and temporary CLI extensions must survive the bootstrap pass.
 *
 * The production module (packages/coding-agent/src/core/resource-loader.ts) is loaded as
 * real code through .prale-eval/subject.mjs; every collaborator on the boundary is faked.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { loadModule } from "./subject.mjs";

const root = process.cwd();
const RESOURCE_LOADER = "packages/coding-agent/src/core/resource-loader.ts";

// ---------------------------------------------------------------------------
// Boundary fakes
// ---------------------------------------------------------------------------

const fakeCwd = path.join(root, "fake-project");
const fakeAgentDir = path.join(root, "fake-agent-dir");
const globalExtension = path.join(fakeAgentDir, "extensions", "global-ext.ts");
const projectExtension = path.join(fakeCwd, ".pi", "extensions", "project-ext.ts");
const cliExtension = path.join(root, "fake-cli", "cli-ext.ts");

function resource(filePath, scope) {
	return {
		path: filePath,
		enabled: true,
		metadata: { source: "local", scope, origin: "top-level" },
	};
}

function fakeExtension(filePath) {
	return {
		path: filePath,
		resolvedPath: filePath,
		commands: new Map(),
		tools: new Map(),
		flags: new Map(),
	};
}

/**
 * Minimal stand-in for SettingsManager that mirrors the real trust semantics:
 * project settings only contribute to effective settings while the project is trusted,
 * and setProjectTrusted() is a no-op for an unchanged trust state.
 */
class FakeSettingsManager {
	constructor({ trusted, globalExtensions, projectExtensions }) {
		this.trusted = trusted;
		this.globalSettings = { extensions: [...globalExtensions] };
		this.projectSettings = { extensions: [...projectExtensions] };
		this.events = [];
	}

	isProjectTrusted() {
		return this.trusted;
	}

	setProjectTrusted(trusted) {
		this.events.push(`setProjectTrusted:${trusted}`);
		if (this.trusted === trusted) return;
		this.trusted = trusted;
	}

	async reload() {
		this.events.push(`reload:trusted=${this.trusted}`);
	}

	getSettings() {
		return {
			extensions: [
				...this.globalSettings.extensions,
				...(this.trusted ? this.projectSettings.extensions : []),
			],
		};
	}
}

/** Records every package-resolution pass together with the trust state it observed. */
const resolutionLog = [];
/** Records the extension paths handed to the extension loader, per pass. */
const extensionLoadLog = [];

class FakePackageManager {
	constructor(options) {
		this.settingsManager = options.settingsManager;
	}

	async resolve() {
		const settings = this.settingsManager.getSettings();
		const trustAtResolve = this.settingsManager.isProjectTrusted();
		resolutionLog.push({ trust: trustAtResolve, extensions: [...settings.extensions] });
		return {
			extensions: settings.extensions.map((filePath) =>
				filePath === projectExtension ? resource(filePath, "project") : resource(filePath, "global"),
			),
			skills: [],
			prompts: [],
			themes: [],
		};
	}

	async resolveExtensionSources(paths) {
		return {
			extensions: paths.map((filePath) => resource(filePath, "temporary")),
			skills: [],
			prompts: [],
			themes: [],
		};
	}
}

const bindings = {
	chalk: { yellow: (text) => String(text) },
	CONFIG_DIR_NAME: ".pi",
	loadThemeFromPath: () => ({ name: "fake" }),
	canonicalizePath: (value) => path.resolve(root, value),
	isLocalPath: () => false,
	resolvePath: (value, base) => path.resolve(base ?? root, value),
	stripBom: (value) => (value.startsWith("\ufeff") ? value.slice(1) : value),
	createEventBus: () => ({ on: () => {}, emit: () => {}, off: () => {} }),
	clearExtensionCache: () => {},
	createExtensionRuntime: () => ({ flags: new Map(), shortcuts: new Map() }),
	loadExtensionFromFactory: async () => {
		throw new Error("inline extension factories are not used by this regression");
	},
	loadExtensionsCached: async (extensionPaths, _cwd, _eventBus, runtime) => {
		extensionLoadLog.push([...extensionPaths]);
		return {
			extensions: extensionPaths.map(fakeExtension),
			errors: [],
			warnings: [],
			runtime: runtime ?? { flags: new Map(), shortcuts: new Map() },
		};
	},
	findGitPaths: () => undefined,
	DefaultPackageManager: FakePackageManager,
	loadPromptTemplates: () => ({ templates: [], diagnostics: [] }),
	loadSkills: () => ({ skills: [], diagnostics: [] }),
	createSourceInfo: (sourcePath, metadata) => ({ path: sourcePath, ...metadata }),
	resetTimings: () => {},
	SettingsManager: class SettingsManager {},
};

function createLoader(resourceLoader, settingsManager) {
	return new resourceLoader.DefaultResourceLoader({
		cwd: fakeCwd,
		agentDir: fakeAgentDir,
		settingsManager,
		additionalExtensionPaths: [cliExtension],
		noContextFiles: true,
	});
}

function resetLogs() {
	resolutionLog.length = 0;
	extensionLoadLog.length = 0;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const resourceLoader = await loadModule(root, RESOURCE_LOADER, bindings);

// 1. Bootstrap pass forces untrusted settings even when the previous state was trusted.
{
	resetLogs();
	const settings = new FakeSettingsManager({
		trusted: true, // previous state: trusted
		globalExtensions: [globalExtension],
		projectExtensions: [projectExtension],
	});
	const loader = createLoader(resourceLoader, settings);

	const bootstrap = await loader.loadProjectTrustExtensions();
	const bootstrapPaths = [...bootstrap.extensions.map((extension) => extension.path)];

	assert.deepEqual(
		bootstrapPaths.sort(),
		[cliExtension, globalExtension].sort(),
		`trust bootstrap must load only CLI and user/global extensions, got ${JSON.stringify(bootstrapPaths)}`,
	);
	assert.ok(
		!bootstrapPaths.includes(projectExtension),
		`trust bootstrap must not load the project extension before the trust decision`,
	);
	assert.equal(
		settings.isProjectTrusted(),
		false,
		"trust bootstrap must leave the settings manager in the untrusted state while loading extensions",
	);
	const firstReload = settings.events.findIndex((event) => event.startsWith("reload:"));
	assert.ok(firstReload > 0, `bootstrap must force project trust before reloading, got ${JSON.stringify(settings.events)}`);
	assert.ok(
		settings.events.slice(0, firstReload).includes("setProjectTrusted:false"),
		`bootstrap must force untrusted settings *before* reloading them, got ${JSON.stringify(settings.events)}`,
	);
	assert.equal(
		settings.events[firstReload],
		"reload:trusted=false",
		`the bootstrap settings reload must happen in the untrusted state, got ${JSON.stringify(settings.events)}`,
	);
	assert.ok(
		resolutionLog.length > 0 && resolutionLog.every((entry) => entry.trust === false),
		`package resolution during the bootstrap must observe an untrusted project, got ${JSON.stringify(resolutionLog)}`,
	);
}

// 2. Untrusted bootstrap stays untrusted even when it is entered from a trusted state,
//    and the full reload keeps project extensions out of the trust-deciding pass while
//    restoring them once trust is granted.
{
	resetLogs();
	const settings = new FakeSettingsManager({
		trusted: true, // previous state: trusted -- must not short-circuit the forcing
		globalExtensions: [globalExtension],
		projectExtensions: [projectExtension],
	});
	const loader = createLoader(resourceLoader, settings);

	let extensionsSeenByTrustResolver;
	let trustStateSeenByTrustResolver;
	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			extensionsSeenByTrustResolver = [...extensionsResult.extensions.map((extension) => extension.path)];
			trustStateSeenByTrustResolver = settings.isProjectTrusted();
			return true;
		},
	});

	assert.equal(
		trustStateSeenByTrustResolver,
		false,
		"the project must still be untrusted when the trust decision is made",
	);
	assert.deepEqual(
		extensionsSeenByTrustResolver.sort(),
		[cliExtension, globalExtension].sort(),
		`trust resolution must only see CLI and user/global extensions, got ${JSON.stringify(extensionsSeenByTrustResolver)}`,
	);

	const finalPaths = [...loader.getExtensions().extensions.map((extension) => extension.path)];
	assert.ok(
		finalPaths.includes(projectExtension),
		`project extension must load after trust is granted, got ${JSON.stringify(finalPaths)}`,
	);
	assert.ok(finalPaths.includes(globalExtension), "user/global extension must remain available");
	assert.ok(finalPaths.includes(cliExtension), "CLI extension must remain available");

	// The post-bootstrap pass is what may see the trusted project settings.
	const lastResolution = resolutionLog[resolutionLog.length - 1];
	assert.equal(lastResolution.trust, true, "the final resolution pass runs with the resolved trust state");
}

// 3. Bootstrap never escalates trust: starting from untrusted must not become trusted.
{
	resetLogs();
	const settings = new FakeSettingsManager({
		trusted: false,
		globalExtensions: [globalExtension],
		projectExtensions: [projectExtension],
	});
	const loader = createLoader(resourceLoader, settings);

	const bootstrap = await loader.loadProjectTrustExtensions();
	const bootstrapPaths = [...bootstrap.extensions.map((extension) => extension.path)];
	assert.deepEqual(
		bootstrapPaths.sort(),
		[cliExtension, globalExtension].sort(),
		`trust bootstrap from an untrusted state must not pick up project extensions, got ${JSON.stringify(bootstrapPaths)}`,
	);
	assert.equal(settings.isProjectTrusted(), false, "trust bootstrap must not escalate project trust");
}

console.log("regression: trust bootstrap excludes project extensions (3 scenarios)");
