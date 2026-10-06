# Demo deliverable — WattClaw project lifecycle (create → activate → stop)

Task: `T12` · repository `wattclaw` · mode `demo`

## 1. What is delivered

| Artifact | Purpose |
| --- | --- |
| `server/services/wattclaw-project-runtime.demo.mjs` | Executable demo harness. Creates a fresh local project fixture on disk and drives the **real** runtime helpers in `server/services/wattclaw-project-runtime.js` through create → activate → (work) → stop → activate (restore) → stop, asserting legal transitions only and the exact emitted event stream. |
| `.prale-eval/demo-run.json` | Normalized operation result produced by the run (transitions, rejections, events, gateway call counts, retention schedule, assertion log). |
| `.prale-eval/demo-fixture/tenant-demo/.wattclaw-team/projects/p-demo/config.json` | The fresh local project fixture written by the demo (layout resolved by `wattclaw-project-events.resolveWattClawProjectDirectory`). Rebuilt from scratch on every run. |
| `.prale-eval/result.json` | Machine-readable task result (evidence, claims, conclusion, validation). |

Run it:

```bash
node server/services/wattclaw-project-runtime.demo.mjs   # exit 0 = demo passed
```

The harness only uses Node built-ins (`node:assert/strict`, `node:fs/promises`) plus repository
modules, so it runs in this checkout without installing dependencies. Any failed assertion throws and
exits non-zero.

## 2. Local fixture

The demo tenant is `tenant-demo` and the project is `p-demo`. `create` mints the project record
(`status: creating`, two members: `p-demo-manager` (lead) and `p-demo-worker`) and persists it as
`config.json`, exactly where `resolveWattClawProjectDirectory` looks
(`OPENCLAW_CONTAINER_DATA_DIR/<tenant>/.wattclaw-team/projects/<projectId>`). The fixture root is
deleted and re-created at the start of every run, so two consecutive runs must produce identical
results — verified.

The harness plays the part of the gateway with an in-process RPC surface (`wattclaw.team.project.*`,
`agents.list`) backed by that fixture, plus a fake agent registry that can be dropped (gateway restart)
or refused (member restore failure).

## 3. Contract under test

### 3.1 Legal transitions (`LEGAL_TRANSITIONS`, demo lines 46-53)

| # | Action | From | To | Driven by |
| --- | --- | --- | --- | --- |
| 1 | `create` | `absent` | `created` | `wattclaw.team.project.create` → `extractWattClawProject` |
| 2 | `activate` | `created` | `active` | `activateWattClawProjectRuntime` (restores missing members) + `ensureWattClawProjectRuntime` |
| 3 | `complete` | `active` | `terminal` | project reaches `success` |
| 4 | `stop` | `terminal` | `stopped` | `pruneWattClawProjectsForUser` after the 3-day final retention window → `wattclaw.team.project.archive` |
| 5 | `activate` | `stopped` | `active` | `activateWattClawProjectRuntime` on an `archived` project → `restored: true` (24 h restore window starts) |
| 6 | `stop` | `active` | `stopped` | `pruneWattClawProjectsForUser` after the 24 h restore window → `wattclaw.team.project.archive` |

`isLegalTransition()` (demo lines 55-57) is evaluated for every observed transition; the run fails if
one is not in the table.

### 3.2 Guards that make illegal transitions fail closed

* `activateWattClawProjectRuntime` — requires a project + RPC (`WattClaw project and gateway RPC are required`), restores only missing members via `wattclaw.team.project.member.update`, and throws `WattClaw agents were not restored: <ids>` when a member agent cannot be loaded.
* `ensureWattClawProjectRuntime` — throws `WattClaw project has no agents` for an agent-less project; returns immediately when all project agents are loaded (no `config.get`/`config.apply` reload); otherwise it applies the gateway config and polls `agents.list` until every agent appears or it times out.
* `pruneWattClawProjectsForUser` — the only legal producer of a stop: it archives a project only when it is terminal (`success`/`failed`/`fail`) and the 3-day `FINAL_PROJECT_RETENTION_MS` window elapsed, or when it is `archived` and the 24-hour `RESTORED_PROJECT_RETENTION_MS` window elapsed (`restoredAt` access state). Anything else lands in `kept`/`skipped`; the gateway's own archive guard additionally answers `ok:false` when a caller bypasses the policy.
* `nextWattClawRetentionRunAt` — the sweep that decides stop eligibility runs at 18:00 Asia/Shanghai; with the fixed demo clock `2026-08-20T10:00:00.000Z` the next sweep is asserted at `2026-08-21T10:00:00.000Z`.

### 3.3 Event contract (asserted stream, 16 events)

```
 1  wattclaw.team.project.created            p-demo (creating)
 2  wattclaw.team.project.member.restored    p-demo-manager
 3  wattclaw.team.project.member.restored    p-demo-worker
 4  wattclaw.team.agent.tracked              p-demo-manager
 5  wattclaw.team.session.tracked            agent:p-demo-manager:main
 6  wattclaw.team.agent.tracked              p-demo-worker
 7  wattclaw.team.session.tracked            agent:p-demo-worker:main
 8  wattclaw.team.project.updated            in_progress (revision 4)
 9  wattclaw.team.project.activated          in_progress (revision 4)
10  wattclaw.team.project.updated            success (revision 5)
11  wattclaw.team.project.terminal           success (revision 5)
12  wattclaw.team.project.archived           archived  (legal stop #1)
13  wattclaw.team.project.runtime.reloaded   post-restart config.apply reload
14  wattclaw.team.project.restored           restoredAt = post-restart clock
15  wattclaw.team.project.archived           archived  (legal stop #2)
16  wattclaw.team.project.created            p-demo-degraded (rejected activation fixture)
```

Events 1-15 are the main lifecycle; the harness compares the stream element-by-element.
Events 2-7 come from `wattclaw.team.project.member.update` calls made by
`activateWattClawProjectRuntime` and from `trackWattClawProjectOwnership` (2 agents, 2 session keys).

## 4. Normalized operation result (actual run)

```
status: passed            exit code: 0            assertions: 69
legal transitions: 6      rejected attempts: 8    events: 16
gateway calls: create x3, agents.list x10, member.update x3, project.list x5, archive x3
gateway admin calls: agents.list x3, config.get x1, config.apply x1
archive transitions applied: 2  (both produced by legal stops)
```

Rejected attempts — each asserted to add **no** event and to leave the fixture status untouched:

| # | Action | Attempted against | Proof |
| --- | --- | --- | --- |
| 1 | `create` | existing `p-demo` | `project already exists: p-demo` |
| 2 | `activate` | missing project record | `WattClaw project and gateway RPC are required` |
| 3 | `activate` | project with no members | `WattClaw project has no agents` |
| 4 | `stop` | `in_progress` project via prune | returned in `kept`, no archive RPC emitted |
| 5 | `stop` | `in_progress` project via a direct archive RPC | gateway answered `ok:false` (`illegal transition: project p-demo is in_progress`); RPC logged, transition not applied |
| 6 | `stop` | terminal project, 1 ms before the 3-day window | returned in `kept`, no archive RPC emitted |
| 7 | `stop` | restored project, 1 ms before the 24 h window | returned in `kept`, no archive RPC emitted |
| 8 | `activate` | `p-demo-degraded`, member restore refused | `WattClaw agents were not restored: p-demo-degraded-worker`; fixture still `creating` |

Both legal stops were also checked on their `{ scanned, kept, archived, skipped, failed }` result:
`archived: ['p-demo']`, `failed: []`, and exactly one archive RPC each.

## 5. Validation

```bash
node server/services/wattclaw-project-runtime.demo.mjs
```

* Status: **passed** (exit 0), run twice back-to-back to confirm the fixture is rebuilt fresh and no
  state leaks between runs; `.prale-eval/demo-run.json` is rewritten with the same normalized result.
* Limitation: this checkout has no `node_modules`, so the repository's vitest suite
  (`npx vitest run server/services/wattclaw-project-runtime.test.js`) could not be executed. The
  dependency-free demo harness was used instead; it exercises the same module surface (activation,
  restore, retention/archive legality, ownership tracking, retention schedule) against real runtime
  code rather than mocks of the module itself.
