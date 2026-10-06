#!/usr/bin/env python3
"""Offline, executable demo of aider's model-info lookup path (task learn/10).

Demonstrates the real ``aider.models.ModelInfoManager`` implementation against a
*local fixture cache* (``.prale-eval/fixtures/model_prices_and_context_window.json``)
and shows every fallback used when metadata is unavailable:

  1. exact hit in the on-disk cache file (no network, litellm not loaded),
  2. in-memory ``local_model_metadata`` precedence over the cache file,
  3. ``provider/model`` resolution guarded by the ``litellm_provider`` field,
  4. corrupted cache file treated as missing,
  5. stale cache (older than ``CACHE_TTL``) triggering a refresh,
  6. empty result when no metadata source is available ("fallback to {}"),
  7. litellm consulted when the local cache misses, its result preferred,
  8. OpenRouter chain: cached OpenRouter db -> legacy web scrape -> {},
  9. ``Model`` level delegation to the module-level ``model_info_manager``.

The two optional third-party modules that ``aider.models`` imports at module
load time are not installed in this environment (``json5``, ``litellm``).  The
demo installs a *controlled stand-in* for each in ``sys.modules`` so the demo is
fully offline and deterministic; no repository source file is modified and all
lookup logic exercised below is the repository's own code.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sys
import time
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKSPACE = HERE.parent
FIXTURE_FILE = HERE / "fixtures" / "model_prices_and_context_window.json"
TMP_ROOT = HERE / "_demo_tmp"

sys.path.insert(0, str(WORKSPACE))


# --------------------------------------------------------------------------- #
# dependency stand-ins (offline, deterministic)
# --------------------------------------------------------------------------- #
def install_json5_standin() -> str:
    if importlib.util.find_spec("json5") is not None:
        return "json5: real module"
    stub = types.ModuleType("json5")

    def _unavailable(*args, **kwargs):
        raise RuntimeError("json5 stand-in: not used by the model-info lookup path")

    for name in ("loads", "dumps", "load", "dump"):
        setattr(stub, name, _unavailable)
    sys.modules["json5"] = stub
    return "json5: local stand-in (unused by ModelInfoManager)"


def install_oslex_standin() -> str:
    if importlib.util.find_spec("oslex") is not None:
        return "oslex: real module"
    stub = types.ModuleType("oslex")

    def _join(cmd_list):
        return " ".join("'" + str(c).replace("'", "'\\''") + "'" for c in cmd_list)

    stub.join = _join
    stub.split = lambda s: s.split()
    sys.modules["oslex"] = stub
    return "oslex: local stand-in (unused by ModelInfoManager)"


LITELLM_STANDIN_INFO = {
    "litellm-only-model": {
        "max_input_tokens": 200000,
        "max_output_tokens": 8192,
        "max_tokens": 8192,
        "litellm_provider": "openai",
        "source": "litellm-standin",
    }
}


def install_litellm_standin():
    """Stand-in mirroring the two litellm calls ModelInfoManager makes."""
    if "litellm" in sys.modules:
        return sys.modules["litellm"]
    module = types.ModuleType("litellm")

    class _Logging:
        @staticmethod
        def _disable_debugging():
            pass

    module.suppress_debug_info = False
    module.set_verbose = False
    module.drop_params = False
    module._logging = _Logging()
    module.calls = []

    def get_model_info(model, *args, **kwargs):
        module.calls.append(("get_model_info", model))
        if model in LITELLM_STANDIN_INFO:
            return dict(LITELLM_STANDIN_INFO[model])
        # Mirrors real litellm for unknown models: raises with a message that
        # mentions model_prices_and_context_window.json (the manager then
        # silently falls through instead of printing the error).
        raise Exception(f"model_prices_and_context_window.json does not contain '{model}'")

    def validate_environment(model, *args, **kwargs):
        module.calls.append(("validate_environment", model))
        return {"missing_keys": ["STANDIN_FAKE_KEY"], "keys_in_environment": False}

    module.get_model_info = get_model_info
    module.validate_environment = validate_environment
    sys.modules["litellm"] = module
    return module


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #
RESULTS: list[dict] = []


def check(case: str, observed, expected, note: str = "") -> None:
    ok = observed == expected
    RESULTS.append(
        {
            "case": case,
            "ok": ok,
            "expected": expected,
            "observed": observed,
            "note": note,
        }
    )
    print(json.dumps(RESULTS[-1], sort_keys=True, default=str))


def new_home(name: str) -> Path:
    home = TMP_ROOT / name
    if home.exists():
        shutil.rmtree(home)
    (home / ".aider" / "caches").mkdir(parents=True)
    return home


def new_manager(name: str):
    from aider.models import ModelInfoManager

    home = new_home(name)
    old_home = os.environ.get("HOME")
    os.environ["HOME"] = str(home)
    try:
        manager = ModelInfoManager()
    finally:
        if old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = old_home
    # pin the cache to the workspace-local fixture dir (never the real HOME)
    manager.cache_dir = home / ".aider" / "caches"
    manager.cache_file = manager.cache_dir / "model_prices_and_context_window.json"
    manager.verify_ssl = False
    return manager


def seed_cache(manager, stale: bool = False) -> None:
    manager.cache_file.parent.mkdir(parents=True, exist_ok=True)
    manager.cache_file.write_text(FIXTURE_FILE.read_text())
    if stale:
        age = manager.CACHE_TTL + 3600
        old = time.time() - age
        os.utime(manager.cache_file, (old, old))


def patch_update_cache(manager, new_content=None) -> dict:
    """Replace the network refresh with an offline recorder."""
    state = {"calls": 0}

    def _update(self):
        state["calls"] += 1
        if new_content is not None:
            self.content = dict(new_content)
            try:
                self.cache_file.write_text(json.dumps(self.content, indent=4))
            except OSError:
                pass

    manager._update_cache = types.MethodType(_update, manager)
    return state


# --------------------------------------------------------------------------- #
# demo
# --------------------------------------------------------------------------- #
def main() -> int:
    notes = {"json5": install_json5_standin(), "oslex": install_oslex_standin()}
    litellm_standin = install_litellm_standin()
    notes["litellm"] = "controlled stand-in (network metadata source)"

    from aider import models as aider_models
    from aider.models import ModelInfoManager  # noqa: F401  (real repository class)

    fixture = json.loads(FIXTURE_FILE.read_text())
    print(json.dumps({"demo": "model-info lookup", "fixture": str(FIXTURE_FILE.relative_to(WORKSPACE))}))

    # -- 1. exact hit in the local on-disk cache, no network ----------------
    m = new_manager("exact_hit")
    seed_cache(m)
    offline = patch_update_cache(m)
    info = m.get_model_from_cached_json_db("fixture-model")
    check(
        "1a. exact cache-file hit",
        info,
        fixture["fixture-model"],
        "ModelInfoManager.get_model_from_cached_json_db -> self.content.get(model)",
    )
    check("1b. cache hit performs no refresh", offline["calls"], 0)
    check(
        "1c. cache hit does not import litellm",
        aider_models.litellm._lazy_module,
        None,
        "`if litellm._lazy_module or not cached_info:` short-circuits on a cache hit",
    )

    # -- 2. in-memory local_model_metadata wins over the cache file ---------
    m = new_manager("local_metadata")
    offline = patch_update_cache(m)  # no cache file seeded at all
    m.local_model_metadata["memory-only-model"] = {"max_input_tokens": 123, "source": "memory"}
    info = m.get_model_from_cached_json_db("memory-only-model")
    check(
        "2a. local_model_metadata precedence",
        info,
        {"max_input_tokens": 123, "source": "memory"},
        "returned before _load_cache()/_update_cache() are ever reached",
    )
    check("2b. local metadata lookup touches no cache/network", offline["calls"], 0)

    # -- 3. provider-prefixed resolution guarded by litellm_provider --------
    m = new_manager("provider_prefix")
    seed_cache(m)
    patch_update_cache(m)
    check(
        "3a. provider/model resolves via pieces[1] + litellm_provider",
        m.get_model_from_cached_json_db("openai/shared-model"),
        fixture["shared-model"],
        "entries.get('shared-model')['litellm_provider'] == 'openai'",
    )
    check(
        "3b. provider mismatch -> no metadata",
        m.get_model_from_cached_json_db("azure/shared-model"),
        {},
        "litellm_provider 'openai' != 'azure', so the piece is rejected",
    )
    check(
        "3c. openrouter entry resolved from local cache",
        m.get_model_from_cached_json_db("openrouter/vendor/model-x"),
        fixture["openrouter/vendor/model-x"],
    )

    # -- 4. corrupted cache treated as missing ------------------------------
    m = new_manager("corrupted")
    m.cache_file.write_text("{not valid json")
    offline = patch_update_cache(m)  # offline: refresh cannot repair it
    info = m.get_model_from_cached_json_db("fixture-model")
    check(
        "4a. corrupted cache file treated as missing",
        info,
        {},
        "json.JSONDecodeError -> self.content = None",
    )
    check("4b. loaded content is None after corruption", m.content, None)
    check("4c. refresh attempted once for the empty content", offline["calls"], 1)

    # -- 5. stale cache (older than CACHE_TTL) triggers a refresh -----------
    m = new_manager("stale")
    seed_cache(m, stale=True)
    refreshed = {"refreshed-model": {"max_input_tokens": 64000, "source": "refreshed"}}
    offline = patch_update_cache(m, new_content=refreshed)
    info = m.get_model_from_cached_json_db("refreshed-model")
    check(
        "5a. stale cache entry replaced by refreshed metadata",
        info,
        refreshed["refreshed-model"],
        "cache_age >= CACHE_TTL -> self.content stays None -> _update_cache()",
    )
    check("5b. refresh invoked exactly once", offline["calls"], 1)

    # -- 6. fallback when metadata is unavailable ---------------------------
    m = new_manager("missing_metadata")
    offline = patch_update_cache(m)  # offline; no cache file; litellm raises
    info = m.get_model_info("non-existent-model")
    check(
        "6a. unknown model -> empty metadata (mirrors the repo unit test)",
        info,
        {},
        "litellm miss + populated-empty cached_info -> `return cached_info` == {}",
    )
    check("6b. offline refresh attempted once", offline["calls"], 1)

    # -- 7. litellm consulted when the local cache misses -------------------
    m = new_manager("litellm_source")
    patch_update_cache(m)
    info = m.get_model_info("litellm-only-model")
    check(
        "7a. litellm metadata preferred when the cache misses",
        info,
        LITELLM_STANDIN_INFO["litellm-only-model"],
        "litellm_info is truthy -> `return litellm_info`",
    )

    # -- 8. OpenRouter fallback chain --------------------------------------
    m = new_manager("openrouter_chain")
    patch_update_cache(m)
    m.openrouter_manager = types.SimpleNamespace(
        get_model_info=lambda model: {"max_input_tokens": 777, "source": "openrouter-cache"}
    )

    def _should_not_scrape(model):
        raise AssertionError("legacy scrape must not run when the cached db answers")

    m.fetch_openrouter_model_info = _should_not_scrape
    check(
        "8a. openrouter cached db consulted first",
        m.get_model_info("openrouter/vendor/unknown"),
        {"max_input_tokens": 777, "source": "openrouter-cache"},
    )

    m = new_manager("openrouter_scrape")
    patch_update_cache(m)
    m.openrouter_manager = types.SimpleNamespace(get_model_info=lambda model: {})
    m.fetch_openrouter_model_info = lambda model: {"max_input_tokens": 555, "source": "scrape"}
    check(
        "8b. legacy web-scrape fallback used when the cached db misses",
        m.get_model_info("openrouter/vendor/unknown"),
        {"max_input_tokens": 555, "source": "scrape"},
    )

    m = new_manager("openrouter_empty")
    patch_update_cache(m)
    m.openrouter_manager = types.SimpleNamespace(get_model_info=lambda model: {})
    m.fetch_openrouter_model_info = lambda model: {}
    check(
        "8c. openrouter with no source at all -> {}",
        m.get_model_info("openrouter/vendor/unknown"),
        {},
    )

    # -- 9. Model level delegation -----------------------------------------
    m = new_manager("model_level")
    seed_cache(m)
    patch_update_cache(m)
    original_manager = aider_models.model_info_manager
    aider_models.model_info_manager = m
    try:
        model = aider_models.Model("fixture-model")
        check(
            "9a. Model.info comes from the fixture cache",
            model.info,
            fixture["fixture-model"],
            "Model.get_model_info -> model_info_manager.get_model_info",
        )
        check(
            "9b. derived max_chat_history_tokens (4096/16)",
            model.max_chat_history_tokens,
            1024 * 1.0,
        )
    finally:
        aider_models.model_info_manager = original_manager

    failed = [r for r in RESULTS if not r["ok"]]
    summary = {
        "checks": len(RESULTS),
        "passed": len(RESULTS) - len(failed),
        "failed": len(failed),
        "dependency_standins": notes,
        "litellm_standin_calls": list(litellm_standin.calls),
    }
    print(json.dumps(summary, sort_keys=True))
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        code = main()
    finally:
        shutil.rmtree(TMP_ROOT, ignore_errors=True)
    sys.exit(code)
