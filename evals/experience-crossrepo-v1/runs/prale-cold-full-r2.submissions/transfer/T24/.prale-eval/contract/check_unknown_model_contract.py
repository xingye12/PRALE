#!/usr/bin/env python3
"""Executable contract: unknown-model handling in ``aider/models.py`` is explicit.

This script drives the *real* repository code (``aider.models``) against a
purpose-built local model metadata fixture
(``.prale-eval/contract/local-model-metadata.json``) and asserts that:

1. a model that appears in no metadata source resolves to an *empty* metadata
   dict (explicit absence) instead of a fabricated cost/context/capability set;
2. ``sanity_check_model`` reports the unknown model explicitly (it returns
   ``True`` and emits the "Unknown ..." warnings) instead of staying silent;
3. a model declared in the fixture with partial metadata is surfaced *exactly*
   as declared - no capability key (``supports_function_calling``,
   ``supports_tool_choice``, ``input_cost_per_token``, ...) is invented for it;
4. an explicitly declared ``false`` capability stays ``false`` (explicit denial
   is not silently upgraded to ``true``);
5. unknown models fall back to the documented sane defaults
   (``max_chat_history_tokens == 1024``, ``get_repo_map_tokens() == 1024``) and
   claim no optional settings (``accepts_settings == []``);
6. the public registration entry point ``register_litellm_models`` only stores
   the declared metadata verbatim - it does not augment fixture entries.

Run from anywhere:

    python .prale-eval/contract/check_unknown_model_contract.py

The script is hermetic: it points ``HOME`` at a sandbox inside this directory
(so aider cache writes stay in the workspace) and disables outbound HTTP.  When
the optional third-party dependency ``litellm`` is not installed, a minimal
in-process stub that reproduces litellm's real behaviour for unmapped models
(``get_model_info`` raises with the ``model_prices_and_context_window.json``
message, ``validate_environment`` reports no keys) is installed and the
limitation is recorded in the normalized report.

Exit status is 0 when every contract assertion holds, 1 otherwise.
"""

from __future__ import annotations

import contextlib
import io as _io
import json
import os
import re
import sys
import types
from pathlib import Path

CONTRACT_DIR = Path(__file__).resolve().parent
REPO_ROOT = CONTRACT_DIR.parents[1]
FIXTURE_PATH = CONTRACT_DIR / "local-model-metadata.json"
REPORT_PATH = CONTRACT_DIR / "contract-report.json"
SANDBOX_HOME = CONTRACT_DIR / "_home"

# --- hermetic environment -------------------------------------------------
# Point HOME inside the workspace *before* importing aider: ModelInfoManager
# derives ~/.aider/caches from Path.home().
SANDBOX_HOME.mkdir(parents=True, exist_ok=True)
os.environ["HOME"] = str(SANDBOX_HOME)

LIMITATIONS: list[str] = []

# --- optional dependency shims -------------------------------------------
try:  # json5 is an optional dependency of this checkout
    import json5  # noqa: F401
except ImportError:  # pragma: no cover - exercised in dependency-light runs
    json5 = types.ModuleType("json5")

    def _json5_loads(text, *args, **kwargs):
        """Parse the JSON5 subset used by aider metadata files (``//`` comments)."""
        without_comments = re.sub(r"(?m)^\s*//.*$", "", text)
        return json.loads(without_comments)

    json5.loads = _json5_loads
    sys.modules["json5"] = json5
    LIMITATIONS.append(
        "json5 not installed: used an in-process shim that parses strict JSON plus "
        "line comments (the subset used by aider metadata files)."
    )

try:  # transitive import of aider.models (via aider.utils)
    import oslex  # noqa: F401
except ImportError:  # pragma: no cover - exercised in dependency-light runs
    import shlex as _shlex

    oslex = types.ModuleType("oslex")
    oslex.join = lambda args: " ".join(_shlex.quote(str(a)) for a in args)
    oslex.split = lambda text: _shlex.split(text)
    sys.modules["oslex"] = oslex
    LIMITATIONS.append(
        "oslex not installed: used a shlex-based shim (aider.utils only needs "
        "oslex.join for shell escaping, which this contract does not exercise)."
    )

LITELLM_STUBBED = False
try:  # aider.llm imports litellm lazily, but the contract exercises paths that need it
    import litellm  # noqa: F401
except ImportError:  # pragma: no cover - exercised in dependency-light runs
    LITELLM_STUBBED = True
    litellm = types.ModuleType("litellm")
    litellm.model_cost = {}

    def _stub_get_model_info(model, *args, **kwargs):
        # Mirrors litellm's real behaviour for a model that is not in its map.
        raise Exception(
            f"Model {model} isn't mapped yet. Add it here or check "
            "model_prices_and_context_window.json"
        )

    def _stub_validate_environment(model, *args, **kwargs):
        # Mirrors litellm's real behaviour: provider unknown => no keys known.
        return {"keys_in_environment": False, "missing_keys": []}

    def _stub_encode(model=None, text=None, *args, **kwargs):
        return [len(text or "")]

    def _stub_token_counter(model=None, messages=None, *args, **kwargs):
        return sum(len(str(message)) for message in (messages or []))

    def _stub_completion(*args, **kwargs):
        raise NotImplementedError("stub litellm: completions are out of contract scope")

    litellm.get_model_info = _stub_get_model_info
    litellm.validate_environment = _stub_validate_environment
    litellm.encode = _stub_encode
    litellm.token_counter = _stub_token_counter
    litellm.completion = _stub_completion
    litellm.suppress_debug_info = True
    litellm.drop_params = True
    litellm.set_verbose = lambda *args, **kwargs: None
    litellm._logging = types.SimpleNamespace(_disable_debugging=lambda: None)
    sys.modules["litellm"] = litellm
    LIMITATIONS.append(
        "litellm not installed: used an in-process stub reproducing litellm's "
        "unmapped-model behaviour for get_model_info/validate_environment."
    )

# --- offline guard --------------------------------------------------------
# The metadata cache prefers a network refresh when no cache exists; the
# contract must not touch the network.
try:
    import requests

    def _offline_get(*args, **kwargs):
        raise ConnectionError("offline: outbound HTTP disabled by contract harness")

    requests.get = _offline_get
    HTTP_DISABLED = True
except ImportError:  # pragma: no cover
    HTTP_DISABLED = False
    LIMITATIONS.append("requests not installed: HTTP was already unavailable.")

sys.path.insert(0, str(REPO_ROOT))

from aider import models  # noqa: E402  (import after the shims above)

UNKNOWN_MODEL = "meta/ghost-404"
PARTIAL_MODEL = "meta/aurora-1-mini"
EXPLICIT_FALSE_MODEL = "meta/aurora-1-pro"


class RecordingIO:
    """Minimal stand-in for ``aider.io.InputOutput`` that records messages."""

    def __init__(self):
        self.warnings: list[str] = []
        self.outputs: list[str] = []

    def tool_warning(self, message, *args, **kwargs):
        self.warnings.append(str(message))

    def tool_output(self, message, *args, **kwargs):
        self.outputs.append(str(message))

    def tool_error(self, message, *args, **kwargs):
        self.outputs.append(str(message))


def fresh_manager():
    """Return a ModelInfoManager whose cache lives inside the sandbox HOME."""
    models.model_info_manager = models.ModelInfoManager()
    return models.model_info_manager


def check_metadata_registration():
    fixture = json.loads(FIXTURE_PATH.read_text())
    manager = fresh_manager()
    loaded = models.register_litellm_models([str(FIXTURE_PATH)])
    registered = manager.local_model_metadata
    mutated = {
        name: dict(value)
        for name, value in registered.items()
        if name in fixture and value != fixture[name]
    }
    observed = {
        "files_loaded": loaded,
        "registered_models": sorted(registered),
        "fixture_entries_augmented": sorted(mutated),
    }
    ok = (
        loaded == [str(FIXTURE_PATH)]
        and sorted(registered) == sorted(fixture)
        and not mutated
    )
    return (
        "C1.register_litellm_models_stores_metadata_verbatim",
        ok,
        "register_litellm_models returns the loaded filename and stores each fixture "
        "entry exactly as declared (no capability keys injected).",
        observed,
    )


def check_unknown_model_metadata_is_empty():
    manager = fresh_manager()
    info = manager.get_model_from_cached_json_db(UNKNOWN_MODEL)
    observed = {"type": type(info).__name__, "value": info}
    ok = isinstance(info, dict) and info == {}
    return (
        "C2.unknown_model_metadata_is_empty",
        ok,
        "An undeclared model resolves to an empty dict: absence is explicit, no "
        "cost/context/capability values are fabricated.",
        observed,
    )


def check_unknown_model_not_matched_by_basename():
    manager = fresh_manager()
    models.register_litellm_models([str(FIXTURE_PATH)])
    info = manager.get_model_from_cached_json_db("aurora-1-mini")
    observed = {"value": info}
    ok = info == {}
    return (
        "C3.basename_is_not_silently_matched",
        ok,
        "Prefix-stripping only applies when the declared entry's litellm_provider "
        "matches the prefix, so a bare name does not inherit another model's metadata.",
        observed,
    )


def check_unknown_model_warnings_are_explicit():
    manager = fresh_manager()
    model = models.Model(UNKNOWN_MODEL)
    io = RecordingIO()
    problem = models.sanity_check_model(io, model)
    observed = {
        "model.info": model.info,
        "sanity_check_model_returned": problem,
        "warnings": io.warnings,
        "outputs": io.outputs,
    }
    ok = (
        model.info == {}
        and problem is True
        and any("Unknown context window size and costs, using sane defaults." in w
                for w in io.warnings)
        and any("Unknown which environment variables are required." in w
                for w in io.warnings)
    )
    return (
        "C4.unknown_model_is_reported_explicitly",
        ok,
        "sanity_check_model flags the unknown model (returns True) and emits the "
        "explicit 'Unknown ...' warnings instead of silently continuing.",
        observed,
    )


def check_unknown_model_defaults_not_claims():
    manager = fresh_manager()
    model = models.Model(UNKNOWN_MODEL)
    observed = {
        "info": model.info,
        "max_chat_history_tokens": model.max_chat_history_tokens,
        "repo_map_tokens": model.get_repo_map_tokens(),
        "accepts_settings": model.accepts_settings,
        "extra_params": model.extra_params,
    }
    ok = (
        observed["info"] == {}
        and observed["max_chat_history_tokens"] == 1024
        and observed["repo_map_tokens"] == 1024
        and observed["accepts_settings"] == []
        and observed["extra_params"] is None
    )
    return (
        "C5.unknown_model_uses_sane_defaults_and_claims_nothing",
        ok,
        "Unknown models fall back to the documented 1024-token defaults and claim no "
        "optional settings (accepts_settings == []), so no unsupported capability is "
        "advertised.",
        observed,
    )


def check_partial_fixture_metadata_is_exact():
    fixture = json.loads(FIXTURE_PATH.read_text())
    declared = fixture[PARTIAL_MODEL]
    manager = fresh_manager()
    models.register_litellm_models([str(FIXTURE_PATH)])
    info = manager.get_model_from_cached_json_db(PARTIAL_MODEL)
    model_info = models.Model(PARTIAL_MODEL).info
    invented = sorted(set(info) - set(declared))
    observed = {
        "declared": declared,
        "looked_up": info,
        "model.info": model_info,
        "invented_keys": invented,
        "has_supports_function_calling": "supports_function_calling" in info,
        "has_input_cost_per_token": "input_cost_per_token" in info,
    }
    ok = (
        info == declared
        and model_info == declared
        and not invented
        and "supports_function_calling" not in info
        and "input_cost_per_token" not in info
    )
    return (
        "C6.partial_fixture_metadata_surfaces_exactly_as_declared",
        ok,
        "A fixture entry with only context/provider/mode yields exactly those keys on "
        "lookup: missing capability and cost keys stay absent rather than defaulting "
        "to permissive values.",
        observed,
    )


def check_explicit_false_capability_preserved():
    fixture = json.loads(FIXTURE_PATH.read_text())
    manager = fresh_manager()
    models.register_litellm_models([str(FIXTURE_PATH)])
    info = manager.get_model_from_cached_json_db(EXPLICIT_FALSE_MODEL)
    model = models.Model(EXPLICIT_FALSE_MODEL)
    observed = {
        "declared": fixture[EXPLICIT_FALSE_MODEL],
        "looked_up": info,
        "value": info.get("supports_function_calling", "<absent>"),
        "accepts_settings": model.accepts_settings,
    }
    ok = (
        info.get("supports_function_calling", None) is False
        and isinstance(info.get("supports_function_calling"), bool)
        and model.accepts_settings == []
    )
    return (
        "C7.explicit_false_capability_is_preserved",
        ok,
        "An explicit 'supports_function_calling: false' survives lookup as False "
        "(explicit denial), and metadata never silently enables settings such as "
        "thinking_tokens/reasoning_effort on the Model object.",
        observed,
    )


CHECKS = (
    check_metadata_registration,
    check_unknown_model_metadata_is_empty,
    check_unknown_model_not_matched_by_basename,
    check_unknown_model_warnings_are_explicit,
    check_unknown_model_defaults_not_claims,
    check_partial_fixture_metadata_is_exact,
    check_explicit_false_capability_preserved,
)


def main() -> int:
    results = []
    for check in CHECKS:
        with contextlib.redirect_stdout(_io.StringIO()), contextlib.redirect_stderr(_io.StringIO()):
            check_id, ok, expectation, observed = check()
        results.append(
            {
                "id": check_id,
                "status": "pass" if ok else "fail",
                "expectation": expectation,
                "observed": observed,
            }
        )

    report = {
        "contract": "aider unknown-model handling is explicit (no silent capability claims)",
        "repository": "aider",
        "fixture": str(FIXTURE_PATH.relative_to(REPO_ROOT)),
        "environment": {
            "repo_root": str(REPO_ROOT),
            "python": sys.version.split()[0],
            "home_sandbox": str(SANDBOX_HOME),
            "http_disabled": HTTP_DISABLED,
            "litellm_stubbed": bool(LITELLM_STUBBED),
            "limitations": LIMITATIONS,
        },
        "results": results,
        "status": "pass" if all(r["status"] == "pass" for r in results) else "fail",
    }

    REPORT_PATH.write_text(json.dumps(report, indent=4, sort_keys=False) + "\n")

    for result in results:
        print(f"[{result['status'].upper()}] {result['id']}")
    print(f"\nnormalized report: {REPORT_PATH}")
    if LIMITATIONS:
        print("limitations:")
        for limitation in LIMITATIONS:
            print(f"  - {limitation}")
    print(f"contract status: {report['status'].upper()}")
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
