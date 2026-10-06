# Operate deliverable — JSONL/session lineage report (`pi`, task 04)

## What was operated

The real `@earendil-works/pi-agent-core` session utilities, not a reimplementation:

| Utility | Source | Role in the operation |
| --- | --- | --- |
| `JsonlStorage.create` / `commit` / `close` | `packages/agent/src/harness/session/jsonl/storage.ts` | Wrote the tiny v4 fixture (header + one transaction line per commit). |
| `JsonlStorage.open` / `getEntries` / `getValue` / `getStats` | same | Replayed the fixture from disk into storage state. |
| `insertEntry` / `insertUsage` | `packages/agent/src/harness/session/commit.ts` | Built the entry writes. |
| `branchTip` / `setValue` | `packages/agent/src/harness/session/values.ts` | Addressed the branch-tip stored value. |
| `buildSessionContext` | `packages/agent/src/harness/session/context.ts` | Projected the replayed lineage into agent messages. |

## Executable demo

```bash
node --import ./.prale-eval/operate/register.mjs ./.prale-eval/operate/lineage-demo.mjs
```

Files:

- `.prale-eval/operate/lineage-demo.mjs` — the operation (phases 1–3 below).
- `.prale-eval/operate/register.mjs` + `.prale-eval/operate/resolve-hooks.mjs` — a Node
  module-resolution shim mapping the workspace specifiers that
  `packages/agent/vitest.harness.config.ts` aliases (`@earendil-works/pi-ai`,
  `@earendil-works/pi-ai/utils/uuid`, `@earendil-works/pi-telemetry`,
  `@earendil-works/chord[/context]`) to their `src/*.ts` entries. This exists only because
  `node_modules` is not installed; it installs nothing.
- `.prale-eval/operate/tiny-session.jsonl` — the supplied tiny fixture (v4 JSONL, 3 lines).
- `.prale-eval/operate/lineage-report.json` — the normalized operation result.

The demo is re-runnable and deterministic apart from the fixture's `cwd`, which points at a
fresh temp directory each run; the temp directory is removed on exit.

## The supplied tiny fixture

One header line plus one transaction line per commit (`serializeJsonlTransaction` in
`jsonl/io.ts`; a single write is serialized bare, multiple writes as an array):

```json
{"v":4,"kind":"header","id":"tiny-lineage-fixture","storageVersion":1,"createdAt":1700000000000,"cwd":"<temp>"}
[{"kind":"entry","id":"root","parentId":null,"type":"message","message":{"role":"user","content":"hello root","timestamp":1},"seq":1,"timestamp":1700000000000},
 {"kind":"entry","id":"child","parentId":"root","type":"message","message":{"role":"user","content":"hello child","timestamp":2},"seq":2,"timestamp":1700000000000},
 {"kind":"value","op":"set","seq":3,"namespace":"pi.branch.tip","key":"main","value":"child"}]
```

## Operation and normalized result

1. **Supply** — `JsonlStorage.create(options, header, [], BACKGROUND_CONTEXT)` publishes the
   header, then `commit([...])` writes the root entry, the child entry, and the `pi.branch.tip`
   value, stamping seq 1/2/3 at the fixed clock `NOW = 1_700_000_000_000`. `close()` flushes.
2. **Replay** — a fresh `JsonlStorage.open` on the same path replays every committed line
   through `parseJsonlTransaction`, then `getEntries`/`getValue`/`getStats` read the state back.
3. **Project** — `buildSessionContext` is applied to the replayed entries in seq order.

Lineage report (`.prale-eval/operate/lineage-report.json`):

| Field | Result |
| --- | --- |
| Session ID | `tiny-lineage-fixture` |
| Branch | `main` |
| Branch tip | `child` (`pi.branch.tip` value at seq 3) |
| Parent relation | `child.parentId = "root"`, `root.parentId = null` → root → child, `resolvesToRoot: true` |
| Replay result | `ok: true`, 2 entries recovered in seq order (seq 1 root, seq 2 child, timestamp 1700000000000), `messageCount: 2` |
| Projection | `ok: true`, 2 messages: `["hello root", "hello child"]` in branch order |

## Contract

- The fixture format is JSONL format version 4 (`JSONL_FORMAT_VERSION = 4`): exactly one header
  object, then one JSON value per committed transaction — a bare object for a single write, an
  array for a multi-write transaction. Every write carries a monotonic `seq`; entries also carry
  `timestamp`.
- Entry lineage is expressed by `id` / `parentId`; the active leaf is the stored value at
  namespace `pi.branch.tip`, keyed by branch name.
- Replay is idempotent: the replayed entry set must equal the committed set, and the branch tip
  must resolve to the same entry id and seq across close/reopen.

## Validation

Command: `node --import ./.prale-eval/operate/register.mjs ./.prale-eval/operate/lineage-demo.mjs`
— **passed** (exit 0, report emitted).

**Limitation:** the repository test runner is unavailable. `node_modules` is not installed and
dependencies must not be installed in this task, so
`vitest --run --config vitest.harness.config.ts test/harness/jsonl-storage.test.ts test/harness/session-context.test.ts`
could not be executed. The demo instead runs the same harness sources directly under Node v24
native TypeScript type stripping. The watched vitest suites themselves were therefore not run;
their assertions are cited as evidence in `.prale-eval/result.json` rather than executed.
