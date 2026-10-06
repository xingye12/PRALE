# Contract deliverable — effect cannot be observed before durable intent settlement

Repository: `pi` · Task: `03` · Mode: `contract`

## Contract statement

For every AgentHarness operation, the observable **effect** is gated on the operation's **durable
intent settlement**:

> An operation's effect cannot be observed before its durable intent has settled.

The repository enforces this at three layers that compose into one guarantee:

1. **Admission (`packages/agent/src/harness/agent-harness.ts`).** `AgentLane.accept(request)` durably
   commits the operation `meta` (which carries `intent`) plus its initial `OperationState`, and only
   then resolves with a value containing `operationId`. Every effect-producing call — `drive`,
   `prompt`, `compact`, `navigateTree`, `resume` — requires an operation id that acceptance created
   (`DriveOptions.operationId`). Without a settled admission there is no id to drive, so no effect
   exists to observe.

2. **Publication (`packages/agent/src/harness/runtime/drive/tools.ts`).** For a tool call,
   `startToolInvocation` first awaits `publishToolIntent`, which commits the prepared arguments under
   the `pi.op.tool_args` namespace and moves the operation to `effect_pending` via
   `lane.continueOperation`. Only after that commit resolves does it call `performToolInvocation`,
   i.e. the tool body runs strictly after the durable intent write has landed.

3. **Execution boundary (`packages/agent/src/harness/execution/tools.ts`).** `executeToolCall` is the
   one place a tool effect crosses the external boundary, and it runs the tool only inside
   `gate.admit(...)`. A gate that is still settling (`aborting`) throws `AbortRequested` synchronously
   before `tool.execute` is reached; a closed gate throws the stored error. Either way the effect and
   its partial updates are never observed.

`Lane.settleOperation` / `continueOperation` (`packages/agent/src/harness/runtime/lane.ts`) are the
durable commit primitive underneath: the storage commit is awaited before the in-memory state,
materializer and events, and `continueOperation` refuses to start new hooks/effects once durable
control is `cancel_requested`.

## Executable demo (minimal contract test)

Added to `packages/agent/test/harness/execution-tools.test.ts`, inside
`describe("tool execution primitives")`:

```ts
it("keeps an operation's effect unobservable until durable intent settlement admits it", async () => {
    const observed: string[] = [];
    const execute: AgentHarnessTool<undefined, typeof parameters, { value: string }>["execute"] = vi.fn(
        async (_toolCallId: string, args: { value: string }) => {
            observed.push("effect");
            return { content: [{ type: "text" as const, text: args.value }], details: { value: args.value } };
        },
    );
    const cleared = clearPrepared(prepareToolCall(call(), [tool({ execute })]));

    // Settlement still pending: the gate refuses admission synchronously, so the effect is unobservable.
    const { gate, control } = createGate();
    control.beginAbort(new Promise<void>(() => {}));
    expect(() =>
        executeToolCall(cleared, gate, () => observed.push("update"), undefined, invocation, BACKGROUND_CONTEXT),
    ).toThrow(AbortRequested);
    expect(execute).not.toHaveBeenCalled();
    expect(observed).toEqual([]);

    // Settled intent admitted: the effect becomes observable exactly once.
    const admitted = createGate();
    const result = await executeToolCall(
        cleared, admitted.gate, () => observed.push("update"), undefined, invocation, BACKGROUND_CONTEXT,
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(observed).toEqual(["effect"]);
    expect(result.isError).toBe(false);
    expect(text(result.result)).toBe("input");
});
```

### What the demo shows

- **Unsettled / settled-against-the-effect ⇒ nothing observable.** `control.beginAbort(...)` models
  the drive marking settlement in progress (the durable cancel request is committed by
  `Lane.requestOperationAbort`). While that settlement is pending, `gate.admit` throws
  `AbortRequested` before `tool.execute`, so the spy is not called, the update callback is not
  called, and `observed` stays `[]`.
- **Settled and admitted ⇒ observable, exactly once.** A gate that admits the settled intent runs the
  tool body once; `observed` becomes `["effect"]` and the tool result is the effect's own output.

This is a minimal, deterministic unit-level pin of the execution boundary; the drive-level ordering
(`publishToolIntent` commit before `performToolInvocation`) is the same invariant asserted
end-to-end by the existing `durable tool batch` suite
(`packages/agent/test/harness/runtime/drive-tools.test.ts`,
`firstIntent < firstStart`).

## Validation

Intended focused command:

```
cd packages/agent && npx vitest --run --config vitest.harness.config.ts test/harness/execution-tools.test.ts
```

**Status: unavailable in this checkout.** The workspace has no `node_modules` (neither repo root nor
`packages/agent`) and no `vitest`/`tsx`/`tsgo`/`tsc` on `PATH`. Installing dependencies is out of
scope for this task, so the test was authored to mirror the surrounding known-good patterns and must
be executed with the command above once dependencies are installed.
