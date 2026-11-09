/** Regression: interrupted tool recovery must honour a durable cancellation.
 *
 * Exercises the real `recoverToolInvocation` (packages/agent/src/harness/runtime/drive/tools.ts)
 * through the boundary-faked loader in ./subject.mjs.
 *
 * Fault under test: a restored batch whose call AND tool are both replay "safe" used to
 * clear the replay checkpoint and invoke the tool even when the run had already been
 * cancelled. Cancellation must instead read the durable checkpoint and publish only
 * interrupted evidence. Non-cancelled safe/safe calls must still replay exactly once.
 */
import assert from "node:assert/strict";
import { createRecoverySubject } from "./subject.mjs";

const root = new URL("..", import.meta.url).pathname;
const recover = await createRecoverySubject(root);

const CHECKPOINT = { content: [{ type: "text", text: "durable-progress" }], details: { step: 2 } };
const INTERRUPTION = "external outcome is unknown";

function textOf(outcome) {
  assert.ok(outcome, "a tool outcome must be published");
  return outcome.message.content.map((part) => part.text).join("\n");
}

function assertInterrupted(outcome, checkpoint) {
  assert.equal(outcome.message.role, "toolResult");
  assert.equal(outcome.message.toolCallId, "call-1");
  assert.equal(outcome.message.toolName, "fixture-tool");
  assert.equal(outcome.message.isError, true);
  assert.equal(outcome.terminate, false);
  const text = textOf(outcome);
  assert.ok(text.includes(INTERRUPTION), `interrupted evidence must explain the unknown outcome, got: ${text}`);
  assert.ok(!text.includes("effect-result"), `interrupted evidence must not contain an invocation result, got: ${text}`);
  const content = outcome.message.content;
  assert.equal(content.length, checkpoint.content.length + 1, "exactly one interruption marker must be appended");
  if (checkpoint.content.length > 0) {
    // Content nodes are created inside the loaded module's VM realm, so compare their shape.
    assert.deepEqual(
      Array.from(content.slice(0, checkpoint.content.length), (part) => ({ type: part.type, text: part.text })),
      Array.from(checkpoint.content, (part) => ({ type: part.type, text: part.text })),
      "the latest durable checkpoint must be preserved",
    );
  }
  assert.deepEqual(outcome.message.details, checkpoint.details, "checkpoint details must be preserved");
}

function assertReplayed(outcome) {
  assert.ok(outcome, "a tool outcome must be published");
  assert.equal(outcome.message.isError, false);
  assert.equal(outcome.terminate, false);
  assert.equal(
    textOf(outcome),
    "effect-result",
    "a non-cancelled safe/safe call must publish the completed invocation result",
  );
  assert.deepEqual(outcome.args, { persisted: 42 }, "replay must run with the persisted (checkpoint-cleared) arguments");
  assert.equal(outcome.recovery, true, "replay must be marked as recovery");
}

const cases = [];
function test(name, run) {
  cases.push([name, run]);
}

// --- cancelled recovery ----------------------------------------------------

test("cancelled safe/safe recovery publishes interrupted evidence without clearing or invoking", async () => {
  let effects = 0;
  const { events, outcome } = await recover("safe", "safe", true, { effect: async () => void (effects += 1) });
  assert.deepEqual(events, ["read", "publish"], `cancelled batch must only read the checkpoint and publish, got ${events}`);
  assert.equal(effects, 0, "no tool effect may run after cancellation");
  assertInterrupted(outcome, CHECKPOINT);
});

test("cancelled safe/safe recovery keeps the durable checkpoint for safe tools", async () => {
  const { events, outcome } = await recover("safe", "safe", true);
  assert.ok(!events.includes("clear"), "cancellation must not clear the replay checkpoint");
  assert.ok(!events.includes("invoke"), "cancellation must not invoke the tool");
  assertInterrupted(outcome, CHECKPOINT);
});

test("cancelled recovery without a tool still publishes interrupted evidence", async () => {
  const { events, outcome } = await recover("safe", undefined, true);
  assert.deepEqual(events, ["read", "publish"]);
  assertInterrupted(outcome, CHECKPOINT);
});

test("cancelled unsafe-tool recovery publishes interrupted evidence", async () => {
  const never = await recover("safe", "never", true);
  assert.deepEqual(never.events, ["read", "publish"]);
  assertInterrupted(never.outcome, CHECKPOINT);

  const plain = await recover("safe", null, true);
  assert.deepEqual(plain.events, ["read", "publish"]);
  assertInterrupted(plain.outcome, CHECKPOINT);
});

test("cancelled recovery with a call that is not safe still publishes interrupted evidence", async () => {
  const { events, outcome } = await recover("never", "safe", true);
  assert.deepEqual(events, ["read", "publish"]);
  assertInterrupted(outcome, CHECKPOINT);
});

test("cancelled recovery with an empty durable checkpoint publishes only the marker", async () => {
  const empty = { content: [] };
  const { events, outcome } = await recover("safe", "safe", true, { checkpoint: empty });
  assert.deepEqual(events, ["read", "publish"]);
  assertInterrupted(outcome, empty);
  assert.equal(outcome.message.details, undefined, "no checkpoint details must be invented");
});

// --- non-cancelled recovery ------------------------------------------------

test("non-cancelled safe/safe recovery replays once and settles with the result", async () => {
  let effects = 0;
  const { events, outcome } = await recover("safe", "safe", false, { effect: async () => void (effects += 1) });
  assert.deepEqual(events, ["clear", "invoke", "effect-complete", "publish"]);
  assert.equal(effects, 1, "a non-cancelled safe/safe call must replay exactly once");
  assertReplayed(outcome);
});

test("non-cancelled recovery only replays safe/safe calls", async () => {
  const unsafeTool = await recover("safe", "never", false);
  assert.deepEqual(unsafeTool.events, ["read", "publish"]);
  assertInterrupted(unsafeTool.outcome, CHECKPOINT);

  const unsafeCall = await recover("never", "safe", false);
  assert.deepEqual(unsafeCall.events, ["read", "publish"]);
  assertInterrupted(unsafeCall.outcome, CHECKPOINT);

  const missingTool = await recover("safe", undefined, false);
  assert.deepEqual(missingTool.events, ["read", "publish"]);
  assertInterrupted(missingTool.outcome, CHECKPOINT);
});

const failures = [];
for (const [name, run] of cases) {
  try {
    await run();
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? error}`);
  }
}
assert.deepEqual(failures, [], `recovery regression failures:\n- ${failures.join("\n- ")}`);
console.log(`recovery regression: ${cases.length} scenarios passed`);
