#!/usr/bin/env node
/**
 * Cross-module regression for the recovery authorization -> admission -> effect chain.
 *
 * Loads the real submitted production modules through `.prale-eval/subject.mjs`:
 *   - `runtime/drive/tools.ts`      recovery decision + checkpoint clearing + publication order
 *   - `execution/tools.ts`          cleared-call executor / finalizer
 *   - `execution/effect-gate.ts`    synchronous admission gate
 * Only checkpoint storage, progress transport, provider/hook delivery and the tool
 * effect boundary are faked. Assertions are uncaught `node:assert/strict` checks
 * and asynchronous ordering is driven exclusively by promises.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createExecutionPipeline } from './subject.mjs';

const root = process.cwd();
const scratchDir = path.join(root, '.prale-eval', '.tmp-regression-scratch');
const INTERRUPTION_FRAGMENT = 'external outcome is unknown';

function deferred() {
	let resolve;
	const promise = new Promise((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** Advance microtask-only progress until `predicate` holds (no timers, no real time). */
async function flushUntil(predicate, label) {
	for (let step = 0; step < 1_000; step += 1) {
		if (predicate()) return;
		await Promise.resolve();
	}
	assert.fail(`asynchronous ordering never reached: ${label}`);
}

function messageText(message) {
	return message.content
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n');
}

function firstIndex(events, name) {
	return events.indexOf(name);
}

fs.rmSync(scratchDir, { recursive: true, force: true });
fs.mkdirSync(scratchDir, { recursive: true });

try {
	const pipeline = await createExecutionPipeline(root);
	const observations = [];

	// ---------------------------------------------------------------------------
	// 1. A procedure-facing gate refuses admission without invoking the effect.
	// ---------------------------------------------------------------------------
	{
		const { createGate, AbortRequested } = pipeline.gate;
		const aborting = createGate();
		const cancellation = deferred();
		aborting.control.beginAbort(cancellation.promise);
		let admittedWhileAborting = false;
		assert.throws(
			() =>
				aborting.gate.admit(() => {
					admittedWhileAborting = true;
				}),
			(error) => error instanceof AbortRequested && error.cancellation === cancellation.promise,
			'aborting gate must throw AbortRequested before running admitted work',
		);
		assert.equal(admittedWhileAborting, false, 'aborting gate admitted work');
		assert.equal(aborting.gate.signal.aborted, false, 'cancellation signal must wait for its commit');

		const closed = createGate();
		const closure = new Error('closed gate');
		closed.control.close(closure);
		let admittedWhileClosed = false;
		assert.throws(
			() =>
				closed.gate.admit(() => {
					admittedWhileClosed = true;
				}),
			(error) => error === closure,
			'closed gate must rethrow its closing error before running admitted work',
		);
		assert.equal(admittedWhileClosed, false, 'closed gate admitted work');
		assert.equal(closed.gate.signal.aborted, true, 'closed gate must signal admitted work');

		cancellation.resolve();
		await cancellation.promise;
		aborting.control.signalAbort();
		assert.equal(aborting.gate.signal.aborted, true);
		observations.push('gate:refuses-aborting-and-closed-admission');
	}

	// ---------------------------------------------------------------------------
	// 2. Safe replay re-executes the persisted arguments, never the model call.
	// ---------------------------------------------------------------------------
	{
		let effectArgs;
		const safe = await pipeline.run({
			persisted: 'safe',
			declared: 'safe',
			arguments: { message: 'persisted-arguments' },
			effect: ({ args }) => {
				effectArgs = args;
				return { content: [{ type: 'text', text: args.message }], details: { kept: true }, usage: { output: 3 } };
			},
		});

		assert.deepEqual(effectArgs, { message: 'persisted-arguments' }, 'replay must execute cleared/persisted args');
		assert.equal(safe.events.filter((event) => event === 'invoke').length, 1, 'safe replay must invoke once');
		assert.equal(safe.events[0], 'clear', 'old checkpoint must be cleared before the invocation');
		assert.ok(firstIndex(safe.events, 'clear') < firstIndex(safe.events, 'invoke'));
		assert.ok(
			firstIndex(safe.events, 'effect-complete') < firstIndex(safe.events, 'publish'),
			'outcome must not be published before the effect finished',
		);
		assert.equal(safe.outcome.message.isError, false);
		assert.equal(messageText(safe.outcome.message), 'persisted-arguments');
		assert.deepEqual(safe.outcome.message.details, { kept: true });
		assert.deepEqual(
			safe.outcome.toolCall.arguments,
			{ message: 'raw-model-arguments' },
			'the provider tool call must stay unchanged while the executor uses persisted args',
		);
		observations.push('replay:persisted-arguments-executed');
	}

	// ---------------------------------------------------------------------------
	// 3. Publication waits for the effect and for the durable progress drain.
	// ---------------------------------------------------------------------------
	{
		const drainGate = deferred();
		let drainEntered = false;
		let publishCount = 0;
		let publishedBeforeDrainCompleted = false;
		let checkpointWritten = false;
		const running = pipeline.run({
			persisted: 'safe',
			declared: 'safe',
			effect: ({ update }) => {
				update?.(
					{ content: [{ type: 'text', text: 'durable partial' }], details: { progress: 'partial' } },
					{ checkpoint: true },
				);
				return { content: [{ type: 'text', text: 'final output' }], details: { progress: 'final' } };
			},
			progressDrain: () => {
				drainEntered = true;
				return drainGate.promise.then(() => {
					checkpointWritten = true;
				});
			},
			onPublish: () => {
				publishCount += 1;
				if (!checkpointWritten) publishedBeforeDrainCompleted = true;
			},
		});

		await flushUntil(() => drainEntered, 'durable progress drain');
		assert.equal(publishCount, 0, 'outcome published while the durable progress drain was still pending');
		assert.equal(publishedBeforeDrainCompleted, false);

		drainGate.resolve();
		const settled = await running;
		assert.equal(publishCount, 1, 'outcome must be published exactly once');
		assert.equal(publishedBeforeDrainCompleted, false, 'outcome published before durable progress became durable');
		assert.ok(
			firstIndex(settled.events, 'drain-complete') < firstIndex(settled.events, 'publish'),
			'publication must follow the completed progress drain',
		);
		assert.deepEqual(
			settled.checkpoints.map((partial) => messageText(partial)),
			['durable partial'],
			'the tool checkpoint must be persisted once before publication',
		);
		assert.deepEqual(
			settled.updates.map((event) => event.type),
			['tool_update'],
			'live updates must be delivered before the outcome is published',
		);
		assert.equal(messageText(settled.outcome.message), 'final output');
		observations.push('publication:after-effect-and-progress-drain');
	}

	// ---------------------------------------------------------------------------
	// 4. Both replay declarations must be safe; missing tools stay interrupted.
	// ---------------------------------------------------------------------------
	for (const scenario of [
		{ name: 'stored-safe-current-never', persisted: 'safe', declared: 'never' },
		{ name: 'stored-never-current-safe', persisted: 'never', declared: 'safe' },
		{ name: 'missing-current-declaration', persisted: 'safe', declared: undefined },
	]) {
		let effectCalls = 0;
		const result = await pipeline.run({
			persisted: scenario.persisted,
			declared: scenario.declared,
			effect: () => {
				effectCalls += 1;
				return { content: [{ type: 'text', text: 'must not run' }], details: {} };
			},
		});

		assert.equal(effectCalls, 0, `${scenario.name}: interrupted operation executed its effect`);
		assert.equal(
			result.events.includes('invoke'),
			false,
			`${scenario.name}: interrupted operation reached the tool effect boundary`,
		);
		assert.equal(result.events.includes('clear'), false, `${scenario.name}: checkpoint of an unsafe call was cleared`);
		assert.ok(result.events.includes('read'), `${scenario.name}: durable checkpoint snapshot must be read`);
		assert.ok(result.events.includes('publish'), `${scenario.name}: interruption must still be published`);
		assert.ok(
			firstIndex(result.events, 'read') < firstIndex(result.events, 'publish'),
			`${scenario.name}: checkpoint evidence must be read before publication`,
		);
		assert.equal(result.outcome.message.isError, true, `${scenario.name}: interrupted result must be an error result`);
		assert.equal(
			messageText(result.outcome.message).includes(INTERRUPTION_FRAGMENT),
			true,
			`${scenario.name}: interrupted result must state that the external outcome is unknown`,
		);
		assert.equal(
			messageText(result.outcome.message).includes('checkpoint-evidence'),
			true,
			`${scenario.name}: durable checkpoint content must be preserved`,
		);
		assert.deepEqual(result.outcome.message.details, { step: 2 });
		observations.push(`interrupted:${scenario.name}`);
	}

	// ---------------------------------------------------------------------------
	// 5. Durable cancellation prevents admission of the replay effect.
	// ---------------------------------------------------------------------------
	{
		let effectCalls = 0;
		const cancelled = await pipeline.run({
			persisted: 'safe',
			declared: 'safe',
			cancelled: true,
			effect: () => {
				effectCalls += 1;
				return { content: [], details: {} };
			},
		});
		assert.equal(effectCalls, 0, 'cancelled recovery must not execute the effect');
		assert.equal(cancelled.events.includes('clear'), false, 'cancelled recovery must keep the durable checkpoint');
		assert.equal(cancelled.events.includes('invoke'), false);
		assert.equal(cancelled.outcome.message.isError, true);
		assert.equal(messageText(cancelled.outcome.message).includes(INTERRUPTION_FRAGMENT), true);
		observations.push('cancelled:no-admission');
	}

	// ---------------------------------------------------------------------------
	// 6. An aborting gate refuses the replay effect even though replay is safe.
	// ---------------------------------------------------------------------------
	{
		let effectCalls = 0;
		const aborting = await pipeline.run({
			persisted: 'safe',
			declared: 'safe',
			gateState: 'aborting',
			effect: () => {
				effectCalls += 1;
				return { content: [{ type: 'text', text: 'must not run' }], details: {} };
			},
		});
		assert.equal(effectCalls, 0, 'aborting gate must prevent the replay effect from being admitted');
		assert.equal(aborting.events.includes('invoke'), false, 'aborting gate let the effect boundary be crossed');
		assert.equal(aborting.outcome.message.isError, true);
		assert.equal(messageText(aborting.outcome.message).includes(INTERRUPTION_FRAGMENT), true);
		observations.push('aborting-gate:no-admission');
	}

	// ---------------------------------------------------------------------------
	// 7. A closed gate surfaces its closing error instead of running the effect.
	// ---------------------------------------------------------------------------
	{
		let effectCalls = 0;
		let publishCount = 0;
		const closure = new Error('closed gate');
		await assert.rejects(
			pipeline.run({
				persisted: 'safe',
				declared: 'safe',
				gateState: 'closed',
				gateError: closure,
				effect: () => {
					effectCalls += 1;
					return { content: [{ type: 'text', text: 'must not run' }], details: {} };
				},
				onPublish: () => {
					publishCount += 1;
				},
			}),
			(error) => error === closure,
			'closed gate must surface its closing error',
		);
		assert.equal(effectCalls, 0, 'closed gate must prevent the replay effect from being admitted');
		assert.equal(publishCount, 0, 'closed gate must not publish an outcome for an effect it never admitted');
		observations.push('closed-gate:no-admission');
	}

	// Local, workspace-confined test artifact: the ordering evidence above is written
	// to a scratch input under `.prale-eval/` and read back before cleanup.
	const tracePath = path.join(scratchDir, 'trace.json');
	fs.writeFileSync(tracePath, JSON.stringify({ observations }, null, 2));
	const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
	assert.deepEqual(trace.observations, observations);
	assert.equal(new Set(trace.observations).size, trace.observations.length, 'every scenario ran once');

	console.log(`regression: ${observations.length} cross-module observations passed`);
	for (const observation of observations) console.log(`  ok ${observation}`);
} finally {
	fs.rmSync(scratchDir, { recursive: true, force: true });
}
