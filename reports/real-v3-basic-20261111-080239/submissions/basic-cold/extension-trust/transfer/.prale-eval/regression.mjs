/**
 * Regression: an explicit project-trust decision made after bootstrap must be
 * transferred to the settings manager before the final resource resolution.
 *
 * Exercises the real DefaultResourceLoader.reload() from the coding-agent
 * package with boundary fakes for the settings manager, package manager and
 * extension loader. No dependencies, no filesystem writes.
 *
 * Fault covered: reload() hard-coded setProjectTrusted(false) after the trust
 * callback resolved, so an explicit "trust" decision was discarded: project
 * settings were never reloaded and project extensions stayed excluded.
 */
import assert from "node:assert/strict";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModule } from "./subject.mjs";

const root = pathResolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = join(root, ".prale-eval", "regression-sandbox");
const cwd = join(sandbox, "project");
const agentDir = join(sandbox, "agent");
const projectExtensionPath = join(cwd, ".pi", "extensions", "project.ts");
const userExtensionPath = join(agentDir, "extensions", "user.ts");

const log = [];
const extensionLoads = new Map();
const packageManagerResolves = [];

function asExtension(extensionPath) {
	return {
		path: extensionPath,
		resolvedPath: extensionPath,
		commands: new Map(),
		tools: new Map(),
		flags: new Map(),
	};
}

class FakeSettingsManager {
	constructor(globalSettings, projectSettings) {
		this.globalSettings = globalSettings;
		this.projectSettingsSource = projectSettings;
		this.projectTrusted = true;
		this.projectSettings = { ...projectSettings };
		this.settings = { ...globalSettings, ...projectSettings };
		this.reloads = 0;
	}

	isProjectTrusted() {
		return this.projectTrusted;
	}

	setProjectTrusted(trusted) {
		this.projectTrusted = trusted;
		log.push(`setProjectTrusted:${trusted}`);
		this.#applyProjectSettings();
	}

	async reload() {
		this.reloads += 1;
		log.push(`reload:${this.projectTrusted}`);
		this.#applyProjectSettings();
	}

	#applyProjectSettings() {
		this.projectSettings = this.projectTrusted ? { ...this.projectSettingsSource } : {};
		this.settings = { ...this.globalSettings, ...this.projectSettings };
	}

	getProjectSettings() {
		return { ...this.projectSettings };
	}
}

class FakePackageManager {
	constructor(options) {
		this.cwd = options.cwd;
		this.settingsManager = options.settingsManager;
	}

	async resolve() {
		const trusted = this.settingsManager.isProjectTrusted();
		const projectSettings = this.settingsManager.getProjectSettings();
		packageManagerResolves.push({ trusted, projectSettings, logIndex: log.length });
		log.push(`resolve:${trusted}`);
		const extensions = [
			{ path: userExtensionPath, enabled: true, metadata: { source: "local", scope: "user", origin: "top-level" } },
		];
		if (trusted) {
			extensions.unshift({
				path: projectExtensionPath,
				enabled: true,
				metadata: { source: "local", scope: "project", origin: "top-level" },
			});
		}
		return { extensions, skills: [], prompts: [], themes: [] };
	}

	async resolveExtensionSources() {
		return { extensions: [], skills: [], prompts: [], themes: [] };
	}
}

const bindings = {
	CONFIG_DIR_NAME: ".pi",
	default: { yellow: (message) => message },
	loadThemeFromPath: (themePath) => ({ name: "fake-theme", sourcePath: themePath }),
	canonicalizePath: (value) => pathResolve(value),
	isLocalPath: (value) => value.startsWith(".") || value.startsWith("/"),
	resolvePath: (value, base) => pathResolve(base ?? cwd, value),
	stripBom: (value) => value,
	createEventBus: () => ({}),
	clearExtensionCache: () => {},
	createExtensionRuntime: () => ({ pendingProviderRegistrations: [] }),
	loadExtensionFromFactory: async () => {
		throw new Error("no inline extension factories expected in this regression");
	},
	loadExtensionsCached: async (extensionPaths) => {
		const extensions = [];
		for (const extensionPath of extensionPaths) {
			const resolvedPath = pathResolve(cwd, extensionPath);
			extensionLoads.set(resolvedPath, (extensionLoads.get(resolvedPath) ?? 0) + 1);
			extensions.push(asExtension(resolvedPath));
		}
		return { extensions, errors: [], warnings: [], runtime: { pendingProviderRegistrations: [] } };
	},
	findGitPaths: () => undefined,
	DefaultPackageManager: FakePackageManager,
	loadPromptTemplates: () => ({ templates: [], diagnostics: [] }),
	SettingsManager: FakeSettingsManager,
	loadSkills: () => ({ skills: [], diagnostics: [] }),
	createSourceInfo: (path, metadata) => ({ path, ...metadata }),
	resetTimings: () => {},
};

const { DefaultResourceLoader } = await loadModule(root, "packages/coding-agent/src/core/resource-loader.ts", bindings);

function newSettingsManager() {
	return new FakeSettingsManager({ theme: "global" }, { defaultProjectTrust: "always", projectMarker: "loaded" });
}

function loadedExtensionPaths(extensionsResult) {
	// Array.from keeps the comparison in this realm; loader results are VM-realm arrays.
	return Array.from(extensionsResult.extensions, (extension) => extension.path);
}

function resetObservations() {
	log.length = 0;
	extensionLoads.clear();
	packageManagerResolves.length = 0;
}

async function reloadWithDecision(decision) {
	resetObservations();
	const settingsManager = newSettingsManager();
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	let bootstrapSnapshot;
	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			bootstrapSnapshot = {
				trusted: settingsManager.isProjectTrusted(),
				projectSettings: settingsManager.getProjectSettings(),
				extensionPaths: loadedExtensionPaths(extensionsResult),
			};
			return decision;
		},
	});
	return { settingsManager, loader, bootstrapSnapshot };
}

// --- Case 1: an explicit "trust" decision must survive the trust bootstrap. ---
{
	const { settingsManager, loader, bootstrapSnapshot } = await reloadWithDecision(true);

	assert.deepEqual(
		bootstrapSnapshot.extensionPaths,
		[userExtensionPath],
		"bootstrap must exclude project extensions while the decision is pending",
	);
	assert.equal(bootstrapSnapshot.trusted, false, "bootstrap must run with project settings disabled");
	assert.deepEqual(bootstrapSnapshot.projectSettings, {}, "bootstrap must not expose project settings");

	const finalResolve = packageManagerResolves.at(-1);
	assert.ok(finalResolve, "the final resource resolution must run");
	assert.equal(
		finalResolve.trusted,
		true,
		"an explicit trusted decision must be applied before the final resource resolution",
	);
	assert.equal(
		finalResolve.projectSettings.projectMarker,
		"loaded",
		"project settings must be reloaded for the trusted state before resolving resources",
	);
	assert.equal(settingsManager.isProjectTrusted(), true, "settings manager must stay trusted after reload()");

	assert.deepEqual(
		loadedExtensionPaths(loader.getExtensions()),
		[projectExtensionPath, userExtensionPath],
		"trusted projects must load project extensions in the final set",
	);
	assert.equal(
		extensionLoads.get(projectExtensionPath),
		1,
		"project extensions load exactly once, after trust is granted",
	);
	assert.equal(extensionLoads.get(userExtensionPath), 1, "user extensions are loaded once during bootstrap");

	const finalTrustSet = log.lastIndexOf("setProjectTrusted:true");
	const finalReload = log.lastIndexOf("reload:true");
	assert.ok(finalTrustSet >= 0, "the resolved trusted decision must be applied to the settings manager");
	assert.ok(finalReload > finalTrustSet, "settings must be reloaded after the trust decision is applied");
	assert.ok(
		finalResolve.logIndex > finalReload,
		"settings must be reloaded before the final resource resolution",
	);
}

// --- Case 2: an explicit "do not trust" decision must be honored as well. ---
{
	const { settingsManager, loader, bootstrapSnapshot } = await reloadWithDecision(false);

	assert.deepEqual(
		bootstrapSnapshot.extensionPaths,
		[userExtensionPath],
		"bootstrap must exclude project extensions while the decision is pending",
	);
	assert.equal(bootstrapSnapshot.trusted, false, "bootstrap must run with project settings disabled");

	const finalResolve = packageManagerResolves.at(-1);
	assert.ok(finalResolve, "the final resource resolution must run");
	assert.equal(finalResolve.trusted, false, "an explicit untrusted decision must be applied before resolution");
	assert.deepEqual(finalResolve.projectSettings, {}, "project settings stay unavailable when untrusted");
	assert.equal(settingsManager.isProjectTrusted(), false, "settings manager must stay untrusted after reload()");
	assert.deepEqual(
		loadedExtensionPaths(loader.getExtensions()),
		[userExtensionPath],
		"untrusted projects must keep project extensions excluded",
	);
}

console.log("extension-trust/transfer regression passed");
