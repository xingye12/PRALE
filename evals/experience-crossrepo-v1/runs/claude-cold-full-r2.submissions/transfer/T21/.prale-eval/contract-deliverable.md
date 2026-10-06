# T21 — Fake client operation contract (MemoryCore)

**Repository:** `tdam` · **Mode:** `contract` · **Public surface:** `MemoryCore/src/core/index.ts`

## Normalized operation result

| Field | Value |
| --- | --- |
| Operation | `InstanceConfigProvider.resolveVdb(instanceId)` |
| Public surface | `InstanceConfigProvider`, re-exported by `MemoryCore/src/core/index.ts:31-34` |
| Client seam | injected `IConfigSource` (`fetchVdb` / `fetchCos`) — substituted with a fake, no production code touched |
| Success state | the per-instance VDB cache entry, observable through the public `poolSize` accessor (and the cache-hit fast path) |
| Fake effect | the fake client's `fetchVdb` promise, settled only when the test calls `completeEffect()` / `failEffect()` |
| Result | **contract holds** — success state is committed only after the client effect settles; a failed effect stays observable and leaves no cached state |

## The contract

Two properties are asserted, both against the real production object:

1. **No success state before the effect completes.** While the fake client's
   `fetchVdb` promise is pending, `resolveVdb` has already reached the client but
   `poolSize` is still `0`. The provider's cache is written only in
   `fetchAndStoreVdb`, *after* `await this.source.fetchVdb(instanceId)`
   (`instance-config-provider.ts:216` → cache write at `:231`). The test also
   drains microtasks before re-asserting, so a premature `set()` would be caught
   rather than hidden by timing.
2. **Failure remains observable.** A rejecting client effect propagates out of
   `resolveVdb` instead of being swallowed into a cached success, no cache entry
   is written, and the in-flight dedupe marker is removed in a `finally`
   (`:204-208`) so the instance is not stranded — a retry issues a fresh client
   operation. A client that *resolves* with an unusable payload (`{}` with no
   `url`) is likewise surfaced as a thrown error (`:219-223`), not a cache fill.

## Executable demo

The vitest suite is the primary artifact:

```
MemoryCore/src/core/__tests__/instance-config-provider.fake-client.test.ts
```

It uses a `FakeConfigClient implements IConfigSource` whose `fetchVdb` parks a
`{resolve, reject}` pair, so "before the effect completes" is an observable
instant rather than a race. Cases:

| Case | Asserts |
| --- | --- |
| commit gating | `poolSize === 0` while pending (also after a microtask drain); `=== 1` only after `completeEffect()` |
| in-flight dedupe | two concurrent callers ⇒ one client call, zero commits until the shared effect settles |
| failure observable | `failEffect()` ⇒ `resolveVdb` rejects, `poolSize` stays `0` |
| retry after failure | second call re-reaches the client (`fetchVdbCalls === 2`) and can commit |
| unusable payload | client resolving `{}` ⇒ rejection matching `/empty VDB config/`, nothing cached |
| barrel contract | `src/core/index.ts` textually re-exports `InstanceConfigProvider` |

Because this workspace has no `node_modules`, the suite was **not** run under
vitest. Instead the same assertions are reproduced dependency-free and executed
with Node's native TypeScript support:

```bash
node --experimental-transform-types .prale-eval/run-fake-client-demo.mjs
```

`run-fake-client-demo.mjs` imports the real
`MemoryCore/src/core/instance-config-provider.ts` (via the ~20-line
`ts-resolve.mjs` hook, which maps the repo's `./x.js` specifiers onto `x.ts`)
and runs the six checks above with `node:assert/strict`.

**Observed output:**

```
InstanceConfigProvider fake client — commit gating
  PASS  no cache entry while the client effect is pending
  PASS  concurrent callers share one effect, commit once after it completes
  PASS  a failing client effect rejects and caches nothing
  PASS  after failure a retry reaches the client and can succeed
  PASS  unusable client payload surfaces as an observable failure
  PASS  src/core/index.ts re-exports InstanceConfigProvider

All 6 checks passed.
```

**Negative control.** A temporary mutant of `fetchAndStoreVdb` that writes the
cache entry *before* awaiting `source.fetchVdb` was fed to the same gating
assertion, and was correctly caught (`poolSize !== 0` while the effect was
pending). This shows the assertion is not vacuous. The mutant file was deleted;
no production source, task metadata, lockfile, or git configuration was modified.

## Changes made

| File | Change |
| --- | --- |
| `MemoryCore/src/core/__tests__/instance-config-provider.fake-client.test.ts` | new — the fake-client operation test |
| `.prale-eval/run-fake-client-demo.mjs` | new — dependency-free executable mirror of the suite |
| `.prale-eval/ts-resolve.mjs` | new — validation-only Node resolve hook for the repo's `./x.js` → `x.ts` convention |
| `.prale-eval/result.json` | new — required result artifact |
| `.prale-eval/contract-deliverable.md` | new — this document |

No production source under `MemoryCore/src` was changed.
