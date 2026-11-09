/**
 * Regression for tool-recovery-order/correction.
 *
 * Exercises the real `recoverToolInvocation` from
 * packages/agent/src/harness/runtime/drive/tools.ts (loaded by the read-only
 * subject helper with boundary fakes) and asserts the safe-replay contract:
 *
 *   - a call whose persisted intent and live tool declaration are both "safe"
 *     replays exactly once when it was not cancelled:
 *       clear old checkpoint -> invoke -> publish resulting outcome
 *   - every other declaration (unsafe/never, missing, cancelled) keeps the
 *     conservative interrupted-checkpoint outcome and never re-invokes.
 *
 * Exits zero when the repaired production code is present; fails with a
 * descriptive assertion when the blanket never-replay rule (`false && ...`)
 * is restored.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecoverySubject } from './subject.mjs';

// Workspace root, resolved from this file so the script does not depend on cwd.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const recover = await createRecoverySubject(root);

const INTERRUPTION_MARKER =
	'[Tool execution was interrupted. The preceding output is the latest durable progress snapshot; newer live output may be missing, and the external outcome is unknown.]';
const CHECKPOINT = { content: [{ type: 'text', text: 'durable-progress' }], details: { step: 2 } };

// Cross-realm safe normalizers: values produced inside the VM module context
// have foreign prototypes, so compare stable primitive projections instead.
const textOf = (outcome) =>
	Array.from(outcome?.message?.content ?? [], (part) => String(part?.text ?? ''));
const detailsOf = (outcome) => JSON.stringify(outcome?.message?.details ?? null);

/** Run one recovery scenario and assert the durable event ordering contract. */
async function scenario(label, { callPolicy, toolPolicy, cancelled = false, checkpoint = CHECKPOINT }) {
	const result = await recover(callPolicy, toolPolicy, cancelled, { checkpoint });
	assert.ok(Array.isArray(result.events), `${label}: recovery must report observable boundary events`);
	return { label, events: Array.from(result.events), outcome: result.outcome };
}

function assertReplayed(label, { events, outcome }) {
	assert.deepEqual(
		events,
		['clear', 'invoke', 'effect-complete', 'publish'],
		`${label}: safe/safe call must replay once: clear old checkpoint, invoke, then publish after completion`,
	);
	const clearAt = events.indexOf('clear');
	const invokeAt = events.indexOf('invoke');
	const completedAt = events.indexOf('effect-complete');
	const publishAt = events.indexOf('publish');
	assert.ok(clearAt < invokeAt, `${label}: old checkpoint must be cleared before invocation, saw ${events.join(' -> ')}`);
	assert.ok(completedAt < publishAt, `${label}: outcome must be published only after invocation completes, saw ${events.join(' -> ')}`);
	assert.equal(outcome?.message?.isError, false, `${label}: replayed call must publish the live tool result`);
	assert.deepEqual(textOf(outcome), ['effect-result'], `${label}: published outcome must be the replay result`);
	assert.ok(
		!textOf(outcome).includes(INTERRUPTION_MARKER),
		`${label}: replayed call must not publish the interruption marker`,
	);
}

function assertInterrupted(label, { events, outcome }) {
	assert.ok(
		!events.includes('invoke') && !events.includes('effect-complete'),
		`${label}: restricted declaration must never replay the tool effect, saw ${events.join(' -> ')}`,
	);
	assert.deepEqual(
		events,
		['read', 'publish'],
		`${label}: restricted declaration must read the durable checkpoint then publish it`,
	);
	assert.equal(outcome?.message?.isError, true, `${label}: interrupted recovery must be reported as an error outcome`);
	const text = textOf(outcome);
	assert.equal(text.at(-1), INTERRUPTION_MARKER, `${label}: interrupted outcome must end with the interruption marker`);
	assert.deepEqual(
		text.slice(0, -1),
		['durable-progress'],
		`${label}: interrupted outcome must preserve the durable checkpoint content`,
	);
	assert.equal(detailsOf(outcome), JSON.stringify({ step: 2 }), `${label}: interrupted outcome must preserve checkpoint details`);
}

// 1. The repaired behavior: both the persisted intent and the live declaration
//    are safe, and the call was not cancelled.
assertReplayed(
	'not cancelled (safe intent, safe declaration)',
	await scenario('not cancelled (safe intent, safe declaration)', {
		callPolicy: 'safe',
		toolPolicy: 'safe',
		cancelled: false,
	}),
);

// 1b. Replay ordering must hold even when the effect yields asynchronously.
assertReplayed(
	'not cancelled (async effect)',
	await recover('safe', 'safe', false, {
		checkpoint: CHECKPOINT,
		effect: () => new Promise((resolve) => setTimeout(resolve, 5)),
	}).then((result) => ({ label: 'not cancelled (async effect)', events: Array.from(result.events), outcome: result.outcome })),
);

// 2. Cancelled declarations stay restricted: no replay, no checkpoint clearing.
{
	const cancelled = await scenario('cancelled (safe/safe)', {
		callPolicy: 'safe',
		toolPolicy: 'safe',
		cancelled: true,
	});
	assertInterrupted('cancelled (safe/safe)', cancelled);
	assert.ok(
		!cancelled.events.includes('clear'),
		`cancelled (safe/safe): must not clear the checkpoint of a cancelled call, saw ${cancelled.events.join(' -> ')}`,
	);
}

// 3. Unsafe live declaration (tool says "never") stays restricted.
assertInterrupted(
	'unsafe declaration (safe intent, never declaration)',
	await scenario('unsafe declaration (safe intent, never declaration)', {
		callPolicy: 'safe',
		toolPolicy: 'never',
		cancelled: false,
	}),
);

// 4. Unsafe persisted intent (recorded "never", live "safe") stays restricted.
assertInterrupted(
	'unsafe intent (never intent, safe declaration)',
	await scenario('unsafe intent (never intent, safe declaration)', {
		callPolicy: 'never',
		toolPolicy: 'safe',
		cancelled: false,
	}),
);

// 5. Missing declaration: the tool is no longer registered after restart.
assertInterrupted(
	'missing declaration',
	await scenario('missing declaration', {
		callPolicy: 'safe',
		toolPolicy: undefined,
		cancelled: false,
	}),
);

// 6. Tool present but without an explicit replay policy (defaults to never).
assertInterrupted(
	'undeclared replay policy',
	await scenario('undeclared replay policy', {
		callPolicy: 'safe',
		toolPolicy: null,
		cancelled: false,
	}),
);

console.log('tool-recovery-order regression: 9 assertions groups passed');
