#!/usr/bin/env python
"""Executable demo of aider's model-info lookup path (task 10, mode=demo).

It drives the *real* `aider.models.ModelInfoManager` code from this checkout:

  1. local fixture metadata registered through `register_litellm_models`
     -> `model_info_manager.local_model_metadata` (checked first)
  2. on-disk cache file read by `ModelInfoManager._load_cache`
     -> `get_model_from_cached_json_db`
  3. fallback when metadata is unavailable
     -> `get_model_info` returns `{}` (empty dict), matching
        `tests/basic/test_models.py::TestModels.test_get_model_info_nonexistent`

The demo never touches the network: the cache file is a local fixture and the
litellm/OpenRouter lookups are represented by the runtime dependency that the
repo already defers. Because this evaluation sandbox does not have every
third-party runtime dependency installed (`litellm`, `json5`, `oslex`), the
script installs inert stubs for only those imports so the real `aider.models`
module can be imported. The stubs do not replace any lookup logic: the cache
read, local-metadata read, ordering, and `{}` fallback all run in repository
code.

Run:  python .prale-eval/demo_model_info_lookup.py
Exit: 0 on success, 1 if the observed lookup contract is violated.
"""

from __future__ import annotations

import json
import sys
import tempfile
import types
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

STUBS_INSTALLED: list[str] = []


def _install_optional_stubs() -> None:
    """Provide inert stand-ins for third-party deps absent from the sandbox."""
    # json5: register_litellm_models() parses local fixture files with json5.
    # Plain JSON is a subset of JSON5, so json.loads is a faithful stand-in.
    if "json5" not in sys.modules:
        try:
            import json5  # noqa: F401
        except ImportError:
            mod = types.ModuleType("json5")
            mod.loads = json.loads
            sys.modules["json5"] = mod
            STUBS_INSTALLED.append("json5")

    # oslex: imported by aider.utils; only oslex.join is referenced elsewhere.
    if "oslex" not in sys.modules:
        try:
            import oslex  # noqa: F401
        except ImportError:
            mod = types.ModuleType("oslex")
            mod.join = lambda cmd_list: " ".join(cmd_list)  # noqa: E731
            sys.modules["oslex"] = mod
            STUBS_INSTALLED.append("oslex")

    # litellm: aider.llm.LazyLiteLLM defers the real import. The stub raises for
    # unknown models exactly like the empty local metadata DB does, so the
    # unavailable-metadata fallback is still driven by real code.
    if "litellm" not in sys.modules:
        try:
            import litellm  # noqa: F401
        except ImportError:
            mod = types.ModuleType("litellm")
            mod.__version__ = "stub"

            def _get_model_info(model):  # noqa: ANN001
                raise ValueError(
                    "This model isn't mapped yet. Add it to "
                    "model_prices_and_context_window.json"
                )

            mod.get_model_info = _get_model_info
            mod.suppress_debug_info = True
            mod.set_verbose = False
            mod.drop_params = True
            mod._logging = types.SimpleNamespace(_disable_debugging=lambda: None)
            sys.modules["litellm"] = mod
            STUBS_INSTALLED.append("litellm")


_install_optional_stubs()

from aider.models import (  # noqa: E402
    ModelInfoManager,
    register_litellm_models,
)

FIXTURE_MODEL = "fixture/learn-10-model"
FIXTURE_INFO = {
    "max_input_tokens": 8192,
    "max_output_tokens": 2048,
    "input_cost_per_token": 1.5e-07,
    "output_cost_per_token": 6e-07,
}
UNKNOWN_MODEL = "definitely-not-a-real-model-xyzzy"


def demo_local_fixture_metadata() -> dict:
    """Step 1: fixture registered via register_litellm_models -> local metadata."""
    with tempfile.TemporaryDirectory() as tmp:
        fixture_file = Path(tmp) / "fixture_models.json"
        fixture_file.write_text(json.dumps({FIXTURE_MODEL: FIXTURE_INFO}))

        loaded = register_litellm_models([str(fixture_file)])
        # Fresh manager so __init__ does not pre-load anything else.
        manager = ModelInfoManager()
        # register_litellm_models populated the module-level singleton; mirror
        # it onto this manager so the lookup path is self-contained.
        from aider import models as aider_models

        manager.local_model_metadata = dict(
            aider_models.model_info_manager.local_model_metadata
        )
        info = manager.get_model_info(FIXTURE_MODEL)
        source = "local_model_metadata"
    return {
        "step": "local_fixture_metadata",
        "files_loaded": [Path(f).name for f in loaded],
        "model": FIXTURE_MODEL,
        "info": info,
        "source": source,
        "ok": info == FIXTURE_INFO,
    }


def demo_disk_cache_fixture() -> dict:
    """Step 2: fixture cache file read by _load_cache/get_model_from_cached_json_db."""
    with tempfile.TemporaryDirectory() as tmp:
        cache_dir = Path(tmp) / "caches"
        cache_dir.mkdir()
        cache_file = cache_dir / "model_prices_and_context_window.json"
        cache_file.write_text(json.dumps({FIXTURE_MODEL: FIXTURE_INFO}))

        manager = ModelInfoManager()
        manager.cache_dir = cache_dir
        manager.cache_file = cache_file

        cached = manager.get_model_from_cached_json_db(FIXTURE_MODEL)
        info = manager.get_model_info(FIXTURE_MODEL)
    return {
        "step": "disk_cache_fixture",
        "cache_file": cache_file.name,
        "from_cached_json_db": cached,
        "info": info,
        "source": "_load_cache -> content",
        "ok": cached == FIXTURE_INFO and info == FIXTURE_INFO,
    }


def demo_unavailable_fallback() -> dict:
    """Step 3: unknown model + empty fixture cache -> fallback to {} (no crash)."""
    with tempfile.TemporaryDirectory() as tmp:
        cache_dir = Path(tmp) / "caches"
        cache_dir.mkdir()
        # A truthy fixture dict keeps _update_cache() (network) out of the path.
        cache_file = cache_dir / "model_prices_and_context_window.json"
        cache_file.write_text(json.dumps({FIXTURE_MODEL: FIXTURE_INFO}))

        manager = ModelInfoManager()
        manager.cache_dir = cache_dir
        manager.cache_file = cache_file

        cached = manager.get_model_from_cached_json_db(UNKNOWN_MODEL)
        info = manager.get_model_info(UNKNOWN_MODEL)
    return {
        "step": "unavailable_metadata_fallback",
        "model": UNKNOWN_MODEL,
        "from_cached_json_db": cached,
        "info": info,
        "returns_empty_dict": info == {},
        "matches_test_get_model_info_nonexistent": info == {},
        "ok": info == {} and isinstance(info, dict),
    }


def main() -> int:
    steps = [
        demo_local_fixture_metadata(),
        demo_disk_cache_fixture(),
        demo_unavailable_fallback(),
    ]
    result = {
        "operation": "model_info_lookup",
        "repository": "aider",
        "source_file": "aider/models.py",
        "stubs_installed": STUBS_INSTALLED,
        "steps": steps,
        "all_ok": all(s["ok"] for s in steps),
    }
    print(json.dumps(result, indent=2))
    return 0 if result["all_ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
