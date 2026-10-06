# T25 — session-sync duplicate-event contract

**Repository:** `wattclaw` · **Mode:** `contract`
**Contract:** replaying one session update cannot double-count usage or emit duplicate state changes.

## What is being contracted

WattClaw's Gateway → SQLite session sync (`server/core/session-sync.js`) must be
**idempotent under event replay**. A single session update can reach the backend
more than once (a re-delivered `sessions.changed` frame, a manual refresh, or two
overlapping scheduled syncs). The contract fixes the observable behaviour of that
replay:

1. the change counters (`changed` / `inserted` / `updated`) do not increase on the
   second delivery;
2. the usage-affecting write happens exactly once;
3. no duplicate state-change / refresh notification is emitted;
4. concurrent or cooldown-window replays are coalesced or skipped, not re-run.

## Normalized operation result

| Delivery | `changed` | `inserted` | `updated` | usage writes | state changes |
|---|---|---|---|---|---|
| first (fresh session update) | 1 | 1 | 0 | 1 | 1 |
| replay (identical payload)   | 0 | 0 | 0 | 1 | 1 |

The replay leaves every cumulative counter unchanged. A subsequent genuine
activity advance adds exactly one more change; a stale replay of it adds nothing
and cannot roll `last_message_at` backwards.

## Executable demo

```
node .prale-eval/duplicate-event.fixture.mjs
```

The fixture loads the **real** `server/core/session-sync.js` and exercises five
duplicate-event scenarios (16 assertions, all passing):

| # | Scenario | Asserted outcome |
|---|---|---|
| S1 | Replay one identical session update through `syncUserSessionsFromGateway` | 1st delivery `changed=1`; replay `changed=0`; `usageWrites=1`; `stateChanges=1`; upsert reports `unchanged` |
| S2 | Apply a real activity advance, then replay it | advance counts once; replay counts zero; monotonic `last_message_at` is not rolled back |
| S3 | Two concurrent `scheduleUserSessionSync` calls for one user | single Gateway `sessions.list`, callers share one promise, one state change |
| S4 | Replay inside the cooldown window | `{ skipped: true, reason: 'cooldown' }`, no state change, no Gateway call |
| S5 | Replay emits a refresh event | `onChanged` never invoked (V1 sync is silent) |

Final fixture output:

```json
{
  "task_id": "T25",
  "fixture": "duplicate-event",
  "contract": "replaying one session update cannot double-count usage or emit duplicate state changes",
  "scenarios": 5,
  "checks": 16,
  "status": "passed"
}
```

## How the code guarantees it

- **Keyed, non-additive write.** `upsertSyncedUserSession`
  (`server/user-manager.js:614-689`) is keyed by `session_key`, which carries a
  global `UNIQUE` index on `user_sessions` (`server/database.js:860-872`). Every
  projected field is compared and `last_message_at` advances monotonically via
  `Math.max(currentLastMessageAt, lastMessageAt)`; when nothing differs it returns
  `{ changed: false, action: 'unchanged' }`. Nothing is accumulated.
- **Changed-only counting.** `syncUserSessionsFromGateway`
  (`server/core/session-sync.js:118-177`) gates `changed`/`inserted`/`updated` on
  `result.changed`, so an unchanged replay adds zero to the counters.
- **Deterministic normalization.** `normalizeGatewaySessionForSync`
  (`server/core/session-sync.js:59-77`) collapses Gateway's alternative field
  names, so two deliveries of one event normalize identically and the replay is
  recognized as a no-op.
- **Coalescing and cooldown.** `scheduleUserSessionSync`
  (`server/core/session-sync.js:179-216`) returns the existing in-flight promise
  for a concurrent replay and skips a replay inside `cooldownMs`.
- **Replay entry point.** `handleSessionsChanged`
  (`server/core/message-sync.js:126-154`) reuses the same idempotent upsert, so a
  duplicated `sessions.changed` frame cannot create a second projection.

## Validation and environment limitation

Command run: `node .prale-eval/duplicate-event.fixture.mjs` → **passed** (16/16).

`node_modules` is not installed and the task forbids installing dependencies, so
the project's vitest suite (`npm run test:server`) could not be executed, and the
DB-backed `server/user-manager.js` cannot be imported (it opens `better-sqlite3`).
The fixture therefore uses only Node built-ins (`node:module` `registerHooks`) and
serves an in-memory stand-in for the `user-manager` exports whose transition
semantics mirror `upsertSyncedUserSession` (keyed by the globally-UNIQUE
`session_key`, `changed:false` on an identical replay, monotonic
`last_message_at`). The `session-sync.js` control flow, counters, coalescing and
cooldown logic under test are the real code paths.
