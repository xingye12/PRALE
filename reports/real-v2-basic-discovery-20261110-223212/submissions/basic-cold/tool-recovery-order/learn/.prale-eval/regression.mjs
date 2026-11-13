/**
 * Regression for tool-recovery-order/learn.
 *
 * Incident: an interrupted tool call was replayed when EITHER the persisted call
 * policy OR the current tool declaration declared replay "safe". Replay must
 * require BOTH declarations to be safe and no cancellation; otherwise the
 * harness must publish an interrupted outcome carrying the durable checkpoint
 * without clearing it and without invoking the tool.
 *
 * Exercises the real `recoverToolInvocation` from
 * packages/agent/src/harness/runtime/drive/tools.ts through the subject helper,
 * whose only fakes are checkpoint IO, tool execution and outcome publication.
 */
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecoverySubject } from './subject.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = await createRecoverySubject(root);

const INTERRUPTED_MARKER_FRAGMENT = 'external outcome is unknown';
const CHECKPOINT_TEXT = 'durable-progress';
const CHECKPOINT_DETAILS = { step: 2 };

const REPLAY_EVENTS = ['clear', 'invoke', 'effect-complete', 'publish'];
const INTERRUPT_EVENTS = ['read', 'publish'];

let checks = 0;
async function check(name, fn) {
	await fn();
	checks += 1;
	process.stderr.write(`ok ${checks} - ${name}\n`);
}

/** Shared assertions for every path that must stay interrupted. */
function assertInterrupted(name, { events, outcome }) {
	assert.deepEqual(events, INTERRUPT_EVENTS, `${name}: checkpoint must be read, then only the outcome published`);
	assert.ok(!events.includes('invoke'), `${name}: the interrupted tool must not be invoked`);
	assert.ok(!events.includes('clear'), `${name}: the durable checkpoint must not be cleared`);
	assert.ok(outcome !== undefined, `${name}: an interrupted outcome must be published`);
	assert.equal(outcome.toolCall.id, 'call-1', `${name}: outcome must address the recovered call`);
	assert.equal(outcome.terminate, false, `${name}: interrupted outcomes must not terminate the run`);
	assert.equal(outcome.message.isError, true, `${name}: interrupted outcomes are errors`);
	const texts = outcome.message.content.map((part) => String(part.text ?? ''));
	assert.ok(
		texts.includes(CHECKPOINT_TEXT),
		`${name}: durable checkpoint content must be preserved, got ${JSON.stringify(texts)}`,
	);
	assert.ok(
		texts.some((text) => text.includes(INTERRUPTED_MARKER_FRAGMENT)) &&
			texts.at(-1).includes(INTERRUPTED_MARKER_FRAGMENT),
		`${name}: interruption marker must follow the checkpoint, got ${JSON.stringify(texts)}`,
	);
	assert.deepEqual(outcome.message.details, CHECKPOINT_DETAILS, `${name}: checkpoint details must be preserved`);
}

/** Shared assertions for the one path that must replay. */
function assertReplayed(name, { events, outcome }) {
	assert.deepEqual(events, REPLAY_EVENTS, `${name}: replay must clear the checkpoint, invoke, then publish`);
	assert.ok(outcome !== undefined, `${name}: a replayed outcome must be published`);
	assert.equal(outcome.message.isError, false, `${name}: replayed outcome keeps the tool result`);
	assert.equal(outcome.message.content[0].text, 'effect-result', `${name}: tool result must be published`);
	assert.equal(outcome.recovery, true, `${name}: replay runs in recovery mode`);
}

await check('both persisted call policy and tool declaration safe -> replay', async () => {
	assertReplayed('safe+safe', await run('safe', 'safe', false));
});

await check('persisted call policy safe but tool declaration never -> interrupted', async () => {
	assertInterrupted('safe+never', await run('safe', 'never', false));
});

await check('tool declaration safe but persisted call policy never -> interrupted', async () => {
	assertInterrupted('never+safe', await run('never', 'safe', false));
});

await check('persisted call policy safe but tool absent from configuration -> interrupted', async () => {
	assertInterrupted('safe+missing tool', await run('safe', undefined, false));
});

await check('persisted call policy safe but tool without replay policy -> interrupted', async () => {
	assertInterrupted('safe+undecided tool', await run('safe', null, false));
});

await check('both declarations safe but the batch is cancelled -> interrupted', async () => {
	assertInterrupted('safe+safe cancelled', await run('safe', 'safe', true));
});

await check('both declarations never -> interrupted', async () => {
	assertInterrupted('never+never', await run('never', 'never', false));
});

await check('replay hands the cleared persisted arguments to the tool', async () => {
	const { events, outcome } = await run('safe', 'safe', false);
	assert.deepEqual(events, REPLAY_EVENTS);
	assert.equal(outcome.toolCall.name, 'fixture-tool');
	// The fake checkpoint clear materializes { persisted: 42 }; replay must forward it to the tool.
	assert.deepEqual(outcome.args, { persisted: 42 }, 'persisted arguments must be handed to the tool');
});

process.stderr.write(`\n${checks} recovery-order checks passed\n`);
