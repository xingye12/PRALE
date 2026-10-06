#!/usr/bin/env python3
"""Executable contract demo for T24 (aider, contract mode).

Contract under test
-------------------
``aider.models`` must treat an *unknown* model explicitly: a model that is
neither shipped in ``aider/resources/model-metadata.json`` nor registered from
a local metadata fixture nor known to litellm must

1. resolve to empty metadata (``{}``) rather than fabricated context/cost
   numbers, and
2. emit an explicit user-facing warning instead of silently proceeding, and
3. make no capability claims (``accepts_settings``) for features it has not
   been shown to support.

The demo registers a *different* local model metadata fixture
(``.prale-eval/fixtures/local-model-metadata.json``) through the public
``register_litellm_models`` entry point and then asserts the contract for both
the fixture-declared model and a model that is unknown everywhere.

Run from the repository root::

    python .prale-eval/demo_unknown_model_contract.py

Exit status 0 means every contract assertion holds.
"""

from __future__ import annotations

import json
import os
import shlex
import sys
import tempfile
import types
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
FIXTURE = REPO_ROOT / ".prale-eval" / "fixtures" / "local-model-metadata.json"

KNOWN_MODEL = "local/demo-chat-model"
UNKNOWN_MODEL = "totally-unknown-model-xyz"
UNKNOWN_SIBLING = "local/model-not-in-fixture"

# Capabilities aider can request from a backend. An unknown model must not
# claim support for any of them.
CAPABILITY_SETTINGS = ("thinking_tokens", "reasoning_effort")

STUBBED_DEPENDENCIES: list[str] = []


def _install_missing_dependency_stubs() -> list[str]:
    """Stand in for third-party imports that are absent in this environment.

    Only ``json5``, ``oslex`` and ``litellm`` may be missing. The stubs supply
    exactly the surface ``aider.models`` touches; all aider logic exercised by
    this demo is the repository's real code.
    """
    stubbed = []

    try:
        import json5  # noqa: F401
    except ModuleNotFoundError:
        module = types.ModuleType("json5")
        module.loads = json.loads
        module.dumps = json.dumps
        sys.modules["json5"] = module
        stubbed.append("json5")

    try:
        import oslex  # noqa: F401
    except ModuleNotFoundError:
        module = types.ModuleType("oslex")
        module.join = shlex.join
        sys.modules["oslex"] = module
        stubbed.append("oslex")

    try:
        import litellm  # noqa: F401
    except ModuleNotFoundError:
        module = types.ModuleType("litellm")
        module.model_cost = {}
        # aider.llm disables litellm's debug logging right after import.
        module._logging = types.SimpleNamespace(_disable_debugging=lambda: None)

        def _get_model_info(model):
            # Mirror litellm: unknown models raise rather than inventing data.
            raise Exception(
                "This model isn't mapped yet. Add it here - https://github.com/"
                "BerriAI/litellm/blob/main/model_prices_and_context_window.json"
            )

        module.get_model_info = _get_model_info
        module.validate_environment = lambda model: dict(
            keys_in_environment=False, missing_keys=[]
        )
        sys.modules["litellm"] = module
        stubbed.append("litellm")

    return stubbed


class _RecordingIO:
    """Minimal stand-in for aider's IO object."""

    def __init__(self):
        self.warnings = []
        self.outputs = []

    def tool_warning(self, message):
        self.warnings.append(message)

    def tool_output(self, message):
        self.outputs.append(message)


def _isolate_model_info_manager(models):
    """Keep the demo hermetic: no network, no writes outside the workspace."""
    manager = models.model_info_manager
    manager._cache_loaded = True
    manager.content = {}
    manager._update_cache = lambda: None
    return manager


def main() -> int:
    results = []

    def check(name, condition, detail=""):
        results.append({"check": name, "passed": bool(condition), "detail": detail})
        status = "PASS" if condition else "FAIL"
        line = f"[{status}] {name}"
        if detail:
            line += f" -- {detail}"
        print(line)

    # Redirect HOME so any incidental Path.home() lookup stays in the workspace.
    sandbox = tempfile.TemporaryDirectory(prefix="t24-home-")
    os.environ["HOME"] = sandbox.name

    global STUBBED_DEPENDENCIES
    STUBBED_DEPENDENCIES = _install_missing_dependency_stubs()
    if STUBBED_DEPENDENCIES:
        print(f"note: stubbed unavailable dependencies: {', '.join(STUBBED_DEPENDENCIES)}")

    import aider.models as models

    manager = _isolate_model_info_manager(models)

    # --- registration of the different local fixture ---------------------
    loaded = models.register_litellm_models([str(FIXTURE)])
    fixture_data = json.loads(FIXTURE.read_text())
    registered = set(manager.local_model_metadata)
    check(
        "fixture_registered_exactly",
        loaded == [str(FIXTURE)] and registered == set(fixture_data),
        f"loaded={loaded} registered={sorted(registered)}",
    )

    # --- a fixture-declared model resolves explicitly --------------------
    known_info = manager.get_model_from_cached_json_db(KNOWN_MODEL)
    known_model = models.Model(KNOWN_MODEL)
    check(
        "known_model_metadata_is_explicit",
        known_info == fixture_data[KNOWN_MODEL]
        and known_model.info.get("max_input_tokens") == 4096,
        f"info={known_info}",
    )

    # --- an unknown model is explicit: empty metadata, no fabrication ----
    unknown_lookup = manager.get_model_from_cached_json_db(UNKNOWN_MODEL)
    unknown_info = manager.get_model_info(UNKNOWN_MODEL)
    unknown_model = models.Model(UNKNOWN_MODEL)
    fabricated_keys = (
        "max_input_tokens",
        "max_output_tokens",
        "input_cost_per_token",
        "output_cost_per_token",
        "litellm_provider",
    )
    check(
        "unknown_model_metadata_is_empty",
        unknown_lookup == {} and unknown_info == {} and unknown_model.info == {},
        f"lookup={unknown_lookup} info={unknown_info} model.info={unknown_model.info}",
    )
    check(
        "unknown_model_claims_no_fabricated_metadata",
        not any(key in unknown_model.info for key in fabricated_keys),
        f"info={unknown_model.info}",
    )

    # --- unknown model is warned about explicitly ------------------------
    io = _RecordingIO()
    problem = models.sanity_check_model(io, unknown_model)
    warning_text = "\n".join(io.warnings)
    check(
        "unknown_model_warned_explicitly",
        problem is True
        and "Unknown context window size and costs, using sane defaults." in warning_text,
        f"warnings={io.warnings}",
    )

    # --- unknown model makes no silent capability claims -----------------
    unknown_claimed = [
        setting for setting in CAPABILITY_SETTINGS if setting in unknown_model.accepts_settings
    ]
    check(
        "unknown_model_claims_no_capabilities",
        unknown_claimed == [],
        f"accepts_settings={unknown_model.accepts_settings}",
    )

    # --- the capability check is non-vacuous -----------------------------
    known_capability_model = models.Model("gpt-5.5")
    check(
        "capability_claim_check_is_non_vacuous",
        "reasoning_effort" in known_capability_model.accepts_settings,
        f"gpt-5.5 accepts_settings={known_capability_model.accepts_settings}",
    )

    # --- registration is exact; no provider-wide guessing ----------------
    sibling_lookup = manager.get_model_from_cached_json_db(UNKNOWN_SIBLING)
    check(
        "unregistered_sibling_stays_unknown",
        sibling_lookup == {},
        f"lookup={sibling_lookup}",
    )

    # --- the unknown name is not presented as a known model --------------
    matches = models.fuzzy_match_models(UNKNOWN_MODEL)
    check(
        "unknown_model_not_self_matched",
        UNKNOWN_MODEL not in matches,
        f"matches={matches}",
    )

    passed = sum(1 for r in results if r["passed"])
    total = len(results)
    summary = {
        "contract": "unknown-model handling is explicit and makes no unsupported capability claims",
        "fixture": str(FIXTURE.relative_to(REPO_ROOT)),
        "known_model": KNOWN_MODEL,
        "unknown_model": UNKNOWN_MODEL,
        "stubbed_dependencies": STUBBED_DEPENDENCIES,
        "checks_passed": passed,
        "checks_total": total,
        "passed": passed == total,
        "results": results,
    }
    print(json.dumps(summary, indent=2))

    sandbox.cleanup()
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
