#!/usr/bin/env node
/**
 * Cross-module regression for project-trust revocation.
 *
 * Exercises the real `resolveProjectTrusted` -> `DefaultResourceLoader.reload` ->
 * `SettingsManager` -> package resolution flow through `.prale-eval/subject.mjs`.
 * Only external boundaries (settings storage, package manager, extension loader,
 * trust event, UI) are faked by the harness.
 *
 * Each scenario is independent; assertions are uncaught so a failure exits non-zero.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createResourcePipeline } from './subject.mjs';

const workspaceRoot = path.resolve(import.meta.dirname, '..');
// Scratch fixtures live under .prale-eval so manual runs never touch the repository.
const fixtureRoot = path.join(import.meta.dirname, '.tmp-regression');
// Values crossing the VM boundary carry the guest realm's prototypes, so normalize
// to host-owned primitives/containers before strict comparison.
const toHost = (value) => JSON.parse(JSON.stringify(value));
const namesOf = (extensions) => Array.from(extensions, (extension) => path.basename(extension.path));
const extensionNames = (pipeline) => namesOf(pipeline.loader.getExtensions().extensions);

function prepareFixtures() {
	fs.rmSync(fixtureRoot, { recursive: true, force: true });
	fs.mkdirSync(path.join(fixtureRoot, '.fixture-resources'), { recursive: true });
	for (const name of ['global', 'project', 'cli']) {
		fs.writeFileSync(path.join(fixtureRoot, '.fixture-resources', `${name}.ts`), `export default ${name};\n`);
	}
}

function cleanupFixtures() {
	fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

/** Headless reload with no stored decision under "ask" must deny, not silently consent. */
async function headlessAskDenies() {
	const pipeline = await createResourcePipeline(workspaceRoot);
	pipeline.scenario.override = undefined;
	pipeline.scenario.stored = null;
	pipeline.scenario.hasUI = false;
	pipeline.scenario.policy = 'ask';

	const reload = await pipeline.reload();

	assert.equal(
		pipeline.settings.isProjectTrusted(),
		false,
		'headless reload without a stored decision and "ask" policy must not grant trust',
	);
	assert.deepEqual(
		toHost(reload.names),
		['cli.ts', 'global.ts'],
		'denied trust must resolve only global and CLI extensions',
	);
	assert.deepEqual(
		toHost(pipeline.settings.getProjectSettings()),
		{},
		'denied trust must not expose project settings',
	);
	assert.equal(pipeline.settings.getDefaultModel(), 'global-model', 'global settings must still apply');
	assert.equal(
		pipeline.settings.getCompactionReserveTokens(),
		8192,
		'global compaction settings must survive a denied project scope',
	);
	assert.deepEqual(pipeline.consentWrites, [], 'a missing UI must not persist any trust decision');
}

/** Approval loads project configuration; a later revocation must drop it immediately. */
async function approvalThenRevocation() {
	const pipeline = await createResourcePipeline(workspaceRoot);

	pipeline.scenario.override = true;
	const approved = await pipeline.reload();
	assert.equal(pipeline.settings.isProjectTrusted(), true, 'explicit approval must grant trust');
	assert.deepEqual(
		toHost(approved.names),
		['cli.ts', 'global.ts', 'project.ts'],
		'approved trust must resolve project extensions alongside global and CLI ones',
	);
	assert.equal(pipeline.settings.getDefaultModel(), 'project-model', 'approved trust must merge project settings');
	assert.equal(pipeline.settings.getCompactionReserveTokens(), 4096, 'project settings must override global ones');
	assert.equal(approved.calls, 1, 'reload must consult the trust resolver exactly once');

	pipeline.scenario.override = undefined;
	pipeline.scenario.stored = false;
	pipeline.scenario.hasUI = false;
	const revoked = await pipeline.reload();

	assert.equal(pipeline.settings.isProjectTrusted(), false, 'revocation must leave the project untrusted');
	assert.deepEqual(
		toHost(revoked.names),
		['cli.ts', 'global.ts'],
		'revocation must remove project extensions from the next resolved resource set',
	);
	assert.deepEqual(toHost(pipeline.settings.getProjectSettings()), {}, 'revocation must discard cached project settings');
	assert.equal(pipeline.settings.getDefaultModel(), 'global-model', 'revocation must fall back to global settings');
	assert.equal(
		pipeline.settings.getCompactionReserveTokens(),
		8192,
		'revocation must preserve global resources while dropping project ones',
	);
	assert.equal(
		JSON.parse(pipeline.storageData.project).defaultModel,
		'project-model',
		'revocation must not rewrite the stored project settings file',
	);
	assert.equal(revoked.calls, 1, 'revocation reload must also consult the trust resolver once');
}

/** The loader must await the resolver before applying trust, and never pre-trust the project. */
async function resolverOrdering() {
	const pipeline = await createResourcePipeline(workspaceRoot);

	let releaseResolver;
	let reachedResolver;
	const resolverReached = new Promise((resolve) => {
		reachedResolver = resolve;
	});
	const resolverGate = new Promise((resolve) => {
		releaseResolver = resolve;
	});

	const reload = pipeline.loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			assert.deepEqual(
				namesOf(extensionsResult.extensions),
				['cli.ts', 'global.ts'],
				'the resolver must receive a pre-trust set without project extensions',
			);
			assert.equal(pipeline.settings.isProjectTrusted(), false, 'the pre-trust pass must run untrusted');
			assert.deepEqual(
				toHost(pipeline.settings.getProjectSettings()),
				{},
				'the pre-trust pass must not expose project settings',
			);
			reachedResolver();
			await resolverGate;
			return false;
		},
	});

	await resolverReached;
	assert.equal(
		pipeline.settings.isProjectTrusted(),
		false,
		'trust must stay denied while the resolver is still pending',
	);
	assert.deepEqual(
		toHost(pipeline.settings.getProjectSettings()),
		{},
		'project settings must stay discarded while the resolver is still pending',
	);

	releaseResolver();
	await reload;

	assert.equal(pipeline.settings.isProjectTrusted(), false, 'the resolver denial must be applied after it settles');
	assert.deepEqual(
		extensionNames(pipeline),
		['cli.ts', 'global.ts'],
		'a denied resolver must leave project extensions out of the final resource set',
	);
	assert.deepEqual(toHost(pipeline.settings.getProjectSettings()), {}, 'a denied resolver must leave project settings empty');
}

/** A reload without a resolver keeps the existing trust state in both directions. */
async function reloadWithoutResolverKeepsTrust() {
	const pipeline = await createResourcePipeline(workspaceRoot);

	pipeline.scenario.override = true;
	await pipeline.reload();
	assert.equal(pipeline.settings.isProjectTrusted(), true, 'approval must establish trust');

	const decisionsBefore = pipeline.events.filter((event) => event[0] === 'extension-decision').length;
	await pipeline.loader.reload();
	assert.equal(pipeline.settings.isProjectTrusted(), true, 'reload without a resolver must retain approval');
	assert.deepEqual(
		extensionNames(pipeline),
		['cli.ts', 'global.ts', 'project.ts'],
		'reload without a resolver must keep approved project extensions',
	);
	assert.equal(
		pipeline.events.filter((event) => event[0] === 'extension-decision').length,
		decisionsBefore,
		'reload without a resolver must not re-run the trust decision',
	);

	pipeline.scenario.override = undefined;
	pipeline.scenario.stored = false;
	pipeline.scenario.hasUI = false;
	await pipeline.reload();
	assert.equal(pipeline.settings.isProjectTrusted(), false, 'revocation must establish denial');

	await pipeline.loader.reload();
	assert.equal(pipeline.settings.isProjectTrusted(), false, 'reload without a resolver must retain revocation');
	assert.deepEqual(
		extensionNames(pipeline),
		['cli.ts', 'global.ts'],
		'reload without a resolver must keep revoked project extensions out',
	);
}

/** Stored decisions are still authoritative for headless runs; only "unknown" denies. */
async function storedDecisionsAreHonored() {
	const allowed = await createResourcePipeline(workspaceRoot);
	allowed.scenario.override = undefined;
	allowed.scenario.stored = true;
	allowed.scenario.hasUI = false;
	allowed.scenario.policy = 'ask';
	const allowedReload = await allowed.reload();
	assert.equal(allowed.settings.isProjectTrusted(), true, 'a stored approval must still grant headless trust');
	assert.deepEqual(
		toHost(allowedReload.names),
		['cli.ts', 'global.ts', 'project.ts'],
		'a stored approval must resolve project extensions',
	);

	const denied = await createResourcePipeline(workspaceRoot);
	denied.scenario.override = undefined;
	denied.scenario.stored = false;
	denied.scenario.hasUI = false;
	denied.scenario.policy = 'ask';
	const deniedReload = await denied.reload();
	assert.equal(denied.settings.isProjectTrusted(), false, 'a stored denial must keep headless trust off');
	assert.deepEqual(toHost(deniedReload.names), ['cli.ts', 'global.ts'], 'a stored denial must exclude project extensions');
}

/** Revocation must discard cached project configuration immediately, before any reload. */
async function revocationIsImmediate() {
	const pipeline = await createResourcePipeline(workspaceRoot);
	pipeline.scenario.override = true;
	await pipeline.reload();
	assert.equal(pipeline.settings.getDefaultModel(), 'project-model', 'approval must load project settings first');

	// The real trust resolver now denies; the consumer of that decision must drop cached
	// project configuration synchronously instead of waiting for the next reload.
	pipeline.scenario.override = undefined;
	pipeline.scenario.stored = false;
	pipeline.scenario.hasUI = false;
	const denied = await pipeline.resolve(pipeline.loader.getExtensions());
	assert.equal(denied, false, 'the resolver must deny the revoked project');

	pipeline.settings.setProjectTrusted(denied);
	assert.deepEqual(
		toHost(pipeline.settings.getProjectSettings()),
		{},
		'revoking trust must discard cached project settings immediately',
	);
	assert.equal(
		pipeline.settings.getDefaultModel(),
		'global-model',
		'revoking trust must immediately fall back to global settings',
	);
	assert.equal(
		pipeline.settings.getCompactionReserveTokens(),
		8192,
		'revoking trust must immediately restore global-only compaction settings',
	);
	assert.equal(
		JSON.parse(pipeline.storageData.project).defaultModel,
		'project-model',
		'revoking trust must leave the stored project settings file untouched',
	);
	assert.throws(
		() => pipeline.settings.setProjectPackages(['npm:blocked']),
		/refusing to write project settings/,
		'revoked trust must still refuse project settings writes',
	);
}

/** An available UI still resolves "ask" prompts; the fix must not deny everything. */
async function interactiveAskStillPrompts() {
	const pipeline = await createResourcePipeline(workspaceRoot);
	pipeline.scenario.override = undefined;
	pipeline.scenario.stored = null;
	pipeline.scenario.hasUI = true;
	pipeline.scenario.policy = 'ask';

	const reload = await pipeline.reload();
	assert.equal(pipeline.settings.isProjectTrusted(), true, 'a UI approval must grant trust');
	assert.deepEqual(
		toHost(reload.names),
		['cli.ts', 'global.ts', 'project.ts'],
		'a UI approval must resolve project extensions',
	);
	assert.deepEqual(
		pipeline.consentWrites,
		[],
		'a session-only approval must not persist a trust decision',
	);
}

prepareFixtures();
try {
	await headlessAskDenies();
	await approvalThenRevocation();
	await resolverOrdering();
	await reloadWithoutResolverKeepsTrust();
	await revocationIsImmediate();
	await storedDecisionsAreHonored();
	await interactiveAskStillPrompts();
	console.log('regression: 7 project-trust scenarios passed');
} finally {
	cleanupFixtures();
}
