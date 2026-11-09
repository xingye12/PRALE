/**
 * Cross-module regression for the tool execution lifecycle repair.
 *
 * Loads the submitted production modules through `.prale-eval/subject.mjs`, which links the real
 * `runtime/drive/tools.ts`, `execution/tools.ts` and `execution/effect-gate.ts` against each other and
 * only fakes external IO boundaries (checkpoint store, progress transport, hook delivery).
 *
 * Three independently mutated behaviours are pinned here:
 *   1. drive/tools.ts     - a non-cancelled safe/safe replay must actually resume the effect.
 *   2. execution/tools.ts - an explicit after-tool `isError: false` must clear the error state while
 *                           unspecified patch fields and usage keep the executed result.
 *   3. effect-gate.ts     - closing an aborting gate makes the terminal error authoritative for later
 *                           admissions; a pending cancellation must not win.
 *
 * Every assertion is an uncaught `node:assert/strict` assertion. Ordering is controlled with promises
 * only; no real timers, randomness or external services are used as evidence.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import { createExecutionPipeline } from './subject.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pipeline = await createExecutionPipeline(root);
const { createGate, AbortRequested } = pipeline.gate;
const { executeToolCall, finalizeToolCall, createToolResultMessage } = pipeline.execution;

/** Cross-realm safe deep comparison: modules execute in their own vm context. */
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const INTERRUPTION_MARKER =
	'[Tool execution was interrupted. The preceding output is the latest durable progress snapshot; newer live output may be missing, and the external outcome is unknown.]';
const CHECKPOINT = [{ type: 'text', text: 'checkpoint-evidence' }];

const results = [];
async function scenario(name, body) {
	await body();
	results.push(name);
}

/* -------------------------------------------------------------------------------------------------
 * 1. drive/tools.ts - recovery must resume a non-cancelled safe/safe call from its persisted intent.
 * ------------------------------------------------------------------------------------------------- */
await scenario('safe/safe recovery replays the effect from persisted arguments', async () => {
	const run = await pipeline.run({ persisted: 'safe', declared: 'safe' });

	// The persisted intent is cleared before the replacement effect starts, and the effect really runs.
	assert.ok(run.events.includes('clear'), `expected checkpoint clear, saw ${run.events.join(',')}`);
	assert.ok(run.events.includes('invoke'), `expected live re-execution, saw ${run.events.join(',')}`);
	assert.ok(!run.events.includes('read'), 'a replayed call must not read the interruption checkpoint');
	assert.ok(
		run.events.indexOf('clear') < run.events.indexOf('invoke'),
		'the persisted intent must be cleared before the effect is re-entered',
	);

	// The replacement effect used the persisted arguments, not the raw model arguments.
	const content = plain(run.outcome.message.content);
	assert.deepEqual(content, [{ type: 'text', text: 'persisted-arguments' }]);
	assert.equal(run.outcome.message.isError, false, 'a successful replay must not be reported as an error');
	assert.equal(run.outcome.terminate, false);
	assert.deepEqual(plain(run.outcome.message.details), { kept: true });
	assert.deepEqual(plain(run.outcome.message.usage), { output: 3 });
});

await scenario('safe/safe recovery honours explicit persisted arguments from the checkpoint store', async () => {
	const run = await pipeline.run({
		persisted: 'safe',
		declared: 'safe',
		arguments: { message: 'recovered-arguments' },
	});
	assert.ok(run.events.includes('invoke'), 'replay should execute the tool');
	assert.deepEqual(plain(run.outcome.message.content), [{ type: 'text', text: 'recovered-arguments' }]);
	assert.equal(run.outcome.message.isError, false);
});

await scenario('unsafe persisted intent is reported as interrupted, never replayed', async () => {
	const run = await pipeline.run({ persisted: 'never', declared: 'safe' });
	assert.ok(!run.events.includes('invoke'), 'a non-replayable call must not execute again');
	assert.ok(!run.events.includes('clear'), 'a non-replayable call must keep its checkpoint');
	assert.ok(run.events.includes('read'), 'the checkpoint must be read for the interruption evidence');
	assert.deepEqual(plain(run.outcome.message.content), [...plain(CHECKPOINT), { type: 'text', text: INTERRUPTION_MARKER }]);
	assert.equal(run.outcome.message.isError, true);
	// Checkpoint evidence is carried through into the interrupted message.
	assert.deepEqual(plain(run.outcome.message.details), { step: 2 });
});

await scenario('a tool that no longer declares safe replay is reported as interrupted', async () => {
	const declared = await pipeline.run({ persisted: 'safe', declared: 'never' });
	assert.ok(!declared.events.includes('invoke'), 'a mismatch in declarations must not replay');
	assert.equal(declared.outcome.message.isError, true);
	assert.deepEqual(plain(declared.outcome.message.content).at(-1), { type: 'text', text: INTERRUPTION_MARKER });

	const missing = await pipeline.run({ persisted: 'safe', declared: undefined });
	assert.ok(!missing.events.includes('invoke'), 'an unavailable tool declaration must not replay');
	assert.equal(missing.outcome.message.isError, true);
	assert.deepEqual(plain(missing.outcome.message.content).at(-1), { type: 'text', text: INTERRUPTION_MARKER });
});

await scenario('a pending cancellation forbids safe replay', async () => {
	const run = await pipeline.run({ persisted: 'safe', declared: 'safe', cancelled: true });
	assert.ok(!run.events.includes('invoke'), 'a cancelled call must not be replayed');
	assert.ok(!run.events.includes('clear'), 'a cancelled call must keep its checkpoint');
	assert.equal(run.outcome.message.isError, true);
	assert.deepEqual(plain(run.outcome.message.content), [...plain(CHECKPOINT), { type: 'text', text: INTERRUPTION_MARKER }]);
});

await scenario('an aborting gate turns a replayed effect into an interruption', async () => {
	const run = await pipeline.run({ persisted: 'safe', declared: 'safe', gateState: 'aborting' });
	assert.ok(!run.events.includes('invoke'), 'an aborted admission must not reach the effect');
	assert.equal(run.outcome.message.isError, true);
	assert.deepEqual(plain(run.outcome.message.content).at(-1), { type: 'text', text: INTERRUPTION_MARKER });
});

/* -------------------------------------------------------------------------------------------------
 * 2. execution/tools.ts - after-tool patches merge field by field.
 * ------------------------------------------------------------------------------------------------- */
await scenario('an after-tool hook may explicitly clear isError', async () => {
	const run = await pipeline.run({
		persisted: 'safe',
		declared: 'safe',
		patch: { isError: false },
		effect: async () => {
			throw new Error('effect-failed');
		},
	});
	assert.ok(run.events.includes('invoke'), 'the patched call must have executed');
	const message = run.outcome.message;
	// The patch did not specify content, so the executed error content survives untouched...
	assert.deepEqual(plain(message.content), [{ type: 'text', text: 'effect-failed' }]);
	// ...but the explicit `false` clears the error state.
	assert.equal(message.isError, false, 'an explicit isError:false patch must clear the error flag');
	assert.equal(run.outcome.terminate, false);
});

await scenario('an explicit empty content patch is applied while usage is preserved', async () => {
	const run = await pipeline.run({ persisted: 'safe', declared: 'safe', patch: { content: [] } });
	const message = run.outcome.message;
	assert.deepEqual(plain(message.content), [], 'an explicit empty content patch must be applied');
	assert.deepEqual(plain(message.details), { kept: true }, 'unspecified details must be preserved');
	assert.deepEqual(plain(message.usage), { output: 3 }, 'unspecified usage must be preserved');
	assert.equal(message.isError, false, 'a successful execution stays successful');

	const details = await pipeline.run({
		persisted: 'safe',
		declared: 'safe',
		patch: { details: { rewritten: true } },
	});
	assert.deepEqual(plain(details.outcome.message.details), { rewritten: true });
	assert.deepEqual(plain(details.outcome.message.usage), { output: 3 });
	assert.deepEqual(plain(details.outcome.message.content), [{ type: 'text', text: 'persisted-arguments' }]);
});

await scenario('an after-tool patch may still force the error state', async () => {
	const run = await pipeline.run({ persisted: 'safe', declared: 'safe', patch: { isError: true } });
	assert.equal(run.outcome.message.isError, true);
	assert.deepEqual(plain(run.outcome.message.content), [{ type: 'text', text: 'persisted-arguments' }]);
});

await scenario('finalizeToolCall merges patches without dropping executed fields', async () => {
	const toolCall = { id: 'call-direct', name: 'fixture-tool', arguments: { message: 'raw' } };
	const cleared = { toolCall, tool: { name: 'fixture-tool' }, args: { message: 'raw' } };
	const executed = {
		result: {
			content: [{ type: 'text', text: 'executed' }],
			details: { kept: true },
			usage: { output: 5 },
		},
		isError: true,
	};

	const clearedError = finalizeToolCall(cleared, executed, { isError: false });
	assert.equal(clearedError.isError, false, 'an explicit false patch must clear the error state');
	assert.equal(clearedError.terminate, false);
	assert.deepEqual(plain(clearedError.result.usage), { output: 5 }, 'usage must be preserved');
	assert.deepEqual(plain(clearedError.result.details), { kept: true }, 'details must be preserved');

	const preserved = finalizeToolCall(cleared, executed, { usage: { output: 7 } });
	assert.equal(preserved.isError, true, 'omitting isError must keep the executed error state');
	assert.deepEqual(plain(preserved.result.usage), { output: 7 }, 'an explicit usage patch must be applied');
	assert.deepEqual(plain(preserved.result.content), [{ type: 'text', text: 'executed' }]);

	const untouched = finalizeToolCall(cleared, executed, undefined);
	assert.equal(untouched.result, executed.result, 'a missing patch must pass the executed result through');
	assert.equal(untouched.isError, true);

	// The finalized call reaches the provider-facing message unchanged.
	const message = createToolResultMessage(clearedError);
	assert.equal(message.isError, false);
	assert.deepEqual(plain(message.usage), { output: 5 });
});

/* -------------------------------------------------------------------------------------------------
 * 3. effect-gate.ts - a terminal closure outranks a pending cancellation.
 * ------------------------------------------------------------------------------------------------- */
await scenario('closing an aborting gate makes the terminal error authoritative', async () => {
	const { gate, control } = createGate();
	let releaseCancellation;
	const cancellation = new Promise((resolve) => {
		releaseCancellation = resolve;
	});
	const terminal = new Error('terminal-failure');

	control.beginAbort(cancellation);
	assert.throws(
		() => gate.admit(() => 'never'),
		(error) => {
			assert.ok(error instanceof AbortRequested, 'an aborting gate must surface AbortRequested');
			assert.equal(error.cancellation, cancellation);
			return true;
		},
	);

	control.close(terminal);
	assert.throws(
		() => gate.admit(() => 'never'),
		(error) => {
			assert.equal(error, terminal, 'the terminal error must be authoritative for later admissions');
			assert.ok(!(error instanceof AbortRequested), 'the pending cancellation must not override the closure');
			return true;
		},
	);
	assert.equal(gate.signal.aborted, true, 'closing must abort the admission signal');
	assert.equal(gate.signal.reason, terminal);

	// A late cancellation signal or a late beginAbort may not reopen the gate.
	control.signalAbort();
	control.beginAbort(Promise.resolve());
	assert.throws(() => gate.admit(() => 'never'), (error) => error === terminal);
	releaseCancellation();
	await Promise.resolve();
	assert.throws(() => gate.admit(() => 'never'), (error) => error === terminal);
});

await scenario('closing a gate after its abort signal fired still wins for admissions', async () => {
	const { gate, control } = createGate();
	const terminal = new Error('terminal-after-signal');
	control.beginAbort(Promise.resolve());
	control.signalAbort();
	assert.equal(gate.signal.aborted, true);

	control.close(terminal);
	assert.throws(
		() => gate.admit(() => 'never'),
		(error) => {
			assert.equal(error, terminal, 'the terminal error must replace the pending cancellation for admissions');
			return true;
		},
	);
});

await scenario('the last close keeps the first terminal error', async () => {
	const { gate, control } = createGate();
	const first = new Error('first');
	const second = new Error('second');
	control.close(first);
	control.close(second);
	assert.throws(() => gate.admit(() => 'never'), (error) => error === first);
});

await scenario('an open gate still admits and a closed gate still rejects work', async () => {
	const open = createGate();
	let invoked = 0;
	assert.equal(
		open.gate.admit(() => {
			invoked += 1;
			return 'admitted';
		}),
		'admitted',
	);
	assert.equal(invoked, 1);
	assert.equal(open.gate.signal.aborted, false);

	const failing = new Error('closed-before-work');
	open.control.close(failing);
	assert.throws(() => open.gate.admit(() => 'never'), (error) => error === failing);
	assert.equal(invoked, 1);
});

/* The same closure contract, observed through the tool executor that consumes the gate. */
await scenario('executeToolCall rejects with the terminal error after an aborting gate closes', async () => {
	const { gate, control } = createGate();
	const terminal = new Error('terminal-execution');
	let executed = 0;
	const call = {
		toolCall: { id: 'call-gate', name: 'fixture-tool', arguments: { message: 'raw' } },
		tool: {
			name: 'fixture-tool',
			async execute() {
				executed += 1;
				return { content: [{ type: 'text', text: 'should-not-run' }], details: undefined };
			},
		},
		args: { message: 'raw' },
	};

	control.beginAbort(new Promise(() => {}));
	control.close(terminal);
	assert.throws(
		() => executeToolCall(call, gate, () => {}, {}, {}, { abortSignal: undefined }),
		(error) => {
			assert.equal(error, terminal, 'the executor must surface the terminal error, not AbortRequested');
			return true;
		},
	);
	assert.equal(executed, 0, 'no external effect may start after the gate closed');
});

console.log(`regression: ${results.length} scenarios passed`);
for (const name of results) console.log(`  ok - ${name}`);
