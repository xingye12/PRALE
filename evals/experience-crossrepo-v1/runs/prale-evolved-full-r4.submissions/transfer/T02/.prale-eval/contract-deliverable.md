# Contract deliverable — T02 (`aider`, mode `contract`)

**Request:** write a state-transition test for a distinct session/watch/command
lifecycle helper using legal and illegal edges.

**Helper under test:** `aider.watch.FileWatcher` — the session/watch lifecycle
owner in this repository. It is the object that a coding session uses to open a
watch session, feed detected edits back into the session, and close the session.

**Executable demo:** `tests/basic/test_watch_lifecycle_transitions.py`
(19 test cases, all passing).

---

## 1. The contract: a two-state session machine

`FileWatcher` has exactly two stable, observable states, derived from the real
attributes set in `FileWatcher.__init__` (aider/watch.py:73-88),
`FileWatcher.start` (164-170) and `FileWatcher.stop` (172-179):

| State     | Observable predicate                                                        |
|-----------|------------------------------------------------------------------------------|
| `idle`    | `watcher_thread is None` and `stop_event is None` (the `__init__` baseline)  |
| `running` | `stop_event` is a `threading.Event` and `watcher_thread.is_alive()` is `True`|

The lifecycle edges, with their source of truth:

| Edge | Operation | Source | Documented effect |
|------|-----------|--------|-------------------|
| legal | `start()` | `FileWatcher.start` 164-170 | `idle -> running`; installs a fresh `stop_event`, **resets** `changed_files`, spawns the daemon `watch_files` thread |
| legal | `stop()` | `FileWatcher.stop` 172-179 | `running -> idle`; sets the event, joins the thread, clears `watcher_thread`/`stop_event` |
| legal | `handle_changes(changes)` | `FileWatcher.handle_changes` 135-143 | non-empty batch: normalizes to `str(Path(change[1]))`, merges into `changed_files`, calls `io.interrupt_input()`, returns `True`, stays `running` |
| legal | `handle_changes([])` | `FileWatcher.handle_changes` 135-137 | empty/falsy batch: returns `False`, no state change (no-op) |

`FileWatcher.watch_files` (145-162) is the thread body that **composes** the
command edge into the session: it iterates the `watchfiles` backend and returns
on the first batch for which `handle_changes()` reports `True`.

## 2. The contract: legal vs illegal edges

**Legal edges** (must reach the documented state and side effects):

- `idle --start()--> running`
- `running --stop()--> idle`
- `running --handle_changes(non-empty)--> running`
- `running --handle_changes([])--> running` (no-op)
- `idle --start()...stop()--start()--> running` (a clean session can be restarted)

**Illegal edges** (must be *tolerated* as safe no-ops, or *rejected*
deterministically — never silently corrupt state):

| Illegal edge | Observed behaviour (contract) | Test |
|--------------|-------------------------------|------|
| `stop()` before `start()` | tolerated no-op → stays `idle` | `test_illegal_edge_stop_before_start_is_tolerated` |
| `stop()` twice | idempotent → stays `idle` | `test_illegal_edge_double_stop_is_idempotent` |
| `handle_changes(...)` before `start()` | tolerated: records the batch but does **not** open a session (stays `idle`) | `test_illegal_edge_handle_changes_before_start_bootstraps_state` |
| `handle_changes(None)` | tolerated: falsy input == empty batch → `False`, no state change | `test_illegal_edge_none_changes_is_tolerated` |
| `handle_changes([("modified",)])` (change with no path) | **rejected** with `IndexError`/`TypeError`; `changed_files` untouched | `test_illegal_edge_malformed_change_is_rejected` |
| `start()` while already `running` | **not guarded**: the second `start()` overwrites `watcher_thread`/`stop_event`, abandoning the first session; `stop()` can only end the newest one | `test_illegal_edge_double_start_abandons_previous_session` |

The double-`start()` case is the one genuine hazard surfaced by the transition
test: because `start()` unconditionally replaces both references (aider/watch.py
166-170), the abandoned session's thread/event become unreachable through
`stop()`. The test documents this and retires the abandoned thread explicitly so
no blocked daemon leaks out of the suite.

## 3. How the executable demo drives the *real* source

`aider/watch.py` imports the optional `grep_ast` and `watchfiles` packages at
module import time, even though none of the lifecycle helpers use them
(`grep_ast.TreeContext` is only touched by `process_changes`). In this workspace
`grep_ast`, `watchfiles` **and** `oslex` (pulled in by `aider.io`) are all
absent, so:

- the demo injects minimal **import-time stubs** for `grep_ast` and `watchfiles`
  so the real `aider.watch.FileWatcher` class is loaded and exercised
  unmodified, and
- the `fake_watch` fixture always replaces the `watch()` backend with a
  deterministic, scripted generator (yields a scripted change batch, then blocks
  on `stop_event` until `stop()` signals it).

No production source was modified. Method bodies (`__init__`, `start`, `stop`,
`handle_changes`, `watch_files`) run exactly as shipped.

## 4. Normalized operation result

Command:

```
python -m pytest tests/basic/test_watch_lifecycle_transitions.py -q
```

Result:

```
...................                                                      [100%]
19 passed in 0.10s
```

Breakdown: 1 initial-state test, 6 legal-edge tests, 6 illegal-edge tests, and
2 parametrized transition-table tests (4 legal cases + 2 illegal cases).

## 5. Validation limitation (recorded, not worked around)

The optional dependencies `grep_ast`, `watchfiles` and `oslex` are **not
installed** and were **not installed** (per the no-install rule). As a result:

- the repository's own `tests/basic/test_watch.py` cannot be *collected* here
  (`ImportError` from `aider.io -> aider.utils -> oslex`), so it is cited as the
  public acceptance contract via static inspection, not execution; and
- the demo's strength comes from running the real lifecycle methods with a
  stubbed watcher backend rather than from a real `watchfiles` watcher.

Citation ranges were independently verified by an AST pass confirming each named
symbol's `def` line falls inside the reported inclusive `start_line`/`end_line`
(`FileWatcher.__init__` 73-88, `handle_changes` 135-143, `watch_files` 145-162,
`start` 164-170, `stop` 172-179; `tests/basic/test_watch.py`:
`MinimalCoder` 8-15, `test_get_roots_to_watch` 75-96, `test_handle_changes`
99-112).

## 6. Files

| File | Change |
|------|--------|
| `tests/basic/test_watch_lifecycle_transitions.py` | **new** — executable state-transition demo (the requested test) |
| `.prale-eval/result.json` | **new** — evidence report for T02 |
| `.prale-eval/contract-deliverable.md` | **new** — this contract description |

No task metadata, hidden-oracle file, package lock or git configuration was
modified.
