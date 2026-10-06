"""State-transition tests for the aider ``FileWatcher`` lifecycle helper.

``aider.watch.FileWatcher`` is the distinct session/watch/command lifecycle
helper: it owns a background watch *session* (``start``/``stop``) and a
*command* buffer (``handle_changes`` -> ``process_changes``).  Unlike
``tests/basic/test_watch.py`` (which checks discrete behaviours such as
gitignore matching and AI-comment parsing) this module drives the helper as an
explicit finite state machine and asserts both:

* **legal edges**  -- transitions that must move the machine, and
* **illegal edges** -- transitions that must be tolerated as guarded no-ops
  (``stop()`` before ``start()``, repeated ``stop()``, empty change batches,
  ``process_changes()`` with nothing pending).

Observable machine states
-------------------------

    IDLE     ``stop_event is None`` and ``watcher_thread is None``
    RUNNING  ``stop_event`` is a ``threading.Event`` and ``watcher_thread`` is
             a live ``threading.Thread``

Transition table
----------------

    legal:    IDLE    --start()-->  RUNNING
              RUNNING --stop()-->   IDLE
    illegal:  IDLE    --stop()-->   IDLE (guarded)
              IDLE    --process_changes()--> IDLE returning "" (guarded)
              IDLE    --handle_changes([])--> IDLE returning False (guarded)
"""

import contextlib
import importlib
import os
import sys
import threading
import time
import types

# Allow the "python tests/basic/test_watch_lifecycle.py" manual runner to import
# the in-repo ``aider`` package; harmless (a no-op) under pytest.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# ---------------------------------------------------------------------------
# Import shims.
#
# ``aider.watch`` imports three third-party packages (``grep_ast``,
# ``pathspec``, ``watchfiles``).  The lifecycle machine only depends on stdlib
# ``threading``; the packages below are needed solely so the module imports in
# an environment where they are not installed.  Real installs are always
# preferred; stubs are injected only when an import fails.
# ---------------------------------------------------------------------------


class _StubPathSpec:
    @classmethod
    def from_lines(cls, pattern_factory, lines):
        return cls()

    def match_file(self, path):
        return False


def _install_import_stubs():
    try:
        importlib.import_module("grep_ast")
    except ImportError:
        mod = types.ModuleType("grep_ast")

        class TreeContext:  # minimal placeholder
            def __init__(self, *args, **kwargs):
                raise ValueError("grep_ast stub")

        mod.TreeContext = TreeContext
        sys.modules["grep_ast"] = mod

    try:
        importlib.import_module("pathspec")
    except ImportError:
        mod = types.ModuleType("pathspec")
        patterns = types.ModuleType("pathspec.patterns")
        patterns.GitWildMatchPattern = object
        mod.patterns = patterns
        mod.PathSpec = _StubPathSpec
        sys.modules["pathspec"] = mod
        sys.modules["pathspec.patterns"] = patterns

    try:
        importlib.import_module("watchfiles")
    except ImportError:
        mod = types.ModuleType("watchfiles")

        def watch(*args, **kwargs):  # pragma: no cover - patched in tests
            raise RuntimeError("watchfiles stub: patch aider.watch.watch")

        mod.watch = watch
        sys.modules["watchfiles"] = mod


_install_import_stubs()

from aider.watch import FileWatcher  # noqa: E402

IDLE = "idle"
RUNNING = "running"

# The legal transition table.  Every other edge is an illegal edge that the
# helper must either reject or tolerate as a guarded no-op.
LEGAL_TRANSITIONS = {
    (IDLE, "start"): RUNNING,
    (RUNNING, "stop"): IDLE,
}
ILLEGAL_TRANSITIONS = {
    (IDLE, "stop"),
    (IDLE, "process_changes"),
    (IDLE, "handle_empty_changes"),
}


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class MinimalCoder:
    """Same minimal coder shape used by ``tests/basic/test_watch.py``."""

    def __init__(self, io):
        self.io = io
        self.root = "."
        self.abs_fnames = set()

    def get_rel_fname(self, fname):
        return fname


class FakeIO:
    def __init__(self, contents=None):
        self.contents = contents or {}
        self.interrupts = 0
        self.output = []

    def interrupt_input(self):
        self.interrupts += 1

    def tool_output(self, *args, **kwargs):
        self.output.append(args)

    def read_text(self, path, silent=False):
        return self.contents.get(str(path))


class _WatchController:
    """A controllable replacement for ``watchfiles.watch``.

    It behaves like the real generator: it keeps the caller's loop alive until
    ``stop_event`` is set and then ends the iteration, so ``watch_files`` and
    therefore the watcher thread terminate cleanly.
    """

    def __init__(self):
        self.started = threading.Event()
        self.stopped = threading.Event()
        self.call = None

    def __call__(
        self, *roots, watch_filter=None, stop_event=None, ignore_permission_denied=False
    ):
        self.call = (roots, watch_filter, stop_event, ignore_permission_denied)
        self.started.set()
        while stop_event is not None and not stop_event.is_set():
            time.sleep(0.005)
        self.stopped.set()
        return
        yield  # pragma: no cover - makes this a generator like the real watch()


@contextlib.contextmanager
def fake_watch():
    import aider.watch as watch_mod

    original = watch_mod.watch
    controller = _WatchController()
    watch_mod.watch = controller
    try:
        yield controller
    finally:
        watch_mod.watch = original


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _state(watcher):
    """Collapse the helper's raw attributes into an observable state."""
    if watcher.watcher_thread is None and watcher.stop_event is None:
        return IDLE
    if watcher.watcher_thread is not None and watcher.watcher_thread.is_alive():
        return RUNNING
    return "inconsistent"


def _new_watcher(contents=None):
    io = FakeIO(contents)
    coder = MinimalCoder(io)
    return FileWatcher(coder), io, coder


def _step(watcher, event):
    """Apply one edge and return the resulting state."""
    if event == "start":
        watcher.start()
    elif event == "stop":
        watcher.stop()
    elif event == "process_changes":
        watcher.process_changes()
    elif event == "handle_empty_changes":
        watcher.handle_changes([])
    else:  # pragma: no cover - defensive
        raise AssertionError(f"unknown edge {event!r}")
    return _state(watcher)


# ---------------------------------------------------------------------------
# Legal edges
# ---------------------------------------------------------------------------


def test_legal_edge_idle_to_running():
    """IDLE --start()--> RUNNING is the only edge that enters the session."""
    watcher, _, _ = _new_watcher()
    assert _state(watcher) == IDLE
    assert LEGAL_TRANSITIONS[(IDLE, "start")] == RUNNING

    with fake_watch() as controller:
        watcher.start()
        assert controller.started.wait(2), "watch session never entered"
        assert (IDLE, "start") not in ILLEGAL_TRANSITIONS
        assert _state(watcher) == RUNNING
        assert watcher.stop_event is not None
        assert watcher.watcher_thread is not None
        watcher.stop()


def test_legal_edge_running_to_idle():
    """RUNNING --stop()--> IDLE joins the session and clears its handles."""
    watcher, _, _ = _new_watcher()
    with fake_watch() as controller:
        watcher.start()
        assert controller.started.wait(2)
        assert _state(watcher) == RUNNING

        watcher.stop()
        assert controller.stopped.is_set(), "watch generator was not signalled"
        assert _state(watcher) == IDLE
        assert watcher.stop_event is None
        assert watcher.watcher_thread is None


def test_full_legal_cycle_start_stop_stop():
    """A legal lifecycle can be replayed: start -> stop -> start -> stop."""
    watcher, _, _ = _new_watcher()
    with fake_watch() as controller:
        watcher.start()
        assert controller.started.wait(2)
        assert _state(watcher) == RUNNING
        watcher.stop()
        assert _state(watcher) == IDLE

    with fake_watch() as controller2:
        watcher.start()
        assert controller2.started.wait(2)
        assert _state(watcher) == RUNNING
        watcher.stop()
        assert _state(watcher) == IDLE
        assert controller2.stopped.is_set()


def test_start_resets_change_buffer():
    """start() is also the reset edge for the command buffer."""
    watcher, _, _ = _new_watcher()
    watcher.handle_changes([("modified", "/tmp/a.py")])
    assert watcher.changed_files == {"/tmp/a.py"}

    with fake_watch() as controller:
        watcher.start()
        assert controller.started.wait(2)
        assert watcher.changed_files == set()
        watcher.stop()


# ---------------------------------------------------------------------------
# Illegal edges (must be guarded no-ops)
# ---------------------------------------------------------------------------


def test_illegal_edge_stop_before_start():
    """IDLE --stop()--> is illegal: it must be guarded, never raise."""
    watcher, _, _ = _new_watcher()
    assert _state(watcher) == IDLE
    assert (IDLE, "stop") in ILLEGAL_TRANSITIONS

    _step(watcher, "stop")  # must not raise
    assert _state(watcher) == IDLE
    assert watcher.stop_event is None
    assert watcher.watcher_thread is None


def test_illegal_edge_repeated_stop_is_idempotent():
    """stop() twice is an illegal second edge tolerated as a no-op."""
    watcher, _, _ = _new_watcher()
    with fake_watch() as controller:
        watcher.start()
        assert controller.started.wait(2)
        watcher.stop()
        assert _state(watcher) == IDLE

        _step(watcher, "stop")  # illegal: already IDLE
        assert _state(watcher) == IDLE


def test_illegal_edge_empty_change_batch():
    """IDLE --handle_changes([])--> is illegal and reports no transition."""
    watcher, _, _ = _new_watcher()
    assert (IDLE, "handle_empty_changes") in ILLEGAL_TRANSITIONS

    assert watcher.handle_changes([]) is False
    assert watcher.changed_files == set()
    assert _state(watcher) == IDLE


def test_illegal_edge_process_changes_with_nothing_pending():
    """IDLE --process_changes()--> is illegal and returns the empty command."""
    watcher, _, _ = _new_watcher()
    assert (IDLE, "process_changes") in ILLEGAL_TRANSITIONS

    assert watcher.process_changes() == ""
    assert _state(watcher) == IDLE


# ---------------------------------------------------------------------------
# Command-buffer sub-machine
# ---------------------------------------------------------------------------


def test_handle_changes_buffer_transitions():
    """IDLE(watching) --handle_changes(non-empty)--> buffer grows + interrupt."""
    watcher, io, _ = _new_watcher()
    assert io.interrupts == 0

    assert watcher.handle_changes([("modified", "/tmp/a.py")]) is True
    assert watcher.changed_files == {"/tmp/a.py"}
    assert io.interrupts == 1

    assert watcher.handle_changes([("added", "/tmp/b.py")]) is True
    assert watcher.changed_files == {"/tmp/a.py", "/tmp/b.py"}
    assert io.interrupts == 2


def test_process_changes_command_edge_returns_prompt():
    """A buffered ``ai!`` file drives the command edge and returns a prompt."""
    watcher, _, coder = _new_watcher({"/tmp/a.py": "# ai! do the thing\n"})
    with fake_watch() as controller:
        watcher.start()
        assert controller.started.wait(2)

        watcher.handle_changes([("modified", "/tmp/a.py")])
        result = watcher.process_changes()

        assert result, "command edge produced no prompt"
        assert "ai!" in result.lower() or "instructions" in result.lower()
        assert coder.abs_fnames == {"/tmp/a.py"}
        watcher.stop()


def test_transition_model_has_no_overlap():
    """The legal and illegal edge sets must be disjoint and complete."""
    assert LEGAL_TRANSITIONS.keys().isdisjoint(ILLEGAL_TRANSITIONS)
    for (state, event), target in LEGAL_TRANSITIONS.items():
        assert state in (IDLE, RUNNING)
        assert target in (IDLE, RUNNING)
    # Every non-legal edge we exercise is declared illegal.
    for edge in ((IDLE, "stop"), (IDLE, "process_changes"), (IDLE, "handle_empty_changes")):
        assert edge in ILLEGAL_TRANSITIONS
        assert edge not in LEGAL_TRANSITIONS


if __name__ == "__main__":  # pragma: no cover - manual runner
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"FAIL {name}: {exc!r}")
    raise SystemExit(1 if failures else 0)
