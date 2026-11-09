/** Executable regression for the execution-lifecycle fences.
 *
 * Loads the real submitted modules: the recovery scheduler in
 * `runtime/drive/tools.ts`, the tool executor in `execution/tools.ts` and the
 * effect gate in `execution/effect-gate.ts`. Checkpoint storage, progress
 * transport and outcome publication are observable fakes supplied by
 * `subject.mjs`; execution, finalization and gate behaviour run live.
 *
 * Ordering is controlled exclusively by promises (no timers, no randomness).
 */
import assert from 'node:assert/strict';
import { createExecutionPipeline } from './subject.mjs';

const root = process.cwd();
const pipeline = await createExecutionPipeline(root);

const publishes = (events) => events.filter((event) => event === 'publish').length;
const textOf = (message) => (message.content ?? []).map((part) => part.text ?? '').join('\n');

// ---------------------------------------------------------------------------
// 1. A live safe/safe recovery still clears, invokes, and publishes once with
//    the recovered arguments, usage and details preserved.
// ---------------------------------------------------------------------------
{
	const safe = await pipeline.run({ persisted: 'safe', declared: 'safe' });

	assert.equal(publishes(safe.events), 1, 'safe recovery must publish exactly one outcome');
	assert.deepEqual(
		safe.events.filter((event) => event === 'clear' || event === 'invoke'),
		['clear', 'invoke'],
		'safe recovery must clear the replay checkpoint and then invoke the tool',
	);
	assert.equal(safe.outcome.message.isError, false, 'safe recovery must record a successful tool result');
	assert.deepEqual(safe.outcome.message.details, { kept: true }, 'tool details must survive the recovery');
	assert.deepEqual(safe.outcome.message.usage, { output: 3 }, 'tool usage must survive the recovery');
	assert.deepEqual(
		safe.outcome.message.content,
		[{ type: 'text', text: 'persisted-arguments' }],
		'recovery must execute with the persisted arguments, not the raw model arguments',
	);
	assert.equal(safe.outcome.toolCall.id, 'call-2');
}

// ---------------------------------------------------------------------------
// 2. A cancelled recovery never clears the checkpoint and never invokes the
//    tool; it publishes one interrupted outcome that preserves the checkpoint.
// ---------------------------------------------------------------------------
{
	const cancelled = await pipeline.run({ persisted: 'safe', declared: 'safe', cancelled: true });

	assert.ok(
		!cancelled.events.includes('clear'),
		`cancelled recovery must not clear a replay checkpoint (events: ${cancelled.events.join(',')})`,
	);
	assert.ok(
		!cancelled.events.includes('invoke'),
		`cancelled recovery must not cross the tool-effect boundary (events: ${cancelled.events.join(',')})`,
	);
	assert.ok(cancelled.events.includes('read'), 'cancelled recovery must consult the durable checkpoint');
	assert.equal(publishes(cancelled.events), 1, 'cancelled recovery must publish exactly one outcome');
	assert.equal(cancelled.outcome.message.isError, true, 'cancelled recovery must record an error outcome');
	assert.deepEqual(
		cancelled.outcome.message.details,
		{ step: 2 },
		'cancelled recovery must preserve the checkpoint details',
	);
	assert.deepEqual(
		cancelled.outcome.message.content[0],
		{ type: 'text', text: 'checkpoint-evidence' },
		'cancelled recovery must preserve the checkpoint content',
	);
	assert.match(textOf(cancelled.outcome.message), /interrupted/, 'cancelled recovery must mark the interruption');
	assert.deepEqual(cancelled.checkpoints, [], 'cancelled recovery must not write tool progress checkpoints');
	assert.deepEqual(cancelled.updates, [], 'cancelled recovery must not emit live tool updates');
}

// ---------------------------------------------------------------------------
// 3. A cancelled recovery of a non-safe effect is also fenced off.
// ---------------------------------------------------------------------------
{
	const cancelledNever = await pipeline.run({ persisted: 'never', declared: 'safe', cancelled: true });

	assert.ok(!cancelledNever.events.includes('clear'), 'cancelled never-replay recovery must not clear');
	assert.ok(!cancelledNever.events.includes('invoke'), 'cancelled never-replay recovery must not invoke');
	assert.equal(publishes(cancelledNever.events), 1);
	assert.deepEqual(cancelledNever.outcome.message.details, { step: 2 });
}

// ---------------------------------------------------------------------------
// 4. Completion seals live updates and checkpoint callbacks: a tool that keeps
//    its update callback after resolving can no longer reach the drive.
// ---------------------------------------------------------------------------
{
	let releaseEffect;
	const effectReleased = new Promise((resolve) => {
		releaseEffect = resolve;
	});
	let signalStarted;
	const effectStarted = new Promise((resolve) => {
		signalStarted = resolve;
	});
	let lateUpdate;

	const pending = pipeline.run({
		persisted: 'safe',
		declared: 'safe',
		effect: async ({ update }) => {
			lateUpdate = update;
			update([{ type: 'text', text: 'live-progress' }], { checkpoint: true });
			signalStarted();
			await effectReleased;
			return {
				content: [{ type: 'text', text: 'finished' }],
				details: { final: true },
				usage: { output: 1 },
			};
		},
	});

	// Push a second, non-checkpoint live update while the effect is in flight.
	await effectStarted;
	releaseEffect();
	const completed = await pending;

	assert.equal(typeof lateUpdate, 'function', 'the tool must have received its update callback');
	assert.equal(completed.updates.length, 1, 'the in-flight live update must be delivered');
	assert.equal(completed.checkpoints.length, 1, 'the in-flight checkpoint must be written');
	assert.deepEqual(completed.outcome.message.details, { final: true });

	const updatesBefore = completed.updates.length;
	const checkpointsBefore = completed.checkpoints.length;
	const eventsBefore = completed.events.length;

	lateUpdate([{ type: 'text', text: 'after-completion' }], { checkpoint: true });
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(completed.updates.length, updatesBefore, 'a completed tool must not deliver live updates');
	assert.equal(completed.checkpoints.length, checkpointsBefore, 'a completed tool must not write checkpoints');
	assert.equal(completed.events.length, eventsBefore, 'a completed tool must not emit any further drive batches');
}

// ---------------------------------------------------------------------------
// 5. A closed gate is terminal: beginAbort cannot reopen it or replace the
//    terminal error, and the executor observes that terminal error.
// ---------------------------------------------------------------------------
{
	const { createGate } = pipeline.gate;
	const { executeToolCall } = pipeline.execution;

	const terminal = new Error('drive closed');
	const { gate, control } = createGate();
	control.close(terminal);
	control.beginAbort(Promise.resolve());

	assert.equal(gate.signal.aborted, true, 'closing the gate must abort its signal');
	assert.equal(gate.signal.reason, terminal, 'the gate signal must carry the terminal error');
	assert.throws(
		() => gate.admit(() => 'admitted'),
		(error) => error === terminal,
		'beginAbort must not replace a closed gate terminal error',
	);

	let invoked = false;
	const cleared = {
		toolCall: { id: 'call-9', name: 'fixture-tool', arguments: { message: 'x' } },
		tool: {
			name: 'fixture-tool',
			replay: 'safe',
			async execute() {
				invoked = true;
				return { content: [], details: undefined };
			},
		},
		args: { message: 'x' },
	};
	const invocation = {
		invocationId: 'result-9',
		operationId: 'op-9',
		turnId: 'turn-9',
		getMemo: async () => undefined,
		setMemo: async () => {},
	};
	assert.throws(
		() => executeToolCall(cleared, gate, () => {}, {}, invocation, {}),
		(error) => error === terminal,
		'the executor must surface the terminal gate error',
	);
	assert.equal(invoked, false, 'a sealed gate must never admit a tool effect');
}

// ---------------------------------------------------------------------------
// 6. Gate lifecycle APIs are preserved: aborting an open gate still requests
//    abort, and a later close still wins with its terminal error.
// ---------------------------------------------------------------------------
{
	const { createGate, AbortRequested } = pipeline.gate;
	assert.equal(typeof AbortRequested, 'function');

	const cancellation = Promise.resolve();
	const { gate, control } = createGate();
	control.beginAbort(cancellation);
	assert.throws(
		() => gate.admit(() => 'admitted'),
		(error) => error instanceof AbortRequested && error.cancellation === cancellation,
		'an aborted gate must request cancellation',
	);
	control.signalAbort();
	assert.equal(gate.signal.aborted, true, 'signalAbort must abort an aborting gate');

	const terminal = new Error('late close');
	control.close(terminal);
	assert.throws(
		() => gate.admit(() => 'admitted'),
		(error) => error === terminal,
		'close must remain terminal after an abort was requested',
	);
}

console.log('regression: execution lifecycle fences passed');
