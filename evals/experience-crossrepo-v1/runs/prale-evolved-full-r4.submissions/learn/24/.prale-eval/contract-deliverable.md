# Contract deliverable — duplicate delivery is harmless for WattClaw session synchronization

- Task: `learn/24` · repository `wattclaw` · mode `contract`
- Executable demo: `.prale-eval/duplicate-delivery-demo.mjs` (Node builtins only, no dependencies)
- Citation/contract validator: `.prale-eval/verify-citations.mjs`
- Result artifact: `.prale-eval/result.json`

## 1. Contract being asserted

> Repeating a session-synchronization delivery — the same gateway payload applied
> again, a second concurrent trigger for the same user, or a duplicated row inside
> one payload — must not double-write, double-scan, or resurrect deleted state.

The contract is carried by three mechanisms in `server/core/session-sync.js`:

| # | Mechanism | Symbol / lines | Guarantee |
|---|-----------|----------------|-----------|
| 1 | Per-user trigger coalescing | `inFlightByUserId` (14-15), `scheduleUserSessionSync` (179-216) | A concurrent duplicate returns the **same promise object**; a duplicate inside `cooldownMs` returns `{ changed: 0, skipped: true, reason: 'cooldown' }`. At most one gateway scan per user per window. |
| 2 | Idempotent persistence | sync loop 156-169 → `upsertSyncedUserSession` (`server/user-manager.js:614-688`) | Row is keyed by `session_key`; every field is compared before writing. An identical replay returns `{ changed: false, action: 'unchanged' }` and issues **no UPDATE**; counters stay `inserted=1, updated=0`. |
| 3 | Tombstone + monotonic activity | `recentlyDeletedSessionKeys` guard (161), `recentlyDeletedSessions` (`server/handlers/sessions.js:27,66,394`), `Math.max` merge with `normalizeSessionUpdatedAt` (`server/user-manager.js:549-562`) | A replayed delivery of a just-deleted session is dropped before any upsert; `last_message_at` can never move backwards, so even a stale duplicate is a no-op. |

Idempotency key: `session_key`, produced deterministically from the payload by the
pure `normalizeGatewaySessionForSync` (59-77). Delivery key for coalescing: `userId`.

## 2. Executable demo

```
node .prale-eval/duplicate-delivery-demo.mjs
```

The demo imports the **real** `server/core/session-sync.js`. That module's only
sync-path dependency is `../user-manager.js`, which pulls in `better-sqlite3`
(not installed here). The demo therefore copies the real source into
`.prale-eval/.harness/session-sync.mjs`, rewriting **only** the import specifier
`from '../user-manager.js'` → `from './user-manager-stub.mjs'`, and supplies an
in-memory stub whose `upsertSyncedUserSession` is a line-faithful transcription of
the comparison/write logic in `server/user-manager.js:614-688` (keyed by
`session_key`, all fields compared, `unchanged` short-circuit before the UPDATE).

Scenarios and assertions (18 checks, all PASS):

| Scenario | Assertion |
|----------|-----------|
| S1 sequential replay | 1st delivery: `changed=1, inserted=1`; replay: `changed=0, inserted=0, updated=0`; `insertWrites=1, updateWrites=0`; stored row JSON-identical; gateway still called with `sessions.list` only |
| S2 concurrent duplicate triggers | both calls return the **identical promise**; gateway invoked once; one row persisted; identical results |
| S3 duplicate inside cooldown | 2nd trigger `{ skipped: true, reason: 'cooldown' }`; gateway touched once; one upsert |
| S4 duplicated row in one payload | `scanned=2, changed=1`; second application `action: 'unchanged'`; one row |
| S5 replayed delivery of a deleted session | dropped both times; `upsertCalls=0`; zero rows |
| S6 deterministic normalization | same payload ⇒ byte-identical normalized session and same `sessionKey` |
| S7 stale replay | older `updatedAt` replay ⇒ `changed=0` and `last_message_at` unchanged (monotonic) |

Normalized operation result (machine-readable tail of the run):

```json
{
  "demo": "duplicate-delivery-is-harmless-for-session-synchronization",
  "checks": 18,
  "failed": 0,
  "status": "PASS"
}
```

## 3. Validation

```
node --check server/core/session-sync.js \
  && node .prale-eval/duplicate-delivery-demo.mjs \
  && node .prale-eval/verify-citations.mjs
```

- `node --check`: cited module parses.
- demo: 18/18 checks PASS (exit 0).
- `verify-citations.mjs`: re-reads `result.json`, confirms `task_id=24`,
  `repository=wattclaw`, `mode=contract` against the current `TASK.md`, confirms
  every evidence range is inclusive, in bounds, and actually contains the named
  symbol, confirms `server/core/session-sync.js` is covered by evidence **and** by
  at least one claim, and confirms every `claim.evidence_paths` entry resolves to
  a real workspace file with an evidence entry. Report: `problems: []`, `PASS`.

### Recorded limitation

`node_modules` is absent in this sandbox (no `vitest`, no `better-sqlite3`) and
dependencies must not be installed, so the repository's own runner
`npm run test:server` — which includes `server/core/session-sync.test.js` — could
**not** be executed. The in-repo tests are cited as contract text
(`coalesces scheduled syncs for the same user`, 122-138; `does not reinsert
recently deleted sessions`, 103-120), not as executed results. Consequently the
SQL layer of `upsertSyncedUserSession` is covered by the demo only through the
transcribed in-memory stand-in; that claim is additionally grounded by direct
citation of `server/user-manager.js:614-688`. Evidence strength for the database
layer is therefore lower than a full test-suite run would provide.
