# T10 — Contract: a failed effect leaves a retryable intent, not a terminal success

- **Repository:** `pi`
- **Mode:** `contract`
- **Execution path:** the agent harness **tool-execution path** — `executeToolCall` in
  `packages/agent/src/harness/execution/tools.ts`, as pinned by the public acceptance test
  `packages/agent/test/harness/execution-tools.test.ts`.

## 1. Claim under contract

> When a tool effect fails — the tool's `execute` throws synchronously **or** asynchronously —
> the harness must **normalize the failure into error output (`isError: true`)** that flows on to
> the after-tool patch pipeline and durable outcome publication. It must **never** collapse the
> failure into a successful (`isError: false`) terminal outcome. A gate refusal that happens
> *before* the effect is admitted must escape as a thrown abort, with the tool never invoked.

The retryable/error intent is the `{ isError: true }` `ExecutedToolCall`; the terminal-success
hazard is any path that would report `{ isError: false }` for an effect that did not actually
succeed.

## 2. Source-of-truth anchors

| Anchor | Location | Role |
| --- | --- | --- |
| Acceptance test | `packages/agent/test/harness/execution-tools.test.ts` L151–171 (`it.each`, "converts %s tool throws to error output") | Drives sync + async throws through `executeToolCall` and asserts `result.isError === true` and the failure text is preserved. |
| Abort boundary test | same file, L173–183 ("lets abort-first gate refusal escape without invoking the tool") | Asserts a pre-admission gate refusal throws `AbortRequested` and the tool is not called. |
| Implementation | `packages/agent/src/harness/execution/tools.ts` L125–158 (`executeToolCall`) | `try { return { result, isError: false } } catch { return { result: errorText, isError: true } }`; the `gate.admit(...)` boundary sits outside the normalizing `try`. |
| Durable intent | `packages/agent/src/harness/runtime/drive/tools.ts` L187–227 (`publishToolIntent`) | Publishes the `effect_pending` operation intent *before* the effect runs, so an interrupted/failed effect remains a recoverable, retryable operation rather than an unresolvable one. |

## 3. Normalized operation result

The contract decomposes the tool-execution boundary into a total, side-effect-free normalization
`normalizeToolEffect(execute) -> ExecutedToolCall`:

| Input | Normalized result |
| --- | --- |
| `execute()` resolves with a tool result | `{ result, isError: false }` |
| `execute()` throws `Error("tool failed")` (sync) | `{ result: { content: [{ type: "text", text: "tool failed" }], details: undefined }, isError: true }` |
| `execute()` rejects with `Error("tool failed")` (async) | identical to the sync case |
| gate refuses *before* admission (abort-first) | the refusal is thrown out of `executeToolCall` (never normalized); `execute` is never invoked |

This is exactly the shape returned by `executeToolCall` in `tools.ts` (L137–157) and the shape the
acceptance test asserts on: `expect(result.isError).toBe(true)` / `expect(text(result.result)).toBe("tool failed")`.

## 4. Executable demo

`.prale-eval/contract-demo.mjs` is a **self-contained** Node ESM demo (no package dependencies) that
models the boundary above and executes eight assertions across four scenarios:

1. synchronous throw → `isError === true` + message preserved;
2. asynchronous throw → `isError === true` + message preserved;
3. successful effect → `isError === false` (control, proves the normalizer does not blanket-fail);
4. aborted gate → `AbortRequested` escapes and the effect is never invoked.

It exits `0` and prints `CONTRACT SATISFIED` when the contract holds, and exits `1` with the
violated assertions otherwise.

```bash
node .prale-eval/contract-demo.mjs
# ->
#   PASS  sync throw isError === true
#   PASS  sync throw surfaces message
#   PASS  async throw isError === true
#   PASS  async throw surfaces message
#   PASS  success isError === false
#   PASS  success preserves output
#   PASS  abort-first refusal throws before admission
#   PASS  abort-first refusal executes no effect
#   CONTRACT SATISFIED: failed effects normalize to retryable error output, never terminal success.
```

## 5. Validation status and limitation

The repository's own acceptance suite (`vitest --run --config vitest.harness.config.ts
test/harness/execution-tools.test.ts`, i.e. `npm run test:harness` in `packages/agent`) is the
authoritative oracle, but it **could not be executed here**: this fixture ships **no `node_modules`**
(`find . -name node_modules` → 0 results) and no `vitest` binary, and installing dependencies is
out of scope for this task. The self-contained demo above therefore serves as the runnable,
dependency-free normalization of the same contract; the vitest limitation is recorded in
`result.json` → `validation.notes`.

## 6. Conclusion

Within the cited tool-execution path, a failed effect is normalized to a non-terminal error intent
(`isError: true`) and never to a terminal success; the abort boundary preserves this by refusing
before the effect runs. The contract holds.
