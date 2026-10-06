# Contract deliverable — focus test structure and minimal contract-test checklist

**Task:** learn/21 · **Repository:** `pi` · **Mode:** `contract`

**Source under contract:** `packages/agent/test/harness/execution-tools.test.ts` (255 lines)
**Production modules exercised:** `packages/agent/src/harness/execution/tools.ts`,
`packages/agent/src/harness/execution/effect-gate.ts`

---

## 1. Normalized observation: the setup/action/assertion structure

The focused suite `describe("tool execution primitives")` (lines 69–255) contains
nine cases that all share the same three-phase skeleton.

### Setup phase — deterministic local fixtures

| Fixture | Lines | Role |
| --- | --- | --- |
| `call(arguments_)` | 18–20 | Builds the fixed provider `AgentToolCall` (`id: "call-1"`, `name: "echo"`, default `{ value: "input" }`). |
| `tool(overrides)` | 22–38 | Returns an `AgentHarnessTool "echo"` with TypeBox `parameters` and an async `execute` that echoes `args.value`; `Partial` overrides inject `prepareArguments`, spies, or throwers. |
| `effectGate()` | 57–59 | `createGate().gate` — an open admission gate for `executeToolCall`. |
| `clearPrepared(callToClear)` | 50–55 | Composes `prepareToolCall` + `applyBeforeToolDecision(_, undefined)` to reach the cleared precondition. |
| `invocation` | 61–67 | Reusable `AgentHarnessToolInvocation` (`result-1` / `operation-1` / `turn-1`). |

### Action phase — exactly one exported primitive per case

`prepareToolCall`, `applyBeforeToolDecision`, `executeToolCall`, `finalizeToolCall`,
`createToolResultMessage` are each invoked once per case, with the outcome fed to the
next stage only through the `clearPrepared` helper.

### Assertion phase — branch-explicit and value-specific

- `isImmediate` (44–48) narrows the discriminated union (`"kind" in result`) so the
  error branch and the prepared/cleared branch are asserted separately.
- `text` (40–42) flattens `content` text parts so assertions compare exact strings.
- Assertions use `toBe`, `toEqual`, `toMatchObject`, `toHaveBeenCalledOnce`, and
  `not.toHaveBeenCalled()` against literal expected values.

---

## 2. Minimal contract-test checklist

Derived directly from the nine cases in the contract file. Each item names the
case/line that establishes it.

- [ ] **Deterministic fixtures, no shared mutable state.** Build the call, tool,
      gate, and invocation per test via local factories; inject variation with
      `Partial` overrides. *(lines 18–38, 57–67)*
- [ ] **One action per case.** Invoke a single exported pipeline primitive and carry
      its result forward explicitly (no hidden re-entry). *(70, 87, 104, 120, 151, 173, 185, 235, 245)*
- [ ] **Reach the documented precondition before acting.** Use `clearPrepared` so
      `executeToolCall` / `finalizeToolCall` only see a cleared call. *(50–55)*
- [ ] **Assert discriminated-union branches explicitly.** Narrow with `isImmediate`
      and assert the non-immediate branch separately. *(44–48, 70, 87, 104)*
- [ ] **Immediate error path:** unknown tool → `Tool "echo" is unavailable` with
      `details` undefined; `prepareArguments` throw → its message; schema-invalid
      args → contains `Validation failed for tool "echo"`. *(87–101)*
- [ ] **Before-tool decision:** block yields `{ kind: "immediate", isError: true }`
      with the reason text and respects `terminate`; replacement args are
      revalidated; invalid replacement is immediate. *(104–117)*
- [ ] **Execution contract:** the tool's `context.abortSignal` is the gate signal;
      `onUpdate` partials are forwarded exactly once; updates emitted after the
      awaited execution are dropped; final `isError === false` and final text is the
      resolved output. *(120–149)*
- [ ] **Error conversion is uniform:** both synchronous throws and async rejections
      become `isError === true` with the error message as text (use `it.each`).
      *(151–171)*
- [ ] **Abort-first refusal escapes without invoking the tool:** `createGate()` +
      `control.beginAbort(...)` makes `executeToolCall` throw `AbortRequested` and
      the executor is never called. *(173–182)*
- [ ] **After-tool patch is field-by-field:** content, details, usage, isError,
      terminate each override independently (undefined patch leaves the original).
      *(185–233)*
- [ ] **Message construction:** `role: "toolResult"`, `toolCallId`/`toolName` from
      the provider call, patched payload, and a fresh `timestamp >= Date.now()`
      captured before the call. *(185–233)*
- [ ] **Boundary — prototype-safe keys:** `__proto__` in details is preserved as an
      own property. *(235–243)*
- [ ] **Boundary — missing content normalizes to `[]`** for untyped tools. *(245–253)*

---

## 3. Validation status

- **Command attempted:** `npm --prefix packages/agent run test:harness -- test/harness/execution-tools.test.ts`
- **Status:** `blocked`
- **Limitation:** `vitest` is not installed in this workspace (`node_modules` is
  absent; `npx --no-install vitest` → `vitest: not found`, exit 127). Dependency
  installation is out of scope and was not performed.
- **Restricted-strength substitute evidence:** line ranges were verified
  programmatically — each cited `[start_line, end_line]` was parsed from the file
  and confirmed to contain its named symbol; all nine case headers at lines 70, 87,
  104, 120, 151, 173, 185, 235, 245 were confirmed.
