# T25 — Duplicate-event contract (wattclaw)

**Contract:** replaying one Gateway session update must not double-count usage and must
not emit a duplicate state change.

**Mode:** contract · **Repository:** wattclaw · **Evidence:** `server/core/session-sync.js`

## Executable demo

| Path | Role |
| --- | --- |
| `.prale-eval/fixtures/duplicate-event/run.mjs` | Fixture entry point and assertions |
| `.prale-eval/fixtures/duplicate-event/loader.mjs` | `node:module` resolve hook that swaps session-sync's one dependency |
| `.prale-eval/fixtures/duplicate-event/user-manager.stub.mjs` | In-memory stand-in mirroring `upsertSyncedUserSession` |

Run it:

```bash
node .prale-eval/fixtures/duplicate-event/run.mjs
```

The fixture imports the **unmodified** `server/core/session-sync.js`. `session-sync.js` has
exactly one import (`../user-manager.js`), so the resolve hook in `loader.mjs` replaces just
that specifier with the stub and every line of the production module executes unchanged.
No dependencies are installed — the fixture uses only Node built-ins (`node:assert`,
`node:module`).

### The duplicate-event fixture

One frozen event is delivered to the sync loop:

```js
{ key: 'agent:agent-a:feishu:dm:ou_dup_event_1', agentId: 'agent-a', channel: 'feishu',
  peer: 'ou_dup_event_1', displayTitle: 'Duplicate event fixture',
  lastMessageAt: '2026-06-05T12:00:00.000Z' }
```

Sequence:

1. Deliver the event once → expect `changed=1, inserted=1`, one row write, usage applied once.
2. Replay the **identical** event → expect `changed=0, inserted=0, updated=0`, no new write,
   usage total unchanged.
3. Replay concurrently via `scheduleUserSessionSync` (twice, `cooldownMs: 0`) → the second call
   reuses the in-flight promise, so only one Gateway call happens.
4. Deliver a genuinely newer event (`lastMessageAt` +1h) → still applied exactly once, guarding
   against over-suppression.

### Observed result

```json
{
  "firstRun":    { "changed": 1, "inserted": 1 },
  "replayedRun": { "changed": 0, "inserted": 0, "updated": 0 },
  "usage":       { "afterFirst": 1, "afterReplay": 1 },
  "stateWrites": { "afterFirst": 1, "afterReplay": 1 },
  "checks": {
    "first delivery inserts exactly one row and counts it once": "pass",
    "replayed update emits no duplicate state change": "pass",
    "replayed update does not double-count usage": "pass",
    "concurrent replays coalesce to a single in-flight sync": "pass",
    "a genuinely new update is still applied exactly once": "pass"
  }
}
```

Exit code 0.

### Negative control

```bash
DUPLICATE_FIXTURE_DISABLE_DEDUP=1 node .prale-eval/fixtures/duplicate-event/run.mjs
```

Exit code 1 — the assertion *"replayed update emits no duplicate state change"* fails with
`1 !== 0`. This proves the fixture actually detects a re-application regression rather than
passing vacuously.

## Contract mechanics

The duplicate-event contract is enforced by two independent layers.

**Layer 1 — change detection (`server/user-manager.js:614-689`, `upsertSyncedUserSession`).**
For an existing row the function recomputes the mutable fields and compares them against the
stored row; `updated_at` is deliberately excluded from the comparison, so merely re-seeing a
row is not a change. `last_message_at` advances with `Math.max`, so an older or equal timestamp
never regresses state. When nothing differs it returns `{ changed: false, action: 'unchanged' }`
and performs no `UPDATE`.

**Layer 2 — counting and coalescing (`server/core/session-sync.js`).**
`syncUserSessionsFromGateway` (118-177) increments `changed`/`inserted`/`updated` only inside
`if (result.changed)` (164-168), so an `'unchanged'` replay contributes zero to every counter.
`normalizeGatewaySessionForSync` (59-77) guarantees a replay is field-identical, which is what
makes layer 1's comparison conclude *unchanged*. `scheduleUserSessionSync` (179-216) adds a
per-user cooldown and an in-flight promise map, so a concurrent replay returns the existing
promise instead of starting a second sync.

**Usage is absolute, not incremental.** `server/core/session-usage-cache.js:89-117`
(`updateSessionUsageForUser` → `_persistOwnerScopedUpdate`) writes token/msg/cost columns with
plain `SET`, so re-applying the same payload overwrites the totals with identical values rather
than summing them. There is no additive path for a duplicate event to inflate usage through.

## Scope

No production source was modified. The only additions are the `.prale-eval/` artifacts; the
fixture isolates the real module through the loader hook instead of editing it. The repository's
own vitest suite was not run because vitest is not installed in this workspace and dependencies
must not be installed — recorded as a limitation, with the Node-built-in fixture used as the
focused validation instead.
