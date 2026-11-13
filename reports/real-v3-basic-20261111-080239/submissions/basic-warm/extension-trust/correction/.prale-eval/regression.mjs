/**
 * Regression for extension-trust/correction.
 *
 * Fault: DefaultResourceLoader.reload() hard-coded the project trust decision to
 * `false` and never consulted the injected `resolveProjectTrust` callback, so
 * project-scoped extensions could never be loaded even though policy allows them
 * after a `true` decision, and the resolver never observed the untrusted
 * bootstrap pass.
 *
 * The script loads the real production module
 * (packages/coding-agent/src/core/resource-loader.ts) with boundary fakes for
 * settings, package resolution and extension loading, then drives reload() with
 * a resolver that returns `true` and one that returns `false`.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { createGraph } from "./subject.mjs";

const root = path.resolve(import.meta.dirname, "..");
const LOADER_MODULE = "packages/coding-agent/src/core/resource-loader.ts";

// Virtual (never created on disk) resource locations inside the workspace.
const projectCwd = path.join(root, "virtual-project");
const agentDir = path.join(root, "virtual-agent");
const projectExtensionPath = path.join(projectCwd, ".pi", "extensions", "project.ts");
const userExtensionPath = path.join(agentDir, "extensions", "user.ts");

function makeState() {
	const settings = new FakeSettingsManager(false);
	return {
		log: [],
		settings,
		runtime: { commands: [], tools: [], flags: [] },
		packageManager: undefined,
	};
}

class FakeSettingsManager {
	constructor(initialTrusted) {
		this.trusted = initialTrusted === true;
		this.reloads = 0;
	}

	static create() {
		return new FakeSettingsManager(false);
	}

	isProjectTrusted() {
		return this.trusted;
	}

	setProjectTrusted(trusted) {
		this.trusted = trusted === true;
		state.log.push(`setProjectTrusted:${this.trusted}`);
	}

	async reload() {
		this.reloads += 1;
		state.log.push(`settings.reload:${this.trusted ? "trusted" : "untrusted"}`);
		// Yield so any ordering bug around the asynchronous trust resolution shows up.
		await Promise.resolve();
	}

	getDefaultProjectTrust() {
		return "ask";
	}
}

function resource(resourcePath, scope) {
	return {
		path: resourcePath,
		enabled: true,
		metadata: { source: "local", scope, origin: "top-level" },
	};
}

/** Boundary fake: project extension is only visible once the project is trusted. */
class FakePackageManager {
	constructor(options) {
		this.options = options;
		state.packageManager = this;
	}

	async resolve() {
		const trusted = this.options.settingsManager.isProjectTrusted();
		state.log.push(`packageManager.resolve:${trusted ? "trusted" : "untrusted"}`);
		return {
			extensions: trusted
				? [resource(projectExtensionPath, "project"), resource(userExtensionPath, "user")]
				: [resource(userExtensionPath, "user")],
			skills: [],
			prompts: [],
			themes: [],
		};
	}

	async resolveExtensionSources() {
		return { extensions: [], skills: [], prompts: [], themes: [] };
	}
}

let state;

function fakeExtension(extensionPath) {
	return {
		path: extensionPath,
		resolvedPath: extensionPath,
		commands: new Map(),
		tools: new Map(),
		flags: new Map(),
	};
}

function makeBindings() {
	return {
		// chalk (default import): only used for warning text.
		default: { yellow: (text) => String(text), green: (text) => String(text) },
		CONFIG_DIR_NAME: ".pi",
		loadThemeFromPath: (themePath) => {
			throw new Error(`unexpected theme load: ${themePath}`);
		},
		canonicalizePath: (value) => path.resolve(value),
		isLocalPath: (value) => path.isAbsolute(value) || /^[.~@]/.test(value),
		resolvePath: (value, cwd) => (path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd ?? root, value)),
		stripBom: (text) => (text.startsWith("\uFEFF") ? text.slice(1) : text),
		createEventBus: () => ({ emit() {}, on: () => () => {}, clear() {} }),
		clearExtensionCache: () => {},
		createExtensionRuntime: () => ({ ...state.runtime }),
		loadExtensionFromFactory: () => {
			throw new Error("unexpected inline extension factory");
		},
		loadExtensionsCached: async (extensionPaths) => {
			state.log.push(`loadExtensions:${extensionPaths.length}`);
			return {
				extensions: extensionPaths.map((extensionPath) => fakeExtension(extensionPath)),
				errors: [],
				warnings: [],
				runtime: state.runtime,
			};
		},
		findGitPaths: () => undefined,
		DefaultPackageManager: FakePackageManager,
		loadPromptTemplates: () => ({ templates: [], diagnostics: [] }),
		SettingsManager: FakeSettingsManager,
		loadSkills: () => ({ skills: [], diagnostics: [] }),
		createSourceInfo: (sourcePath, metadata) => ({ path: sourcePath, ...metadata }),
		resetTimings: () => {},
	};
}

async function reloadWithDecision(decision) {
	state = makeState();
	const graph = createGraph(root, [LOADER_MODULE], makeBindings());
	const loaderModule = await graph.module(LOADER_MODULE);
	const loader = new loaderModule.DefaultResourceLoader({
		cwd: projectCwd,
		agentDir,
		settingsManager: state.settings,
		noContextFiles: true,
	});

	const resolverCalls = [];
	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			resolverCalls.push({
				trustedAtCall: state.settings.isProjectTrusted(),
				extensionPaths: Array.from(extensionsResult.extensions, (extension) => extension.path),
			});
			state.log.push("resolver:start");
			// Resolver is asynchronous: the decision must be awaited before it is applied.
			await new Promise((resolve) => setTimeout(resolve, 5));
			state.log.push("resolver:end");
			return decision;
		},
	});

	return {
		state,
		resolverCalls,
		finalExtensionPaths: Array.from(loader.getExtensions().extensions, (extension) => extension.path),
		finalTrusted: state.settings.isProjectTrusted(),
	};
}

function indexOfLast(log, entry) {
	for (let index = log.length - 1; index >= 0; index -= 1) {
		if (log[index] === entry) return index;
	}
	return -1;
}

// --- Scenario 1: resolver says "trusted" -> project resources are allowed. ---
{
	const run = await reloadWithDecision(true);

	assert.equal(
		run.resolverCalls.length,
		1,
		`reload() must consult the trust resolver exactly once, got ${run.resolverCalls.length} call(s). Log: ${run.state.log.join(" | ")}`,
	);
	const [call] = run.resolverCalls;
	assert.equal(
		call.trustedAtCall,
		false,
		"the resolver must observe the untrusted bootstrap pass (settings were already trusted when it ran)",
	);
	assert.deepEqual(
		call.extensionPaths,
		[userExtensionPath],
		"the bootstrap (pre-trust) extension set handed to the resolver must exclude project extensions",
	);
	assert.deepEqual(
		run.finalExtensionPaths,
		[projectExtensionPath, userExtensionPath],
		"a true trust decision must load project resources (project extension first, then user extension)",
	);
	assert.equal(run.finalTrusted, true, "a true trust decision must be applied to the settings manager");

	const bootstrapTrustIndex = indexOfLast(run.state.log, "setProjectTrusted:false");
	const resolverEndIndex = indexOfLast(run.state.log, "resolver:end");
	const appliedTrustIndex = indexOfLast(run.state.log, "setProjectTrusted:true");
	assert.notEqual(bootstrapTrustIndex, -1, `bootstrap pass must force untrusted settings. Log: ${run.state.log.join(" | ")}`);
	assert.notEqual(resolverEndIndex, -1, `resolver must be awaited. Log: ${run.state.log.join(" | ")}`);
	assert.ok(
		bootstrapTrustIndex < resolverEndIndex,
		`bootstrap untrusted state must precede the resolver. Log: ${run.state.log.join(" | ")}`,
	);
	assert.ok(
		appliedTrustIndex > resolverEndIndex,
		`the trust decision must be applied after the resolver settles. Log: ${run.state.log.join(" | ")}`,
	);
}

// --- Scenario 2: resolver says "untrusted" -> project resources stay out. ---
{
	const run = await reloadWithDecision(false);

	assert.equal(
		run.resolverCalls.length,
		1,
		`reload() must consult the trust resolver exactly once, got ${run.resolverCalls.length} call(s). Log: ${run.state.log.join(" | ")}`,
	);
	const [call] = run.resolverCalls;
	assert.equal(call.trustedAtCall, false, "the resolver must observe the untrusted bootstrap pass");
	assert.deepEqual(
		call.extensionPaths,
		[userExtensionPath],
		"the bootstrap extension set must contain only user/global extensions",
	);
	assert.deepEqual(
		run.finalExtensionPaths,
		[userExtensionPath],
		"a false trust decision must keep project extensions unloaded",
	);
	assert.equal(run.finalTrusted, false, "a false trust decision must be applied to the settings manager");

	const resolverEndIndex = indexOfLast(run.state.log, "resolver:end");
	const appliedTrustIndex = indexOfLast(run.state.log, "setProjectTrusted:false");
	assert.ok(
		appliedTrustIndex > resolverEndIndex,
		`the false decision must be applied after the resolver settles. Log: ${run.state.log.join(" | ")}`,
	);
	assert.ok(
		run.state.log.includes("packageManager.resolve:untrusted"),
		`project resources must be resolved untrusted when the decision is false. Log: ${run.state.log.join(" | ")}`,
	);
}

console.log("extension-trust/correction regression: all assertions passed");
