# WattClaw project lifecycle demo — create → activate → stop

Executable demo: `.prale-eval/demo-lifecycle.mjs`
Run with: `node .prale-eval/demo-lifecycle.mjs` (plain Node, built-in modules only)

## What it demonstrates

A **fresh local project fixture** (a temp directory holding
`<tenant>/.wattclaw-team/projects/p-demo/config.json` and `task-list.json`) is
driven through the three lifecycle operations. Every step is asserted against
the real repository modules — no mocks of the code under demonstration:

| Imported symbol | Source | Role in the demo |
| --- | --- | --- |
| `activateWattClawProjectRuntime` | `server/services/wattclaw-project-runtime.js` | the **activate** operation |
| `trackWattClawProjectOwnership` | `server/services/wattclaw-project-runtime.js` | the **create** ownership binding |
| `getWattClawProjectAgentIds` | `server/services/wattclaw-project-runtime.js` | cross-check that no member is dropped |
| `createWattClawProjectEventService` | `server/services/wattclaw-project-events.js` | observes the **emitted events** and drives **stop** |

Only the gateway boundary is faked: an in-memory `gatewayRpc` whose
`agents.list` initially omits the worker agent. This is the "fresh" gateway
state a new project fixture starts from.

## Lifecycle contract (state machine)

States and the only legal transitions:

```
absent --create--> created --activate--> active --stop--> stopped
```

`ProjectLifecycle.attempt(operation, run)` returns a normalized result
`{ ok, operation, from, to, value }` on success, or
`{ ok: false, operation, from, error }` when the transition is illegal — and
never mutates state on rejection.

| Operation | Legal from | On success | Effect |
| --- | --- | --- | --- |
| `create` | `absent` | → `created` | writes the fixture files, binds members via `trackWattClawProjectOwnership`, subscribes a client |
| `activate` | `created` | → `active` | `activateWattClawProjectRuntime` restores the missing worker, then `config.json` is written as `in_progress` |
| `stop` | `active` | → `stopped` | `service.stop()` closes all project watchers |

Illegal transitions asserted as **rejected** (state unchanged): `stop` from
`absent`, and `activate` / `stop` / `create` from `stopped`.

## Emitted-event contract

The event service publishes for the subscribed client only, with an
ever-increasing `revision`:

| Event | Payload | Emitted when |
| --- | --- | --- |
| `wattclaw.team.project.updated` | `{ projectId, tenantId, revision, project }` | `config.json` present/changed (forced on `subscribe`) |
| `wattclaw.team.project.deleted` | `{ projectId, tenantId, revision, project: null }` | `config.json` removed |
| `wattclaw.team.tasks.updated` | `{ projectId, tenantId, revision, tasks }` | `task-list.json` present/changed (must be an array) |

Observed event sequence for the demo run:

1. `wattclaw.team.project.updated` — revision 1, status `pending` (create)
2. `wattclaw.team.tasks.updated` — revision 2, tasks `[]` (create)
3. `wattclaw.team.project.updated` — revision 3, status `in_progress` (activate)

After `stop()` the active-watcher count is `0`; a further `config.json` write
produces **no** event, which is the asserted stop condition.

## Normalized operation result

`activateWattClawProjectRuntime({ project, gatewayRpc })` returns:

```json
{ "project": { "id": "p-demo", "...": "..." }, "agents": [ ... ], "restored": false }
```

For the fresh fixture the demo asserts: exactly one
`wattclaw.team.project.member.update` call, for `p-demo-worker` only; the
returned agent set is `["p-demo-manager", "p-demo-worker"]`; `restored` is
`false` because a fresh project is not archived (`restored` is `true` only for
an `archived` source project).

## Result

`DEMO OK: 26/26 checks passed, only legal transitions emitted events` — exit
code `0`. The demo prints a JSON summary (final state, legal transition
history, emitted events with revisions, gateway calls, and the check tally) and
sets a non-zero exit code if any assertion fails.

## Validation note

The repository's configured test runner (`vitest`) and its
`server/services/wattclaw-project-runtime.test.js` suite could not be executed
because `node_modules` is not installed in this environment. The demo
therefore imports the repository modules directly and relies solely on Node
built-in modules, so it runs without any installed dependency.
