# Contract deliverable — T16 (aider, contract mode)

## Request

Write a state-transition test for a distinct session/watch/command lifecycle
helper using legal and illegal edges.

## Helper under contract

`FileWatcher` in `aider/watch.py` (class at `aider/watch.py:65`) is the
session/watch lifecycle helper. Its lifecycle is a compact two-state machine
driven from the command/session loop:

```
        start()                 stop()
  IDLE --------→ RUNNING --------→ IDLE
```

- **States**
  - `IDLE` — `stop_event is None` and `watcher_thread is None`.
  - `RUNNING` — `stop_event` is a live `threading.Event`, `watcher_thread` is
    an alive daemon thread.
- **Legal edges**
  - `start()` (`aider/watch.py:164-170`): `IDLE → RUNNING`. Creates a fresh
    `threading.Event`, resets `changed_files` to `set()`, and starts the
    daemon watcher thread.
  - `stop()` (`aider/watch.py:172-179`): `RUNNING → IDLE`. Sets `stop_event`,
    joins the thread, then clears `watcher_thread` and `stop_event`.
  - `handle_changes(changes)` (`aider/watch.py:135-143`) with a non-empty
    batch: unions normalised paths into `changed_files`, calls
    `io.interrupt_input()`, returns `True`.
- **Illegal edges** (must be guarded no-ops, never crashes or corrupt state)
  - `stop()` before `start()`: both branches of `stop()` are truthiness-guarded
    (`if self.stop_event:` / `if self.watcher_thread:`), so this is a no-op.
  - Repeated `stop()` on an already-stopped watcher: idempotent no-op.
  - `handle_changes([])`: rejected by `if not changes: return False`; returns
    `False` and leaves `changed_files` untouched.

## Executable demo (the deliverable)

`tests/basic/test_watch.py::test_file_watcher_lifecycle_state_transitions`
(`tests/basic/test_watch.py:217-284`) is the state-transition test. It:

1. Asserts the initial `IDLE` invariants.
2. Exercises the illegal edge `stop()`-from-`IDLE` and asserts it does not
   raise and leaves state `IDLE`.
3. Exercises the illegal edge `handle_changes([])` and asserts it returns
   `False` with `changed_files == set()` and no `interrupt_input()` call.
4. Drives the legal edge `start()` and asserts `stop_event` exists, the daemon
   thread is alive, and `changed_files` was reset (stale entry discarded).
5. Drives a legal non-empty `handle_changes(...)` batch and asserts the file
   was recorded and `interrupt_input()` fired once.
6. Re-asserts the empty-batch illegal edge while `RUNNING`.
7. Drives the legal edge `stop()`, asserting the thread is joined/dead and the
   watcher is back to `IDLE`.
8. Exercises the illegal idempotent `stop()` again.
9. Restarts (`IDLE → RUNNING`) and cleanly stops.

To keep the transition deterministic and free of real filesystem events,
`watch_files` is replaced on the instance with a stub that parks on
`stop_event.wait()`; no real files are watched and no `watchfiles` iterator is
consumed.

Two minimal test doubles, `LifecycleIO` and `LifecycleCoder`
(`tests/basic/test_watch.py:194-215`), supply only the attributes the helper
touches (`io.interrupt_input`, `io.file_watcher`, `root`, `abs_fnames`,
`get_rel_fname`).

## Normalized operation result

```
python -m pytest tests/basic/test_watch.py -v
→ 5 passed in 0.16s
```

All five tests in the module pass, including the pre-existing
`test_handle_changes` (`tests/basic/test_watch.py:124-137`) that already pins
the empty-batch no-op edge, and the new lifecycle test.

## Environment limitation

The optional runtime dependencies `watchfiles`, `grep_ast` and `oslex` are not
installed in this workspace, so `aider/watch.py` could not be imported and the
test module could not be collected. No dependencies were installed. Instead, a
guarded import shim `_ensure_optional_stub` (`tests/basic/test_watch.py:7-26`)
registers inert placeholder modules for exactly those three packages only when
`importlib.util.find_spec` cannot find them. The shim is a no-op wherever the
real dependencies are present, so it does not affect a fully provisioned
environment. The lifecycle assertions run against the real `aider/watch.py`
code paths for `start`, `stop` and `handle_changes`.
