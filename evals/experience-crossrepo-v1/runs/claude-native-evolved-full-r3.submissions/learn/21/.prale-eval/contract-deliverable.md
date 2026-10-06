# Contract deliverable — learn/21 (repo `pi`, mode `contract`)

Minimal contract-test checklist distilled from the focused suite
`packages/agent/test/harness/execution-tools.test.ts` and the module it pins,
`packages/agent/src/harness/execution/tools.ts`.

## 1. What the contract covers

The focused test is one `describe("tool execution primitives")` block of nine
cases (lines 69–255). It is the public acceptance contract for the exported
primitives that turn a provider tool call into a durable tool-result message:

```
prepareToolCall → applyBeforeToolDecision → executeToolCall → finalizeToolCall → createToolResultMessage
```

## 2. The executable demo (arrange / act / assert)

The suite is itself the executable demo of the pattern. Its skeleton:

```ts
// ARRANGE — a tiny factory surface, no cross-test mutable state
const providerCall = call({ legacy: "prepared" });        // call()    lines 18-20
const echo = tool({ prepareArguments: (a) => ({ value: a.legacy }) }); // tool() lines 22-38
const cleared = clearPrepared(prepareToolCall(providerCall, [echo]));  // lines 50-55
const gate = effectGate();                                 // lines 57-59

// ACT — invoke exactly one exported primitive, guard the union
const prepared = prepareToolCall(providerCall, [echo]);
if (isImmediate(prepared)) return;                         // isImmediate() lines 44-48

// ASSERT — shape + exact text + identity / effect
expect(prepared.toolCall).toBe(providerCall);              // identity preserved
expect(prepared.args).toEqual({ value: "prepared" });      // prepared then validated
```

Key techniques to copy:

- **`tool(overrides)` spreads `overrides` last** (lines 22–38): every test
  changes only the field under test and inherits a valid default tool.
- **`clearPrepared()`** (lines 50–55): folds the prepare + decision stages into
  one valid `ClearedToolCall` so execute/finalize tests do not re-assert the
  preamble.
- **`isImmediate()` type guard** (lines 44–48): the branching idiom for the
  `Prepared | Immediate` union; tests assert `kind` structurally instead of
  casting.
- **`text(result)`** (lines 40–42): flattens content parts so error output can
  be asserted as an exact string.

## 3. Normalized operation result

Each stage returns a discriminated, normalized value — assert on these shapes:

| Stage | Success shape | Failure shape |
| --- | --- | --- |
| `prepareToolCall` | `{ toolCall, tool, args }` | `{ kind: "immediate", result, isError: true, terminate: boolean }` |
| `applyBeforeToolDecision` | `{ toolCall, tool, args }` (re-validated) | same immediate shape (block or invalid replacement) |
| `executeToolCall` | `{ result, isError: false }` | `{ result: <error text>, isError: true }`; throws `AbortRequested` at an abort-first gate |
| `finalizeToolCall` | `{ toolCall, result, isError, terminate }` (patched field by field) | — |
| `createToolResultMessage` | `{ role: "toolResult", toolCallId, toolName, content ?? [], details?, usage?, isError, timestamp }` | — |

## 4. Minimal contract-test checklist

**Arrange**
- [ ] Build the input via `call(args)`; keep its object identity if the contract
      says the provider call must be preserved.
- [ ] Build the tool via `tool({ …delta })`; override only the field under test.
- [ ] Where execution is involved, obtain a `ClearedToolCall` via
      `clearPrepared(...)`, and use a real gate from `effectGate()`/`createGate()`.

**Act**
- [ ] Invoke exactly **one** exported primitive per test.
- [ ] Branch on the result union with the `isImmediate` guard; never cast.

**Assert**
- [ ] Structural discriminator: `kind`, `isError`, `terminate` (`toMatchObject`).
- [ ] Exact user-facing error text via `text(result)`.
- [ ] Identity/effect: `toBe(providerCall)`, `toHaveBeenCalledOnce()`,
      `not.toHaveBeenCalled()`.
- [ ] Time-derived fields asserted as a bound (`toBeGreaterThanOrEqual(before)`),
      never exact equality.

**Required boundary cases** (all present in the suite)
- [ ] Unknown tool → immediate `Tool "<name>" is unavailable`, `details` undefined.
- [ ] `prepareArguments` throws → immediate error with the thrown message.
- [ ] Schema-invalid arguments → immediate `Validation failed for tool "<name>"`.
- [ ] Block decision → immediate, `isError: true`, `terminate` propagated, exact reason.
- [ ] Replacement arguments → re-validated; an invalid replacement is rejected.
- [ ] Synchronous **and** asynchronous tool throws → resolved `isError: true`,
      never rejected (table-driven `it.each`).
- [ ] Abort-first gate → throws `AbortRequested` and the tool is **not** invoked.
- [ ] `__proto__` key in details survives (`Object.hasOwn`).
- [ ] Untyped tool with `content: undefined` → message `content` is `[]`.

## 5. Validation

Intended focused command (from `packages/agent`):

```
npx vitest --run --config vitest.harness.config.ts test/harness/execution-tools.test.ts
```

Status: **unavailable** — no `node_modules` is installed in this workspace and
installing dependencies is out of scope. A dependency-free static anchor check
was run instead and **passed for all 13 cited ranges** (each `(symbol, start,
end)` triple re-read from the test file with `sed`/`grep -F`, rc=0). See
`.prale-eval/result.json` → `validation.notes` for detail.
