/**
 * Standalone regression for tool-recovery-order/transfer.
 *
 * Exercises the real `recoverToolInvocation` / `interruptedOutcome` production code in
 * `packages/agent/src/harness/runtime/drive/tools.ts` through the read-only subject helper.
 * Only checkpoint IO, tool execution and outcome publication are boundary fakes, so the
 * replay decision itself is the real implementation.
 *
 * Invariant under test: a recovered `effect_pending` call may replay only when it was
 * persisted as safe AND the current tool declaration is still present and still declares
 * safe replay AND the operation was not cancelled. Every other case must settle as an
 * interrupted outcome (checkpoint + interruption marker, isError) without invoking the tool.
 *
 * Run with: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRecoverySubject } from "./subject.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INTERRUPTION_MARKER_FRAGMENT = "external outcome is unknown";
const REPLAY_EVENTS = ["clear", "invoke", "effect-complete", "publish"];
const INTERRUPT_EVENTS = ["read", "publish"];

const recover = await createRecoverySubject(root);

/** Run one recovery case, converting any unexpected throw into a hard assertion failure. */
async function recoverCase(label, callPolicy, toolPolicy, cancelled) {
  try {
    const result = await recover(callPolicy, toolPolicy, cancelled);
    assert.ok(result && typeof result === "object", `${label}: recovery returned no result`);
    assert.ok(Array.isArray(result.events), `${label}: recovery recorded no boundary events`);
    return result;
  } catch (error) {
    assert.fail(`${label}: recovery threw instead of settling: ${error?.stack ?? String(error)}`);
  }
}

function textOf(message) {
  return (message.content ?? [])
    .map((part) => (part && part.type === "text" ? part.text : ""))
    .join("\n");
}

/** Assert the call settled as interrupted with the durable checkpoint preserved. */
function assertInterrupted(label, result) {
  assert.deepEqual(result.events, INTERRUPT_EVENTS, `${label}: unexpected boundary calls`);
  assert.equal(result.events.includes("invoke"), false, `${label}: tool effect must not run`);
  assert.equal(result.events.includes("clear"), false, `${label}: replay checkpoint must not be cleared`);
  const outcome = result.outcome;
  assert.ok(outcome, `${label}: no tool outcome was published`);
  assert.equal(outcome.message.role, "toolResult", `${label}: wrong outcome message role`);
  assert.equal(outcome.message.toolCallId, "call-1", `${label}: wrong toolCallId`);
  assert.equal(outcome.message.toolName, "fixture-tool", `${label}: wrong toolName`);
  assert.equal(outcome.message.isError, true, `${label}: interrupted outcome must be an error`);
  assert.equal(outcome.terminate, false, `${label}: interrupted outcome must not terminate`);
  assert.match(textOf(outcome.message), /durable-progress/, `${label}: checkpoint content was lost`);
  assert.ok(
    textOf(outcome.message).includes(INTERRUPTION_MARKER_FRAGMENT),
    `${label}: interruption marker missing from outcome`,
  );
  assert.deepEqual(outcome.message.details, { step: 2 }, `${label}: checkpoint details were lost`);
}

/** Assert the call replayed its persisted effect. */
function assertReplayed(label, result) {
  assert.deepEqual(result.events, REPLAY_EVENTS, `${label}: unexpected boundary calls`);
  const outcome = result.outcome;
  assert.ok(outcome, `${label}: no tool outcome was published`);
  assert.ok(outcome.message, `${label}: replayed outcome has no tool message`);
  assert.equal(outcome.message.isError, false, `${label}: replayed outcome must not be an error`);
  assert.match(textOf(outcome.message), /effect-result/, `${label}: replay did not produce the effect result`);
}

// 1. Persisted safe and the current declaration is still safe: the only replayable shape.
assertReplayed(
  "both-safe replay",
  await recoverCase("both-safe replay", "safe", "safe", false),
);

// 2. The declaration changed from safe to never: the persisted intent is no longer replayable.
assertInterrupted(
  "changed declaration (safe -> never)",
  await recoverCase("changed declaration (safe -> never)", "safe", "never", false),
);

// 3. The tool disappeared between runs: must settle as interrupted, never throw or execute.
assertInterrupted(
  "missing tool declaration",
  await recoverCase("missing tool declaration", "safe", undefined, false),
);

// 4. The tool is still present but no longer declares a replay policy (defaults to never).
assertInterrupted(
  "declaration without replay policy",
  await recoverCase("declaration without replay policy", "safe", null, false),
);

// 5. A cancelled operation must never replay, even when both policies are safe.
assertInterrupted(
  "cancelled both-safe call",
  await recoverCase("cancelled both-safe call", "safe", "safe", true),
);

// 6. Persisted intent alone is not enough: a never-persisted call stays interrupted.
assertInterrupted(
  "persisted never with safe declaration",
  await recoverCase("persisted never with safe declaration", "never", "safe", false),
);

// 7. Missing tool must not read or clear persisted arguments; only the checkpoint is consulted.
{
  const result = await recoverCase("missing tool checkpoint only", "safe", undefined, false);
  assert.deepEqual(result.events, INTERRUPT_EVENTS, "missing tool: only checkpoint IO is allowed");
  assert.ok(result.outcome?.message, "missing tool: no outcome was published");
  assert.equal(result.outcome.message.isError, true, "missing tool: outcome must be an error");
}

console.log("tool-recovery-order/transfer regression: 7 cases passed");
