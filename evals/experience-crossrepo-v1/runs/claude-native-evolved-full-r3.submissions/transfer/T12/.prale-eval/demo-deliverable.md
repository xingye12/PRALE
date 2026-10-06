# T12 — WattClaw project lifecycle demo (create → activate → stop)

## What this deliverable is

An **executable demo** of a fresh, local WattClaw project fixture that is driven
through the three phases of its lifecycle — **create → activate → stop** — while
asserting two things at every step:

1. **Only legal transitions occur** (a status may only move along an allowed edge).
2. **The correct events are emitted** (and no events are emitted after stop).

The demo is not a mock of the feature — it imports and drives the *shipped*
modules, so what it proves is the real contract:

| Module | Role in the demo |
| --- | --- |
| `server/services/wattclaw-project-runtime.js` | activation (`activateWattClawProjectRuntime`) and the stop/retention path (`pruneWattClawProjectsForUser`) |
| `server/services/wattclaw-project-events.js` | event emission (`createWattClawProjectEventService`) and fixture path resolution (`resolveWattClawProjectDirectory`) |

## How to run it

```bash
node .prale-eval/demo/project-lifecycle-demo.mjs
```

Zero dependencies (plain Node ESM, no `node_modules` required). Exit code `0`
means every contract assertion held; the first failure exits non-zero with a stack.

Observed output:

```
WattClaw project lifecycle demo: PASS
  ✓ create: fixture resolved on disk + project.updated(pending)/tasks.updated([]) emitted
  ✓ activate: 1 missing agent restored; project.updated(in_progress) emitted
  ✓ stop: watcher released, terminal project archived, running project kept
  ✓ observed transitions: (created)->pending, pending->in_progress, in_progress->success, success->archived
```

## The lifecycle contract being asserted

`config.json` in the project directory carries the authoritative `status`; the
retention pass archives only expired terminal (or restored-archived) projects.
The legal transition set encoded by the demo is:

```
(created)   -> pending
pending     -> in_progress | archived
in_progress -> success | failed | archived
success     -> archived
failed      -> archived
archived    -> restored | archived
restored    -> in_progress | archived
```

Any pair outside this set is rejected by `assertLegalTransition`; the demo
explicitly proves the guard fires for `success -> in_progress`,
`pending -> restored`, and `failed -> in_progress`.

## Phase-by-phase assertions

### 1. create

- A fresh fixture is materialized under a unique temp root:
  `<root>/tenant-demo/.wattclaw-team/projects/p-demo/config.json` (status `pending`)
  plus `task-list.json` (`[]`).
- `resolveWattClawProjectDirectory` is used to confirm the real resolver finds
  the freshly created directory (the fixture is where the runtime expects it).
- Subscribing the event service emits the create events immediately:
  `wattclaw.team.project.updated` with `payload.project.status === 'pending'`
  and `wattclaw.team.tasks.updated` with `payload.tasks === []`, both addressed
  to `['demo-client']`.
- Transition recorded: `(created) -> pending`.

### 2. activate

- `activateWattClawProjectRuntime` is driven with a gateway stub that has only
  the lead agent loaded. It restores **exactly one** member —
  `p-demo-worker` — via `wattclaw.team.project.member.update`; it does **not**
  re-issue an update for the already-loaded `p-demo-manager`.
- `result.restored === false` for a `pending` project (a restore is only an
  `archived` → loaded transition), and the activated agent id set is
  `['p-demo-manager', 'p-demo-worker']`.
- Advancing the on-disk status to `in_progress` emits
  `wattclaw.team.project.updated` with `payload.project.status === 'in_progress'`.
- Transition recorded: `pending -> in_progress`.

### 3. stop

- `unsubscribe` releases the watcher (`getActiveProjectCount() === 0`), and a
  subsequent `config.json` write produces **no** further events.
- The retention pass (`pruneWattClawProjectsForUser`) is the stop/archival path.
  With `p-demo` expired-terminal (`success`, 4 days old) and `p-running`
  still `in_progress`, it returns `archived === ['p-demo']` and
  `kept === ['p-running']` — i.e. it refuses the illegal
  `in_progress -> archived` transition for the running project while performing
  the legal `success -> archived` transition.
- Transitions recorded: `in_progress -> success`, `success -> archived`.

## Normalized operation result

The demo prints a PASS/FAIL summary and the normalized transition trace
`(created)->pending, pending->in_progress, in_progress->success, success->archived`.
A run is successful when:

- exit code is `0`;
- the emitted event sequence for the fixture is
  `project.updated(pending)` → `tasks.updated([])` → `project.updated(in_progress)`
  → (post-stop: none);
- every recorded transition is in the legal set above and all three refusal
  cases throw.

## Validation

```bash
node .prale-eval/demo/project-lifecycle-demo.mjs
```

Status: **pass** (exit 0). The repository has no installed `node_modules` and no
`vitest` binary, so the demo is written as a dependency-free Node script rather
than a vitest spec; the existing `*.test.js` suites for the same modules could
not be executed in this environment.
