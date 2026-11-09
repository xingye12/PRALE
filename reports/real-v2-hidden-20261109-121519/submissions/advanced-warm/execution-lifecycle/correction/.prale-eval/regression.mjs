/**
 * Cross-module regression for the execution-lifecycle correction:
 *  1. runtime/drive/tools.ts  — a non-cancelled safe/safe pending effect is replayed.
 *  2. execution/tools.ts      — an after-tool patch may explicitly clear isError while
 *                               unspecified result fields/usage are preserved.
 *  3. execution/effect-gate.ts— a terminal close wins over a pending cancellation.
 *
 * Everything below runs the real submitted production modules (recovery entry, tool
 * executor, finalizer, effect gate, placement) linked through `.prale-eval/subject.mjs`.
 * Only checkpoint storage, progress transport and hook delivery are observable fakes.
 * No wall-clock time, randomness or network is used as evidence.
 */
import assert from "node:assert/strict";
import { createExecutionPipeline } from "./subject.mjs";

const INTERRUPTION_MARKER_START = "[Tool execution was interrupted.";
const root = process.cwd();
const pipeline = await createExecutionPipeline(root);

const passed = [];
async function test(name, body) {
  await body();
  passed.push(name);
  console.log(`ok - ${name}`);
}

const textOf = (message) => (message.content ?? []).map((block) => block.text ?? "").join("\n");
const markerCount = (message) => textOf(message).split(INTERRUPTION_MARKER_START).length - 1;

await test("safe/safe recovery replays persisted arguments through the real executor", async () => {
  const seen = [];
  const run = await pipeline.run({
    persisted: "safe",
    declared: "safe",
    arguments: { message: "persisted-arguments" },
    effect: async ({ args, invocation, context }) => {
      seen.push({ args, invocationId: invocation.invocationId, turnId: invocation.turnId });
      assert.deepEqual(context.abortSignal instanceof AbortSignal, true);
      return { content: [{ type: "text", text: args.message }], details: { kept: true }, usage: { output: 3 } };
    },
  });

  // The effect actually crossed the external boundary with the replayed arguments.
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].args, { message: "persisted-arguments" });
  assert.equal(seen[0].invocationId, "result-2");
  assert.equal(seen[0].turnId, "turn-1");

  // Checkpoint clearing happens before the replayed effect starts.
  assert.ok(run.events.includes("clear"), `missing replay clear: ${run.events.join(",")}`);
  assert.ok(run.events.includes("invoke"), `missing replayed invocation: ${run.events.join(",")}`);
  assert.ok(run.events.includes("effect-complete"));
  assert.ok(run.events.indexOf("clear") < run.events.indexOf("invoke"));
  assert.ok(!run.events.includes("read"), "safe replay must not settle from the checkpoint");

  // Observable outcome: the real tool result, not a synthetic interruption.
  assert.equal(run.outcome.message.isError, false);
  assert.equal(markerCount(run.outcome.message), 0);
  assert.deepEqual(run.outcome.message.content, [{ type: "text", text: "persisted-arguments" }]);
  assert.deepEqual(run.outcome.message.details, { kept: true });
  assert.deepEqual(run.outcome.message.usage, { output: 3 });
  assert.equal(run.outcome.terminate, false);
});

await test("unsafe declarations, unsafe intents and missing tools stay interrupted", async () => {
  const cases = [
    { label: "declared never", options: { persisted: "safe", declared: "never" } },
    { label: "declared missing", options: { persisted: "safe", declared: undefined } },
    { label: "intent never", options: { persisted: "never", declared: "safe" } },
  ];
  for (const { label, options } of cases) {
    const run = await pipeline.run(options);
    assert.ok(!run.events.includes("invoke"), `${label} must not replay the effect: ${run.events.join(",")}`);
    assert.ok(run.events.includes("read"), `${label} must read the checkpoint: ${run.events.join(",")}`);
    assert.ok(!run.events.includes("clear"), `${label} must not clear the checkpoint`);
    assert.equal(run.outcome.message.isError, true, label);
    assert.equal(markerCount(run.outcome.message), 1, label);
    assert.equal(run.events.at(-1), "publish", label);
    // Checkpoint evidence (and its details) survives into the interruption result.
    assert.match(textOf(run.outcome.message), /checkpoint-evidence/, label);
    assert.deepEqual(run.outcome.message.details, { step: 2 }, label);
  }
});

await test("a pending cancellation still wins over safe replay", async () => {
  const run = await pipeline.run({ persisted: "safe", declared: "safe", cancelled: true });
  assert.ok(!run.events.includes("invoke"), `cancelled recovery must not run the effect: ${run.events.join(",")}`);
  assert.ok(!run.events.includes("clear"), "cancelled recovery must not clear the checkpoint");
  assert.ok(run.events.includes("read"));
  assert.equal(run.outcome.message.isError, true);
  assert.equal(markerCount(run.outcome.message), 1);
  assert.match(textOf(run.outcome.message), /checkpoint-evidence/);
});

await test("an after-tool hook may explicitly clear isError on a failed effect", async () => {
  const run = await pipeline.run({
    persisted: "safe",
    declared: "safe",
    effect: async () => {
      throw new Error("effect failed");
    },
    patch: { isError: false },
  });

  assert.ok(run.events.includes("invoke"));
  assert.equal(run.outcome.message.isError, false, "explicit false patch must clear the error flag");
  assert.match(textOf(run.outcome.message), /effect failed/);
  assert.equal(run.outcome.terminate, false);
});

await test("an after-tool hook may still raise isError on a successful effect", async () => {
  const run = await pipeline.run({ persisted: "safe", declared: "safe", patch: { isError: true } });
  assert.equal(run.outcome.message.isError, true);
  assert.deepEqual(run.outcome.message.content, [{ type: "text", text: "persisted-arguments" }]);
});

await test("patch application preserves unspecified fields and usage while applying false/empty", async () => {
  const run = await pipeline.run({
    persisted: "safe",
    declared: "safe",
    patch: { content: [], isError: false, terminate: false, details: undefined, usage: undefined },
  });

  // Explicit empty/false values are applied instead of being treated as "unchanged".
  assert.deepEqual(run.outcome.message.content, []);
  assert.equal(run.outcome.message.isError, false);
  assert.equal(run.outcome.terminate, false);
  // Unspecified fields are preserved from the executed result.
  assert.deepEqual(run.outcome.message.details, { kept: true });
  assert.deepEqual(run.outcome.message.usage, { output: 3 });
});

await test("no patch preserves the whole executed result unchanged", async () => {
  const run = await pipeline.run({ persisted: "safe", declared: "safe" });
  assert.deepEqual(run.checkpoints, []);
  assert.deepEqual(run.outcome.message.details, { kept: true });
  assert.deepEqual(run.outcome.message.usage, { output: 3 });
  assert.equal(run.outcome.message.isError, false);
});

await test("a terminal close of an aborting gate is authoritative for later admissions", async () => {
  const terminal = new Error("terminal drive failure");

  // Crosses the real gate from inside a real tool effect: the pending cancellation must not
  // swallow the terminal error that the after-tool admission then observes.
  await assert.rejects(
    pipeline.run({
      persisted: "safe",
      declared: "safe",
      effect: async ({ control }) => {
        control.beginAbort(new Promise(() => {}));
        control.close(terminal);
        return { content: [{ type: "text", text: "effect body" }], details: { kept: true } };
      },
    }),
    (error) => error === terminal,
  );

  // Same gate object the drive pass used: aborting refuses with AbortRequested, but a
  // terminal close replaces that pending cancellation for every later admission.
  const first = await pipeline.run({ persisted: "safe", declared: "safe" });
  first.control.beginAbort(new Promise(() => {}));
  assert.throws(
    () => first.gate.admit(() => "admitted"),
    (error) => error.name === "AbortRequested" && "cancellation" in error,
  );
  first.control.close(terminal);
  assert.throws(
    () => first.gate.admit(() => "admitted"),
    (error) => error === terminal,
  );
  assert.equal(first.gate.signal.aborted, true);
  // A late cancellation request cannot reopen or override the closed gate.
  first.control.beginAbort(new Promise(() => {}));
  first.control.signalAbort();
  assert.throws(
    () => first.gate.admit(() => "admitted"),
    (error) => error === terminal,
  );
});

console.log(`\n${passed.length} cross-module regression checks passed`);
