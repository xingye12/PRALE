/**
 * Executable regression for: "Remembered denial and configuration precedence disagree".
 *
 * Loads the submitted production modules through the read-only subject helper
 * (`createResourcePipeline` / `createGraph`), so project-trust, SettingsManager and
 * DefaultResourceLoader all run their real implementations. Only external boundaries
 * (storage, package resolution, extension loading, trust UI) are faked.
 *
 * Run with: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { createGraph, createResourcePipeline } from './subject.mjs';

const root = process.cwd();
const names = (pipeline) => [...pipeline.loader.getExtensions().extensions].map((e) => path.basename(e.path));

/** In-memory SettingsStorage fixture mirroring the real storage contract. */
function createStorage(global, project) {
	const data = {
		global: global === undefined ? undefined : JSON.stringify(global),
		project: project === undefined ? undefined : JSON.stringify(project),
	};
	const writes = [];
	return {
		data,
		writes,
		withLock(scope, fn) {
			const next = fn(data[scope]);
			if (next !== undefined) {
				writes.push(scope);
				data[scope] = next;
			}
		},
	};
}

const GLOBAL_SETTINGS = {
	defaultModel: 'global-model',
	extensions: ['global'],
	compaction: { reserveTokens: 8192, keepRecentTokens: 2000 },
};
const PROJECT_SETTINGS = {
	defaultModel: 'project-model',
	extensions: ['project'],
	compaction: { reserveTokens: 4096 },
};

/** Reusable graph whose SettingsManager imports are wired to local, faked boundaries. */
async function settingsModule() {
	const graph = createGraph(root, {
		APP_NAME: 'pi',
		CONFIG_DIR_NAME: '.pi',
		getAgentDir: () => path.join(root, '.fixture-agent'),
		DEFAULT_MAX_AGENT_RETRY_DELAY_MS: 60000,
		DEFAULT_HTTP_IDLE_TIMEOUT_MS: 60000,
		parseHttpIdleTimeoutMs: (value) => value,
	});
	const { SettingsManager } = await graph.module('settings');
	return SettingsManager;
}

/** Real resolver with a faked trust store / extension decision / UI. */
async function projectModule() {
	const graph = createGraph(root, {
		APP_NAME: 'pi',
		CONFIG_DIR_NAME: '.pi',
		hasTrustRequiringProjectResources: () => true,
		emitProjectTrustEvent: async () => ({ result: undefined, errors: [] }),
		getProjectTrustOptions: () => [{ label: 'approve once', trusted: true, updates: [] }],
	});
	const { resolveProjectTrusted } = await graph.module('project');
	return resolveProjectTrusted;
}

function fakeTrustStore(store = {}) {
	const writes = [];
	return {
		writes,
		get: (cwd) => store[cwd] ?? null,
		set: (...args) => writes.push(args),
		setMany: (...args) => writes.push(args),
	};
}

// ---------------------------------------------------------------------------
// 1. Resolver: a stored boolean is authoritative, denials included.
// ---------------------------------------------------------------------------
const resolveProjectTrusted = await projectModule();

{
	const deniedStore = fakeTrustStore({ [root]: false });
	const allowedStore = fakeTrustStore({ [root]: true });
	const emptyStore = fakeTrustStore();

	// Stored denial must win over an allow-by-default policy...
	assert.equal(
		await resolveProjectTrusted({
			cwd: root,
			trustStore: deniedStore,
			defaultProjectTrust: 'always',
			projectTrustContext: { hasUI: true, ui: { select: async () => 'approve once' } },
		}),
		false,
		'a remembered denial must not fall through to the allow-by-default policy',
	);
	// ...and must not be overridden by an interactive approval prompt.
	assert.equal(
		await resolveProjectTrusted({
			cwd: root,
			trustStore: deniedStore,
			defaultProjectTrust: 'ask',
			projectTrustContext: { hasUI: true, ui: { select: async () => 'approve once' } },
		}),
		false,
		'a remembered denial must not be re-prompted into an approval',
	);
	assert.deepEqual(deniedStore.writes, [], 'resolving a stored denial must not write trust');

	// A remembered approval is equally authoritative.
	assert.equal(
		await resolveProjectTrusted({
			cwd: root,
			trustStore: allowedStore,
			defaultProjectTrust: 'never',
			projectTrustContext: { hasUI: false, ui: { select: async () => undefined } },
		}),
		true,
		'a remembered approval must not fall through to a deny-by-default policy',
	);

	// Only an absent decision defers to the configured policy.
	assert.equal(
		await resolveProjectTrusted({
			cwd: root,
			trustStore: emptyStore,
			defaultProjectTrust: 'always',
			projectTrustContext: { hasUI: false, ui: { select: async () => undefined } },
		}),
		true,
		'the default policy applies only when no decision was stored',
	);
	assert.equal(
		await resolveProjectTrusted({
			cwd: root,
			trustStore: emptyStore,
			defaultProjectTrust: 'never',
			projectTrustContext: { hasUI: false, ui: { select: async () => undefined } },
		}),
		false,
		'the deny-by-default policy applies only when no decision was stored',
	);
	assert.equal(
		await resolveProjectTrusted({
			cwd: root,
			trustStore: emptyStore,
			defaultProjectTrust: 'ask',
			projectTrustContext: { hasUI: false, ui: { select: async () => undefined } },
		}),
		false,
		'ask-without-UI safely resolves untrusted',
	);
}

// ---------------------------------------------------------------------------
// 2. Settings: project values override global values only while trusted, and
//    nested global defaults survive the merge.
// ---------------------------------------------------------------------------
const SettingsManager = await settingsModule();

{
	const storage = createStorage(GLOBAL_SETTINGS, PROJECT_SETTINGS);
	const settings = SettingsManager.fromStorage(storage, { projectTrusted: true });

	assert.equal(settings.isProjectTrusted(), true);
	assert.equal(settings.getDefaultModel(), 'project-model', 'trusted project values must override global values');
	assert.equal(settings.getGlobalSettings().defaultModel, 'global-model', 'global values must stay intact');
	assert.equal(settings.getProjectSettings().defaultModel, 'project-model');
	assert.equal(settings.getCompactionReserveTokens(), 4096, 'project nested value must override the global one');
	assert.equal(
		settings.getCompactionKeepRecentTokens(),
		2000,
		'nested global defaults must survive a partial project override',
	);
	assert.deepEqual({ ...settings.getCompactionSettings() }, {
		enabled: true,
		reserveTokens: 4096,
		keepRecentTokens: 2000,
	});

	// Overrides layer on top of the trusted merge without dropping sibling defaults.
	settings.applyOverrides({ defaultModel: 'override-model', compaction: { reserveTokens: 1024 } });
	assert.equal(settings.getDefaultModel(), 'override-model', 'session overrides must win over project values');
	assert.equal(settings.getCompactionReserveTokens(), 1024);
	assert.equal(
		settings.getCompactionKeepRecentTokens(),
		2000,
		'overrides must not drop nested values inherited from global settings',
	);

	// Trusting an untrusted manager loads project values again.
	const untrusted = SettingsManager.fromStorage(createStorage(GLOBAL_SETTINGS, PROJECT_SETTINGS), {
		projectTrusted: false,
	});
	assert.equal(untrusted.isProjectTrusted(), false);
	assert.deepEqual(Object.keys(untrusted.getProjectSettings()), [], 'untrusted project settings must not load');
	assert.equal(untrusted.getDefaultModel(), 'global-model', 'untrusted project values must not override global');
	assert.equal(untrusted.getCompactionReserveTokens(), 8192);
	assert.equal(untrusted.getCompactionKeepRecentTokens(), 2000);

	untrusted.setProjectTrusted(true);
	assert.equal(untrusted.getDefaultModel(), 'project-model', 'approval must reinstate project values');
	assert.equal(untrusted.getCompactionReserveTokens(), 4096);
	assert.equal(untrusted.getCompactionKeepRecentTokens(), 2000, 'nested global defaults must survive approval');

	// Losing trust must roll back to global values, nested defaults included.
	untrusted.setProjectTrusted(false);
	assert.deepEqual(Object.keys(untrusted.getProjectSettings()), []);
	assert.equal(untrusted.getDefaultModel(), 'global-model');
	assert.deepEqual({ ...untrusted.getCompactionSettings() }, {
		enabled: true,
		reserveTokens: 8192,
		keepRecentTokens: 2000,
	});

	// A reload in the trusted state keeps project configuration.
	const trusted = SettingsManager.fromStorage(createStorage(GLOBAL_SETTINGS, PROJECT_SETTINGS), {
		projectTrusted: true,
	});
	await trusted.reload();
	assert.equal(trusted.isProjectTrusted(), true);
	assert.equal(trusted.getDefaultModel(), 'project-model', 'an accepted reload must keep project configuration');
	assert.equal(trusted.getCompactionKeepRecentTokens(), 2000);
	assert.equal(trusted.getCompactionReserveTokens(), 4096);
}

// ---------------------------------------------------------------------------
// 3. Resource assembly: the resolved decision reaches settings and therefore
//    final resource selection.
// ---------------------------------------------------------------------------
{
	// Approved through the extension trust event: project resources must load.
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.extension = { trusted: 'yes' };
	const approved = await pipeline.reload();

	assert.equal(approved.calls, 1, 'the trust decision must be resolved exactly once per reload');
	assert.equal(pipeline.settings.isProjectTrusted(), true, 'the approval must reach SettingsManager');
	assert.deepEqual(names(pipeline), ['cli.ts', 'global.ts', 'project.ts'], 'approved project resources must load');
	assert.equal(pipeline.settings.getDefaultModel(), 'project-model', 'approved project configuration must apply');
	assert.equal(
		pipeline.settings.getCompactionKeepRecentTokens(),
		2000,
		'nested global defaults must survive the approved project merge',
	);
	const resolution = pipeline.events.filter(([kind]) => kind === 'resolve');
	assert.deepEqual(
		[...resolution.at(-1)],
		['resolve', true, 'project-model'],
		'package resolution must observe the approved trust state and project settings',
	);

	// A second, accepted reload keeps the project configuration.
	pipeline.scenario.extension = undefined;
	pipeline.scenario.stored = true;
	const again = await pipeline.reload();
	assert.equal(pipeline.settings.isProjectTrusted(), true, 'a subsequent reload must stay trusted');
	assert.deepEqual([...again.names], ['cli.ts', 'global.ts', 'project.ts'], 'accepted reloads must keep project resources');
	assert.equal(pipeline.settings.getDefaultModel(), 'project-model');
}

{
	// A remembered denial wins over an allow-by-default policy at the loader boundary.
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.stored = false;
	pipeline.scenario.policy = 'always';
	const denied = await pipeline.reload();

	assert.equal(pipeline.settings.isProjectTrusted(), false, 'the remembered denial must reach SettingsManager');
	assert.deepEqual([...denied.names], ['cli.ts', 'global.ts'], 'denied project resources must not load');
	assert.equal(pipeline.settings.getDefaultModel(), 'global-model');
	assert.deepEqual(Object.keys(pipeline.settings.getProjectSettings()), []);
}

{
	// No decision and no UI: untrusted defaults must exclude project resources.
	const pipeline = await createResourcePipeline(root);
	const untrusted = await pipeline.reload();
	assert.equal(pipeline.settings.isProjectTrusted(), false);
	assert.deepEqual([...untrusted.names], ['cli.ts', 'global.ts']);
}

{
	// A remembered approval wins over a deny-by-default policy.
	const pipeline = await createResourcePipeline(root);
	pipeline.scenario.stored = true;
	pipeline.scenario.policy = 'never';
	const allowed = await pipeline.reload();
	assert.equal(pipeline.settings.isProjectTrusted(), true);
	assert.deepEqual([...allowed.names], ['cli.ts', 'global.ts', 'project.ts']);
	assert.equal(pipeline.settings.getDefaultModel(), 'project-model');
}

// ---------------------------------------------------------------------------
// 4. Asynchronous ordering: the bootstrap pass stays untrusted while the
//    decision is pending, and the decision is applied once it settles.
// ---------------------------------------------------------------------------
{
	const pipeline = await createResourcePipeline(root);
	let releaseDecision;
	let atDecision;
	const decision = new Promise((resolve) => {
		releaseDecision = resolve;
	});
	const pending = new Promise((resolve) => {
		atDecision = resolve;
	});
	let preTrustNames;
	let preTrustTrusted;

	const reloaded = pipeline.loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			preTrustTrusted = pipeline.settings.isProjectTrusted();
			preTrustNames = [...extensionsResult.extensions].map((extension) => path.basename(extension.path));
			atDecision();
			await decision;
			return true;
		},
	});

	await pending;
	assert.equal(preTrustTrusted, false, 'the bootstrap extension pass must run untrusted');
	assert.deepEqual([...preTrustNames], ['cli.ts', 'global.ts'], 'the bootstrap pass must exclude project extensions');
	assert.equal(pipeline.settings.isProjectTrusted(), false, 'trust must not apply before the decision settles');
	assert.equal(pipeline.settings.getDefaultModel(), 'global-model');

	releaseDecision(true);
	await reloaded;
	assert.equal(pipeline.settings.isProjectTrusted(), true, 'the settled approval must be applied');
	assert.equal(pipeline.settings.getDefaultModel(), 'project-model');
	assert.deepEqual(names(pipeline), ['cli.ts', 'global.ts', 'project.ts']);
}

console.log('resource-consistency regression: all assertions passed');
