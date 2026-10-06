"""State-transition tests for the FileWatcher session lifecycle helper.

`aider.watch.FileWatcher` is the watch/session lifecycle helper: `start()` and
`stop()` drive it between an idle state (`stop_event is None`, `watcher_thread
is None`) and a running state (a live daemon thread gated by a `stop_event`).
The tests below pin down the legal transitions and show that the illegal edges
are guarded rather than corrupting state.

The real OS watcher (`watchfiles.watch`) is replaced by an event-driven loop so
the transitions are deterministic and no filesystem watching is required.
"""

import threading

from aider.watch import FileWatcher


class _FakeIO:
    """Minimal stand-in for InputOutput used by the watcher's callbacks."""

    def __init__(self):
        self.messages = []

    def tool_output(self, *args, **kwargs):
        self.messages.append(args)
        return ""

    def interrupt_input(self):
        pass

    def read_text(self, path, silent=True):
        return None


class _StubCoder:
    """Minimal stand-in for the coder the watcher is attached to."""

    def __init__(self, io, root="."):
        self.io = io
        self.root = root
        self.abs_fnames = set()

    def get_rel_fname(self, fname):
        return fname


class _LoopStubWatcher(FileWatcher):
    """FileWatcher whose watch loop is driven by `stop_event`, not the OS."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.watch_entered = threading.Event()

    def watch_files(self):
        self.watch_entered.set()
        while True:
            stop_event = self.stop_event
            if stop_event is None or stop_event.wait(0.05):
                return


def _make_watcher():
    io = _FakeIO()
    coder = _StubCoder(io)
    return _LoopStubWatcher(coder, root=".")


def _lifecycle_state(watcher):
    """Collapse the watcher's observable fields into a lifecycle state name."""
    if watcher.stop_event is None and watcher.watcher_thread is None:
        return "idle"
    if watcher.stop_event is not None and watcher.watcher_thread is not None:
        return "running" if watcher.watcher_thread.is_alive() else "exiting"
    return "inconsistent"


def test_lifecycle_legal_edges_start_stop_roundtrip():
    watcher = _make_watcher()
    assert _lifecycle_state(watcher) == "idle"

    # legal edge: idle --start()--> running
    watcher.start()
    assert watcher.watch_entered.wait(2)
    assert _lifecycle_state(watcher) == "running"
    assert isinstance(watcher.stop_event, threading.Event)
    assert not watcher.stop_event.is_set()
    assert watcher.changed_files == set()

    # legal edge: running --stop()--> idle
    watcher.stop()
    assert _lifecycle_state(watcher) == "idle"
    assert watcher.stop_event is None
    assert watcher.watcher_thread is None


def test_lifecycle_illegal_edges_are_guarded_noops():
    watcher = _make_watcher()

    # illegal edge: stop() before any start() must be a guarded no-op
    watcher.stop()
    assert _lifecycle_state(watcher) == "idle"

    # illegal edge: a second stop() after a completed stop is also a no-op
    watcher.start()
    assert watcher.watch_entered.wait(2)
    watcher.stop()
    watcher.stop()
    assert _lifecycle_state(watcher) == "idle"


def test_lifecycle_double_start_resets_session_state():
    watcher = _make_watcher()
    watcher.start()
    assert watcher.watch_entered.wait(2)
    assert watcher.handle_changes([("modified", "/path/to/a.py")])
    assert watcher.changed_files

    # illegal edge: start() while running is unguarded, so it silently resets
    # the session's pending changes and installs a fresh stop_event/thread.
    watcher.watch_entered.clear()
    watcher.start()
    assert watcher.watch_entered.wait(2)
    assert _lifecycle_state(watcher) == "running"
    assert watcher.changed_files == set()

    watcher.stop()
    assert _lifecycle_state(watcher) == "idle"


def test_lifecycle_empty_change_edge():
    watcher = _make_watcher()

    # illegal/empty edge: no changes -> rejected, state untouched
    assert watcher.handle_changes([]) is False
    assert watcher.changed_files == set()

    # legal edge: a real change set -> accepted and tracked
    assert watcher.handle_changes([("modified", "/path/to/file.py")]) is True
    assert "/path/to/file.py" in watcher.changed_files

    # command edge: no pending work produces an empty request
    assert watcher.process_changes() == ""
