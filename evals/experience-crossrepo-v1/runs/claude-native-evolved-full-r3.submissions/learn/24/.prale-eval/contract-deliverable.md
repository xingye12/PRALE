# Contract deliverable — duplicate delivery is harmless for session synchronization

Task: `learn/24` (repository `wattclaw`, mode `contract`).

## Claim under contract

Delivering the same Gateway session-sync input more than once produces the **same
resulting state** as delivering it once. There is no duplicate row, no double
mutation, and no extra Gateway call.

## Executable demo

`node .prale-eval/duplicate-delivery-demo.mjs`

The demo runs the **verbatim source of `server/core/session-sync.js`**. It reads
the file, replaces only the `import ... from '../user-manager.js'` block with an
in-memory store, and imports the patched source through a `data:` URL. Every
function exercised (`syncUserSessionsFromGateway`, `scheduleUserSessionSync`,
`normalizeGatewaySessionForSync`, `mapWithConcurrency`, `withTimeout`) is the
unmodified repository code.

The substitution is required because `node_modules` is not installed
(`better-sqlite3` unavailable) and dependencies must not be installed in this
workspace. The in-memory `upsertSyncedUserSession` faithfully mirrors the
idempotency contract of the real implementation in `server/user-manager.js`
(keyed on `session_key`; identical projection returns
`{ changed: false, action: 'unchanged' }`; `last_message_at` advanced with
`Math.max`).

### Scenarios and observed results

| # | Scenario | Input duplication | Observed |
|---|----------|-------------------|----------|
| A | Identical redelivery | Same `sessions.list` payload twice | `changed=2` then `changed=0`; `rows=2` |
| B | Out-of-order replay | Newer row, then older row for same key | replay `changed=0`; `lastMessageAt` stays `5000` |
| C | Concurrent schedules | Two `scheduleUserSessionSync` calls in parallel | `gatewayCalls=1` (in-flight coalesced) |
| D | Rapid re-schedule | Second call inside the cooldown window | `gatewayCalls=1`, `skipped=true`, `reason=cooldown` |

Result printed by the demo:

```json
{
  "operation": "duplicate-delivery-vs-session-sync",
  "verdict": "duplicate delivery is harmless (idempotent)",
  "source": "server/core/session-sync.js",
  "scenarios": [
    { "name": "A. identical redelivery is idempotent", "firstChanged": 2, "secondChanged": 0, "rows": 2 },
    { "name": "B. out-of-order duplicate cannot regress", "replayChanged": 0, "lastMessageAt": 5000 },
    { "name": "C. concurrent duplicate schedules coalesce", "gatewayCalls": 1 },
    { "name": "D. cooldown absorbs rapid duplicate", "gatewayCalls": 1, "reason": "cooldown" }
  ]
}
```

## Contract (normalized operation semantics)

For a sync operation `S(userId, role, gatewayRpc)` and any Gateway listing `L`:

1. **Stable key.** `normalizeGatewaySessionForSync(row)` deterministically maps a
   raw row to `{ sessionKey, ... }`, or returns `null` for unusable rows
   (`server/core/session-sync.js:59-77`). Same row ⇒ same `sessionKey`.
2. **Keyed upsert.** Every accepted row is applied through
   `upsertSyncedUserSession`, which SELECTs by `session_key`. Absent ⇒ insert with
   a fresh UUID and `action: 'inserted'`; present and identical ⇒ `changed:false,
   action:'unchanged'` with no UPDATE (`server/user-manager.js:614-689`).
3. **Monotonic activity.** `last_message_at` only moves forward via `Math.max`,
   so a late/duplicate delivery of an older event is absorbed.
4. **Change accounting.** `syncUserSessionsFromGateway` counts only transitions
   (`action === 'inserted' | 'updated'`), so a duplicate delivery reports
   `changed: 0` (`server/core/session-sync.js:156-169`).
5. **Scheduling coalescing.** `scheduleUserSessionSync` returns the in-flight
   promise for a repeat while a sync is running, and returns
   `{ changed: 0, skipped: true, reason: 'cooldown' }` inside the cooldown window
   (`server/core/session-sync.js:179-216`).

**Idempotency law:** applying `S` twice with the same listing `L` yields the same
state as applying it once, and the second application performs no writes and no
additional Gateway calls.

## Supporting repository evidence

- `server/core/session-sync.js:118-177` — `syncUserSessionsFromGateway`, the
  orchestration and change accounting.
- `server/core/session-sync.js:179-216` — `scheduleUserSessionSync`, in-flight
  coalescing + cooldown.
- `server/core/session-sync.js:59-77` — deterministic normalization / keying.
- `server/user-manager.js:614-689` — `upsertSyncedUserSession`, the idempotency
  primitive (`unchanged`, monotonic `Math.max`).
- `server/core/session-sync.test.js:122-138` — existing test asserting
  `calls === 1` for concurrent duplicate schedules.

## Validation

```
node .prale-eval/duplicate-delivery-demo.mjs   # exit 0, all 4 scenarios pass
```

Node v24.14.0. The repo's `vitest` suite could not be executed because
`node_modules` is not installed and dependencies must not be installed; that
limitation is recorded in `.prale-eval/result.json` → `validation.notes`.
