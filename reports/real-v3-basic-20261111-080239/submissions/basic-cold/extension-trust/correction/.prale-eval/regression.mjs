/**
 * Regression: DefaultResourceLoader.reload() must consult the project trust resolver.
 *
 * Contract exercised here (see packages/coding-agent/src/core/resource-loader.ts):
 *  1. reload({ resolveProjectTrust }) first performs an untrusted bootstrap load of
 *     extensions and hands that LoadExtensionsResult to the resolver,
 *  2. the resolver is called exactly once and awaited before the trusted load runs,
 *  3. a `true` decision lets project-scoped resources load, a `false` decision denies
 *     them, and an already-saved decision is honoured without a resolver.
 *
 * The real TypeScript module is evaluated with boundary fakes for its imports
 * (settings manager, package manager, extension loader, etc.).
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadModule } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOADER_MODULE = "packages/coding-agent/src/core/resource-loader.ts";

// Non-existent fixture paths: they are only used as path strings, never touched on disk.
const CWD = path.join(root, ".prale-eval", "fixtures", "project");
const AGENT_DIR = path.join(root, ".prale-eval", "fixtures", "agent");
const USER_EXTENSION = path.join(AGENT_DIR, "extensions", "user.ts");
const PROJECT_EXTENSION = path.join(CWD, ".pi", "extensions", "project.ts");

function createExtension(extensionPath) {
	return {
		path: extensionPath,
		resolvedPath: path.resolve(extensionPath),
		sourceInfo: undefined,
		handlers: new Map(),
		tools: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
	};
}

/** Build boundary fakes plus a fresh VM module graph around the real resource loader. */
async function createHarness({ trusted = false } = {}) {
	const state = {
		trusted,
		events: [],
		resolverCalls: 0,
		resolverInputs: [],
		resolveCalls: [],
		loadCalls: [],
		settingsReloads: 0,
	};

	const settingsManager = {
		isProjectTrusted: () => state.trusted,
		setProjectTrusted: (value) => {
			state.trusted = value;
			state.events.push(`settings.trusted=${value}`);
		},
		reload: async () => {
			state.settingsReloads += 1;
			state.events.push(`settings.reload(trusted=${state.trusted})`);
		},
		getDefaultProjectTrust: () => "ask",
	};

	// Mirrors DefaultPackageManager: project-scoped resources are withheld unless the
	// settings manager is in a trusted state.
	class FakePackageManager {
		constructor(options) {
			this.settingsManager = options.settingsManager;
		}

		async resolve() {
			const isTrusted = this.settingsManager.isProjectTrusted() === true;
			state.resolveCalls.push(isTrusted);
			state.events.push(`packageManager.resolve(trusted=${isTrusted})`);
			const paths = isTrusted ? [PROJECT_EXTENSION, USER_EXTENSION] : [USER_EXTENSION];
			return {
				extensions: paths.map((resourcePath) => ({
					path: resourcePath,
					enabled: true,
					metadata: {
						source: "auto",
						scope: resourcePath === PROJECT_EXTENSION ? "project" : "user",
						origin: "package",
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
		// chalk default import
		default: { yellow: (value) => value, red: (value) => value, dim: (value) => value },
		CONFIG_DIR_NAME: ".pi",
		loadThemeFromPath: () => {
			throw new Error("unexpected theme load");
		},
		canonicalizePath: (value) => path.resolve(String(value)),
		isLocalPath: (value) => !/^(npm:|git:|github:|https?:|ssh:)/.test(String(value).trim()),
		resolvePath: (input, baseDir = root, options = {}) => {
			const normalized = options.trim ? String(input).trim() : String(input);
			return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(baseDir, normalized);
		},
		stripBom: (value) => String(value).replace(/^\uFEFF/, ""),
		createEventBus: () => ({ emit: () => {}, on: () => () => {} }),
		clearExtensionCache: () => {},
		createExtensionRuntime: () => ({ id: "runtime" }),
		loadExtensionFromFactory: async (_factory, _cwd, _eventBus, _runtime, extensionPath) =>
			createExtension(extensionPath),
		loadExtensionsCached: async (extensionPaths, _cwd, _eventBus, runtime) => {
			state.loadCalls.push([...extensionPaths]);
			state.events.push(`loadExtensions(${extensionPaths.length})`);
			return {
				extensions: extensionPaths.map(createExtension),
				errors: [],
				warnings: [],
				runtime: runtime ?? { id: "runtime" },
			};
		},
		findGitPaths: () => undefined,
		DefaultPackageManager: FakePackageManager,
		loadPromptTemplates: () => ({ templates: [], diagnostics: [] }),
		SettingsManager: { create: () => settingsManager },
		loadSkills: () => ({ skills: [], diagnostics: [] }),
		createSourceInfo: (resourcePath, metadata) => ({ path: resourcePath, ...metadata }),
		resetTimings: () => {},
	};

	const { DefaultResourceLoader } = await loadModule(root, LOADER_MODULE, bindings);
	assert.equal(typeof DefaultResourceLoader, "function", "real resource loader module did not load");

	const loader = new DefaultResourceLoader({
		cwd: CWD,
		agentDir: AGENT_DIR,
		settingsManager,
		noContextFiles: true,
	});

	return { loader, state };
}

function extensionPaths(loader) {
	return Array.from(loader.getExtensions().extensions, (extension) => extension.path).sort();
}

/** Assert the resolver observed the untrusted bootstrap pass and ran exactly once. */
function assertResolverSawUntrustedBootstrap(state, label) {
	assert.equal(state.resolverCalls, 1, `${label}: project trust resolver must be consulted exactly once`);
	const input = state.resolverInputs[0];
	assert.equal(
		input.trusted,
		false,
		`${label}: resolver must observe the untrusted bootstrap result, saw trusted=${input.trusted}`,
	);
	assert.deepEqual(
		input.paths,
		[USER_EXTENSION],
		`${label}: bootstrap load must contain user resources only (no project resources)`,
	);
}

async function reloadWithResolver(decision, label) {
	const harness = await createHarness({ trusted: false });
	await harness.loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			harness.state.resolverCalls += 1;
			harness.state.resolverInputs.push({
				trusted: harness.state.trusted,
				paths: Array.from(extensionsResult.extensions, (extension) => extension.path).sort(),
			});
			harness.state.events.push("trustResolver.start");
			// Async gap: the reload must not continue before this settles.
			await new Promise((resolve) => setTimeout(resolve, 25));
			harness.state.events.push("trustResolver.end");
			return decision;
		},
	});
	return { ...harness, label };
}

// ---------------------------------------------------------------------------
// Scenario 1: resolver approves -> project resources load, in async order.
// ---------------------------------------------------------------------------
{
	const { loader, state, label } = await reloadWithResolver(true, "trusted decision");
	assertResolverSawUntrustedBootstrap(state, label);
	assert.equal(state.trusted, true, `${label}: approved decision must update the settings manager trust state`);
	assert.deepEqual(
		extensionPaths(loader),
		[PROJECT_EXTENSION, USER_EXTENSION].sort(),
		`${label}: approved project resources must be loaded after the resolver returns true`,
	);

	const order = state.events;
	const bootstrapResolve = order.indexOf("packageManager.resolve(trusted=false)");
	const resolverStart = order.indexOf("trustResolver.start");
	const resolverEnd = order.indexOf("trustResolver.end");
	const trustedResolve = order.indexOf("packageManager.resolve(trusted=true)");
	assert.ok(bootstrapResolve !== -1, `${label}: no untrusted bootstrap resolve was performed`);
	assert.ok(resolverStart !== -1 && resolverEnd !== -1, `${label}: resolver never ran`);
	assert.ok(trustedResolve !== -1, `${label}: no trusted resource resolve was performed`);
	assert.ok(
		bootstrapResolve < resolverStart,
		`${label}: resolver must be invoked after the untrusted bootstrap load`,
	);
	assert.ok(
		resolverEnd < trustedResolve,
		`${label}: project resources resolved before the async trust decision settled (${order.join(" -> ")})`,
	);
	assert.equal(
		state.loadCalls.flat().filter((loadedPath) => loadedPath === USER_EXTENSION).length,
		1,
		`${label}: user extension must be loaded once and reused across the trust boundary`,
	);
}

// ---------------------------------------------------------------------------
// Scenario 2: resolver denies -> project resources stay out, user ones remain.
// ---------------------------------------------------------------------------
{
	const { loader, state, label } = await reloadWithResolver(false, "denied decision");
	assertResolverSawUntrustedBootstrap(state, label);
	assert.equal(state.trusted, false, `${label}: denied decision must leave the settings manager untrusted`);
	assert.deepEqual(
		extensionPaths(loader),
		[USER_EXTENSION],
		`${label}: denied project resources must not be loaded`,
	);
	assert.equal(
		state.loadCalls.flat().filter((loadedPath) => loadedPath === PROJECT_EXTENSION).length,
		0,
		`${label}: project extension must never be loaded after a false decision`,
	);
}

// ---------------------------------------------------------------------------
// Scenario 3: a saved decision is honoured without calling any resolver.
// ---------------------------------------------------------------------------
{
	for (const trusted of [true, false]) {
		const harness = await createHarness({ trusted });
		await harness.loader.reload();
		assert.equal(
			harness.state.resolverCalls,
			0,
			`no-resolver reload: resolver must not be invoked when reload has no resolveProjectTrust option`,
		);
		assert.equal(harness.state.trusted, trusted, "no-resolver reload: saved trust decision must be preserved");
		assert.deepEqual(
			extensionPaths(harness.loader),
			trusted ? [PROJECT_EXTENSION, USER_EXTENSION].sort() : [USER_EXTENSION],
			`no-resolver reload: saved trusted=${trusted} decision must gate project resources consistently`,
		);
	}
}

console.log("resource-loader project trust regression: all scenarios passed");
