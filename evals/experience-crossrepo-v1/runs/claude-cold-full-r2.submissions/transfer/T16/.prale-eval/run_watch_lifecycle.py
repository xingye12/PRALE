"""Stubbed harness that executes tests/basic/test_watch_lifecycle.py.

The environment lacks the optional third-party imports that `aider.watch`
needs at module import time (`watchfiles`, `grep_ast`). We register minimal
stub modules for those, then load and run the state-transition tests directly
without pytest, so the lifecycle helper can still be exercised.

Usage: python .prale-eval/run_watch_lifecycle.py
Exit code 0 == all state-transition tests passed.
"""

import sys
import types
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))


def _install_stubs():
    if "watchfiles" not in sys.modules:
        watchfiles = types.ModuleType("watchfiles")

        def watch(*args, **kwargs):
            # The lifecycle tests replace the watch loop, so this never runs.
            return iter(())

        watchfiles.watch = watch
        sys.modules["watchfiles"] = watchfiles

    if "grep_ast" not in sys.modules:
        grep_ast = types.ModuleType("grep_ast")

        class TreeContext:  # pragma: no cover - only referenced, never used here
            def __init__(self, *args, **kwargs):
                raise NotImplementedError("stubbed TreeContext")

        grep_ast.TreeContext = TreeContext
        sys.modules["grep_ast"] = grep_ast


def main():
    _install_stubs()

    test_path = REPO_ROOT / "tests" / "basic" / "test_watch_lifecycle.py"
    spec = spec_from_file_location("test_watch_lifecycle", test_path)
    module = module_from_spec(spec)
    spec.loader.exec_module(module)

    tests = sorted(
        (name, getattr(module, name))
        for name in dir(module)
        if name.startswith("test_") and callable(getattr(module, name))
    )

    failures = 0
    for name, func in tests:
        try:
            func()
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"FAIL {name}: {exc!r}")
        else:
            print(f"PASS {name}")

    print(f"\n{len(tests) - failures} passed, {failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
