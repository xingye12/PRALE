# Contract deliverable — FileWatcher session lifecycle state machine (aider, T16)

## What was requested

Evaluate in aider by writing a **state-transition test for a distinct
session/watch/command lifecycle helper using legal and illegal edges**.

The helper is `aider.watch.FileWatcher` — aider's watch/session lifecycle
helper. It is driven between an **idle** state and a **running** state by the
`start()` / `stop()` pair, accumulates pending work in `changed_files` through
`handle_changes()`, and turns that pending work into a command via
`process_changes()`.

## Normalized operation result (the contract)

The observable lifecycle state is a pure function of two fields, so the state
machine is fully determined:

```
state(w) = idle    if w.stop_event is None     and w.watcher_thread is None
         = running if w.stop_event is not None and w.watcher_thread is not None
                       and w.watcher_thread.is_alive()
         = exiting  if the handle exists but the thread has already finished
```

### Legal edges

| # | Edge | Source | Guarantee asserted |
|---|------|--------|--------------------|
| 1 | `idle --start()--> running` | `aider/watch.py:164-170` | a fresh `threading.Event` stop gate, a cleared `changed_files`, and a live daemon thread |
| 2 | `running --stop()--> idle` | `aider/watch.py:172-179` | the stop gate is set, the thread is joined, and both handles are reset to `None` |
| 3 | `idle --handle_changes(non-empty)--> tracked` | `aider/watch.py:135-143` | returns `True` and records the changed paths |
| 4 | `running`-with-no-work `--process_changes()--> ""` | `aider/watch.py:181-207` | no request is emitted when `changed_files` is empty |

### Illegal edges (guarded / rejected, must not corrupt state)

| # | Edge | Behaviour |
|---|------|-----------|
| A | `idle --stop()-->` | guarded no-op: the `if self.stop_event:` / `if self.watcher_thread:` guards mean no exception and state stays `idle` |
| B | `idle --stop()--> idle --stop()` (double stop) | second call is still a no-op |
| C | `running --start()-->` (double start) | **unguarded**: `start()` unconditionally replaces `stop_event`, clears `changed_files`, and spawns a new thread, so pending session changes are silently discarded |
| D | `handle_changes([])` | returns `False` and leaves `changed_files` untouched |

## Executable demo

`tests/basic/test_watch_lifecycle.py` implements the state machine as four
pytest tests. The real OS watcher (`watchfiles.watch`) is swapped for an
event-driven loop (`_LoopStubWatcher.watch_files`) so transitions are
deterministic and no filesystem watching is required.

- `test_lifecycle_legal_edges_start_stop_roundtrip` — legal edges 1 and 2.
- `test_lifecycle_illegal_edges_are_guarded_noops` — illegal edges A and B.
- `test_lifecycle_double_start_resets_session_state` — illegal edge C.
- `test_lifecycle_empty_change_edge` — illegal edge D plus legal edge 4.

## Validation

```
python .prale-eval/run_watch_lifecycle.py
# 4 passed, 0 failed
```

**Limitation recorded:** `watchfiles`, `grep_ast` (and, for `aider.io`,
`oslex`) are not installed in this offline environment, and dependencies must
not be installed. `aider/watch.py` imports `watchfiles`/`grep_ast` at module
load, so the harness `.prale-eval/run_watch_lifecycle.py` registers minimal
stub modules for those two names before importing the tests. The stub replaced
by `_LoopStubWatcher` is never exercised, so the lifecycle assertions run
against the real `FileWatcher` methods. Under a fully provisioned environment
the tests run unchanged via `pytest tests/basic/test_watch_lifecycle.py`.
