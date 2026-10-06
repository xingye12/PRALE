# T20 — duplicate-event contract: replaying one session update

Repository: `wattclaw` · Task mode: `contract`

## 1. Contract statement

**Replaying the same session update cannot double-count usage and cannot emit a
duplicate state change.**

The contract is enforced by three independent mechanisms, each verified by the
fixture below:

| Layer | Idempotency key | Replay behaviour | Source |
| --- | --- | --- | --- |
| Usage write | composite `(user_id, session_key)` | `UPDATE user_sessions ... WHERE user_id = ? AND session_key = ?`, success defined as `changes === 1`; every counter is **SET** to the Gateway's absolute value, never accumulated | `server/core/session-usage-cache.js` → `_persistOwnerScopedUpdate` |
| Per-session sync scheduling | `sessionKey` | `scheduleSessionUsageSync` clears the pending timer and re-arms a single one; `syncSessionUsageNow` coalesces concurrent runs onto one in-flight promise, so one key → one Gateway call → one `session.usage.updated` SSE event | `server/core/usage-sync.js` → `scheduleSessionUsageSync`, `syncSessionUsageNow`, `broadcastSessionUsageUpdate` |
| Metadata sync | `userId` (schedule) / `sessionKey` (persist) | `inFlightByUserId` collapses concurrent schedules; `upsertSyncedUserSession` re-reads the row keyed on `session_key` and returns `{ changed: false, action: 'unchanged' }` when the replayed metadata is identical | `server/core/session-sync.js` → `scheduleUserSessionSync`, `syncUserSessionsFromGateway`; `server/user-manager.js` → `upsertSyncedUserSession` |

Ownership guard: the write is scoped by `user_id + session_key`; a key that
matches zero owner rows is reported as `skippedUnmatched` and a key matching more
than one owner row as `skippedConflict` — neither is written. Replay therefore
can neither create a second physical row nor attribute usage to a second owner.

## 2. Executable demo (duplicate-event fixture)

```bash
node .prale-eval/duplicate-event-fixture.mjs
```

Files:

- `.prale-eval/duplicate-event-fixture.mjs` — the fixture and its assertions.
- `.prale-eval/harness/loader.mjs` — a `module.register()` resolve hook that
  redirects *only* the module boundaries of the three production modules.
- `.prale-eval/harness/mocks.mjs` — in-memory doubles: the SQLite handle
  (owner-scoped `UPDATE`, ownership `SELECT`, `getSessionOwner` lookup), the
  Gateway client, SSE broadcast sink, and an `upsertSyncedUserSession` double that
  mirrors the real `session_key`-keyed, `Math.max`-on-`last_message_at`,
  `{ changed: false, action: 'unchanged' }` semantics.

The **real** production source of `session-sync.js`, `usage-sync.js` and
`session-usage-cache.js` is loaded and executed; only the db / gateway /
user-manager boundaries are doubled.

Distinctness of the fixture: it owns the marker `dup-event-fixture/T20`, the
owner `user-dup-owner`, the session keys `agent:agent-a:dup-fixture` and
`agent:agent-a:dup-fixture-meta`, and its own private doubles. It does not
import, patch, disable, or depend on any other test/fixture in the repository.

## 3. Normalized operation result

The single replayed event is a Gateway session update with absolute counters
(`input 100`, `output 50`, `totalTokens 150`, `totalCost 0.5`, `messageCounts.total 4`,
`toolCalls 1`). Replaying it, in every entry point, normalizes to:

```
scanned         1        updated         1
skippedUnmatched 0       skippedConflict 0        failed 0

user_sessions row (user_id = user-dup-owner, session_key = agent:agent-a:dup-fixture)
  token_input   100   (not 200)
  token_output   50   (not 100)
  token_total   150   (not 300)
  cost_total    0.5   (not 1.0)
  msg_total       4   (not 8)
  rows for this composite key: 1
```

Fixture output (16 checks, exit code 0):

```
ok  1 metadata insert reports changed=inserted
ok  2 usage row is unstamped before the first usage sync (usage_synced_at IS NULL)
ok  3 both replays write to exactly one owner-matched row
ok  4 replay does not double-count tokens (SET, not accumulate)
ok  5 replay does not double-count cost or messages
ok  6 replay never inserts a second physical row for the composite key
ok  7 the write statement is owner-scoped and additive-free
ok  8 the second in-flight replay is coalesced onto the in-flight sync
ok  9 exactly one state-change (SSE) event is emitted
ok 10 concurrent replay still does not double-count usage
ok 11 two scheduled events produce exactly one Gateway sync and one event
ok 12 debounced replay leaves counters unchanged
ok 13 first metadata sync inserts the session once via sessions.list only
ok 14 replayed metadata update reports changed=0 (no duplicate state change)
ok 15 replay did not create a duplicate row for the session key
ok 16 concurrent scheduled syncs for the same user issue one Gateway list call

CONTRACT OK: 16 checks passed for dup-event-fixture/T20
```

Phase coverage: `batchUpdateMatchedGatewayUsage` (batch/startup replay),
`syncSessionUsageNow` (concurrent event-driven replay), `scheduleSessionUsageSync`
(debounce), `syncUserSessionsFromGateway` (metadata replay → `changed: 0`),
`scheduleUserSessionSync` (per-user in-flight coalescing).

## 4. Boundaries and limitations

- `vitest` and `better-sqlite3` are not installed in this offline workspace and
  were **not** installed (no dependency changes, no lockfile changes). The
  repository suite (`npm run test:server`) could therefore not be executed.
- Substitution: the fixture is an executable Node (v24) script using `node:assert`
  and `node:module` loader hooks. It runs real module logic and asserts the real
  SQL text and real report fields. The db double implements only the statements
  on the duplicate-event path; a full SQLite engine is not emulated, so this is
  weaker evidence than the repository test suite for untouched read/aggregate
  paths. All asserted values were independently re-read from the checkout.
- No production source file was modified; the change set is additive
  (`.prale-eval/**` only).
