/** Regression: interrupted tool recovery must require BOTH the persisted call
 * policy and the current tool declaration to be replay-safe (and no
 * cancellation). Anything else publishes the interrupted outcome with the
 * durable checkpoint, without clearing it or invoking the tool.
 */
import assert from 'node:assert/strict';
import { createRecoverySubject } from './subject.mjs';

const root = new URL('..', import.meta.url).pathname;
const recover = await createRecoverySubject(root);

const CHECKPOINT = { content: [{ type: 'text', text: 'durable-progress' }], details: { step: 2 } };
const INTERRUPT_MARKER = 'external outcome is unknown';

function lastText(outcome) {
  const content = outcome?.message?.content ?? [];
  return content.filter((part) => part.type === 'text').map((part) => part.text);
}

function assertReplayed({ events, outcome }, label) {
  assert.deepEqual(events, ['clear', 'invoke', 'effect-complete', 'publish'], `${label}: safe replay must clear the checkpoint then rerun the tool exactly once`);
  assert.ok(outcome, `${label}: replayed invocation must publish its outcome`);
  assert.equal(outcome.message.isError, false, `${label}: replayed outcome must be the real tool result`);
  assert.ok(!lastText(outcome).some((text) => text.includes(INTERRUPT_MARKER)), `${label}: replayed outcome must not be an interruption`);
}

function assertInterrupted({ events, outcome }, label) {
  assert.ok(!events.includes('invoke'), `${label}: tool must not be invoked when replay is not doubly safe (events: ${events.join(',')})`);
  assert.ok(!events.includes('clear'), `${label}: durable checkpoint must not be cleared without replay (events: ${events.join(',')})`);
  assert.deepEqual(events, ['read', 'publish'], `${label}: interrupted recovery must read the durable checkpoint then stage the outcome`);
  assert.ok(outcome, `${label}: interrupted recovery must publish an outcome`);
  assert.equal(outcome.message.isError, true, `${label}: interrupted outcome is an error result`);
  assert.deepEqual(outcome.message.content[0], CHECKPOINT.content[0], `${label}: durable checkpoint content must be preserved`);
  assert.deepEqual(outcome.message.details, CHECKPOINT.details, `${label}: durable checkpoint details must be preserved`);
  assert.equal(outcome.terminate, false, `${label}: interrupted outcome must not terminate the run`);
  assert.ok(lastText(outcome).at(-1)?.includes('interrupted'), `${label}: interrupted outcome must explain the interruption`);
  assert.ok(lastText(outcome).at(-1)?.includes(INTERRUPT_MARKER), `${label}: interrupted outcome must state the external outcome is unknown`);
}

// Only the persisted call policy is safe: the current declaration forbids replay.
assertInterrupted(
  await recover('never', 'safe', false, { checkpoint: CHECKPOINT }),
  'persisted policy "never" with safe current declaration',
);
// Only the current declaration is safe: the persisted call policy forbids replay.
assertInterrupted(
  await recover('safe', 'never', false, { checkpoint: CHECKPOINT }),
  'persisted policy "safe" with unsafe current declaration',
);
// A missing current declaration cannot be replayed even when the call policy is safe.
assertInterrupted(
  await recover('safe', undefined, false, { checkpoint: CHECKPOINT }),
  'persisted policy "safe" with the tool no longer declared',
);
// A tool that declares no policy is not replay-safe.
assertInterrupted(
  await recover('safe', null, false, { checkpoint: CHECKPOINT }),
  'persisted policy "safe" with an unannotated tool declaration',
);
// Cancellation wins over a doubly safe replay.
assertInterrupted(
  await recover('safe', 'safe', true, { checkpoint: CHECKPOINT }),
  'doubly safe policy under cancellation',
);
// Both declarations safe and no cancellation replay with persisted arguments.
assertReplayed(await recover('safe', 'safe', false, { checkpoint: CHECKPOINT }), 'doubly safe policy');

// Replay still runs the tool once the faked effect completes.
assertReplayed(
  await recover('safe', 'safe', false, { checkpoint: CHECKPOINT, effect: async () => {} }),
  'doubly safe policy with effect completion',
);

// A later cancelled recovery of the same persisted call still interrupts.
assertInterrupted(
  await recover('safe', 'never', true, { checkpoint: CHECKPOINT }),
  'unsafe declaration under cancellation',
);

console.log('recovery regression: all assertions passed');
