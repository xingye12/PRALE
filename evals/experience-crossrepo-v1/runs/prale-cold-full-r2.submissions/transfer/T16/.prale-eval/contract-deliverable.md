# T16 contract deliverable — state-transition test for the `FileWatcher` lifecycle helper

Repository: `aider` · Mode: `contract` · Task id: `T16`

## What the helper is

`aider/watch.py` defines `FileWatcher`, the distinct **session / watch / command
lifecycle helper**. It owns:

* a background watch **session** — `start()` / `stop()` / `watch_files()`, and
* a **command** buffer — `handle_changes()` produces changes, `process_changes()`
  consumes them into a prompt.

Its observable lifecycle state is fully described by two attributes:

| state     | `stop_event`            | `watcher_thread`              |
|-----------|-------------------------|-------------------------------|
| `IDLE`    | `None`                  | `None`                        |
| `RUNNING` | live `threading.Event`  | live `threading.Thread`       |

## The state machine (executable contract)

```
legal edges    IDLE    --start()-------------->  RUNNING
               RUNNING --stop()--------------->   IDLE

illegal edges  IDLE    --stop()--------------->   IDLE   (guarded no-op)
               IDLE    --handle_changes([])---->  IDLE   (returns False)
               IDLE    --process_changes()----->  IDLE   (returns "")
```

The illegal edges are *not* rejected with exceptions — `FileWatcher.stop()`
(`aider/watch.py:172-179`) null-checks `self.stop_event` and
`self.watcher_thread`, so `stop()` before `start()` and a repeated `stop()`
after the machine is already `IDLE` are safe no-ops that keep the helper in a
consistent `IDLE` state.

## Executable demo

`tests/basic/test_watch_lifecycle.py` implements the machine above and asserts
both edge kinds. It:

1. builds a `MinimalCoder`/`FakeIO` pair (the same test-double shape used by
   `tests/basic/test_watch.py`), so no real coder, network or IO stack is needed;
2. replaces `aider.watch.watch` with a controllable generator
   (`_WatchController`) that keeps the watcher thread alive until `stop_event`
   is set and then ends the iteration, making the `RUNNING` state deterministic
   and guaranteeing the thread is joined;
3. models the states and a **disjoint** `LEGAL_TRANSITIONS` /
   `ILLEGAL_TRANSITIONS` table, and asserts transitions against the real
   `FileWatcher` attributes.

Test inventory (11 cases):

| test | edge kind | asserts |
|------|-----------|---------|
| `test_legal_edge_idle_to_running` | legal | `start()` moves `IDLE → RUNNING` |
| `test_legal_edge_running_to_idle` | legal | `stop()` signals the watcher and clears both handles (`RUNNING → IDLE`) |
| `test_full_legal_cycle_start_stop_stop` | legal | the cycle replays (`start → stop → start → stop`) |
| `test_start_resets_change_buffer` | legal | `start()` resets `changed_files` |
| `test_illegal_edge_stop_before_start` | illegal | `stop()` on a fresh `IDLE` watcher is a guarded no-op |
| `test_illegal_edge_repeated_stop_is_idempotent` | illegal | a second `stop()` after `IDLE` is a no-op |
| `test_illegal_edge_empty_change_batch` | illegal | `handle_changes([]) is False`, buffer untouched |
| `test_illegal_edge_process_changes_with_nothing_pending` | illegal | `process_changes() == ""` |
| `test_handle_changes_buffer_transitions` | command | non-empty batches grow the buffer and interrupt input |
| `test_process_changes_command_edge_returns_prompt` | command | a buffered `ai!` file drives the command edge, returns a prompt and registers the file |
| `test_transition_model_has_no_overlap` | model | legal and illegal edge sets are disjoint |

## Environment note (recorded limitation)

`grep_ast`, `pathspec` and `watchfiles` are **not installed** in this sandbox and
dependencies must not be installed. The lifecycle machine itself depends only on
stdlib `threading`; `tests/basic/test_watch_lifecycle.py` therefore attempts the
real imports first and injects minimal **import-only** stubs for the missing
packages before `import aider.watch`. `aider.watch.watch` is patched per-test, so
no real filesystem watching or third-party runtime behaviour is required. Real
installs always take precedence over the stubs.

## Normalized operation result

```
$ python -m pytest tests/basic/test_watch_lifecycle.py -q
...........                                                              [100%]
11 passed in ~0.1s
```

Mutation sanity check (not vacuous): replacing `FileWatcher.stop` with an
unguarded implementation made `test_illegal_edge_stop_before_start` fail with
`AttributeError`, proving the illegal-edge assertions discriminate.

## Files changed

* **added** `tests/basic/test_watch_lifecycle.py` — the state-transition test.
* **added** `.prale-eval/result.json` — structured evidence/claims/conclusion.
* **added** `.prale-eval/contract-deliverable.md` — this document.

No existing source, task metadata, hidden-oracle file, package lock or git
configuration was modified.
