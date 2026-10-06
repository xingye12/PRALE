#!/usr/bin/env python
"""Executable contract: unknown-model handling in ``aider/models.py`` is explicit
and never silently claims unsupported capabilities.

The contract uses a *local model metadata fixture* (the ``--model-metadata-file``
mechanism, parsed by ``register_litellm_models``) that registers one local model
with full metadata and deliberately says nothing about a second, unlisted model.
It then asserts that:

  C1. The fixture is honoured: the explicitly registered model has real metadata.
  C2. An unlisted model resolves to an empty info dict (``{}``) rather than to
      fabricated metadata -- ``ModelInfoManager.get_model_from_cached_json_db``
      and ``get_model_info`` must not invent a context window or costs.
  C3. ``Model.info`` for the unlisted model stays empty, so capability lookups
      such as ``info["max_input_tokens"]`` are absent instead of silently
      defaulted, and ``max_chat_history_tokens`` falls back to the documented
      1k safe floor.
  C4. ``sanity_check_model`` reports the unknown model *explicitly*: it returns
      True and emits a tool_warning naming the "Unknown context window size and
      costs" condition.

Run:  python .prale-eval/contract_unknown_model.py
Exit code 0 == all contract clauses hold.

``litellm``/``json5`` are optional runtime dependencies of aider and are not
installed in this environment. The contract therefore installs a minimal,
documented shim for them: the json5 shim parses the fixture (plain JSON is a
JSON5 subset) and the litellm shim models a package that knows nothing about the
fixture's model names. When the real packages are importable they are used
instead. The shim only replaces third-party knowledge sources -- the code under
contract (``aider/models.py``) is exercised unmodified.
"""

import json
import os
import sys
import tempfile
import types

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, WORKSPACE)


def _install_json5_shim():
    try:
        import json5  # noqa: F401

        return "real json5"
    except ImportError:
        shim = types.ModuleType("json5")

        def loads(text, *args, **kwargs):
            # The fixture is plain JSON, which is a strict subset of JSON5.
            return json.loads(text)

        shim.loads = loads
        sys.modules["json5"] = shim
        return "json5 shim (stdlib json)"


def _install_litellm_shim():
    try:
        import litellm  # noqa: F401

        return "real litellm"
    except ImportError:
        shim = types.ModuleType("litellm")
        shim.model_cost = {}

        def get_model_info(model, *args, **kwargs):
            raise Exception(f"Unknown model {model}")

        shim.get_model_info = get_model_info

        def validate_environment(model, *args, **kwargs):
            # litellm's real return contract for a model it has no key mapping
            # for: nothing is required, and nothing is known to be satisfied.
            return dict(keys_in_environment=False, missing_keys=[])

        shim.validate_environment = validate_environment
        shim.suppress_debug_info = True
        shim.set_verbose = False
        shim.drop_params = True
        shim._logging = types.SimpleNamespace(_disable_debugging=lambda: None)
        sys.modules["litellm"] = shim
        return "litellm shim (no model knowledge)"


def _install_oslex_shim():
    """``aider.utils`` imports oslex only for shell-quoting (``oslex.join``)."""
    try:
        import oslex  # noqa: F401

        return "real oslex"
    except ImportError:
        import shlex

        shim = types.ModuleType("oslex")
        shim.join = shlex.join
        sys.modules["oslex"] = shim
        return "oslex shim (shlex.join)"


JSON5_BACKEND = _install_json5_shim()
LITELLM_BACKEND = _install_litellm_shim()
OSLEX_BACKEND = _install_oslex_shim()

from aider import models as aider_models  # noqa: E402


LISTED_MODEL = "local/fixture-listed"
UNLISTED_MODEL = "local/fixture-unlisted"

# A *different* local model metadata fixture: one fully-described local model,
# no entry at all for UNLISTED_MODEL.
FIXTURE = {
    LISTED_MODEL: {
        "max_input_tokens": 32768,
        "max_output_tokens": 4096,
        "max_tokens": 4096,
        "input_cost_per_token": 0.0000005,
        "output_cost_per_token": 0.000001,
        "litellm_provider": "local",
        "mode": "chat",
    }
}


class RecordingIO:
    """Minimal stand-in for aider's IO: records warnings/outputs verbatim."""

    def __init__(self):
        self.warnings = []
        self.outputs = []

    def tool_warning(self, message, *args, **kwargs):
        self.warnings.append(str(message))

    def tool_output(self, message, *args, **kwargs):
        self.outputs.append(str(message))


def check(label, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {label}" + (f" -- {detail}" if detail else ""))
    return bool(condition)


def main():
    results = []
    tmpdir = tempfile.mkdtemp(prefix="aider-local-model-fixture-")
    fixture_path = os.path.join(tmpdir, "local-model-metadata.json")
    with open(fixture_path, "w") as fh:
        json.dump(FIXTURE, fh)

    # Load the fixture through the public registration entry point.
    loaded = aider_models.register_litellm_models([fixture_path])

    results.append(
        check(
            "C0 fixture file loaded by register_litellm_models",
            loaded == [fixture_path],
            f"loaded={loaded}",
        )
    )
    results.append(
        check(
            "C1 explicitly described model has fixture metadata",
            aider_models.model_info_manager.get_model_from_cached_json_db(LISTED_MODEL).get(
                "max_input_tokens"
            )
            == 32768,
        )
    )

    # Control: the described model is genuinely resolved (so the emptiness
    # observed below is a statement about unknowns, not about broken plumbing).
    listed_model = aider_models.Model(LISTED_MODEL)
    results.append(
        check(
            "C1b control: described model resolves to real, non-empty metadata",
            listed_model.info.get("max_input_tokens") == 32768
            and listed_model.info.get("input_cost_per_token") == 0.0000005
            and listed_model.max_chat_history_tokens == 2048,
            f"info={listed_model.info!r}",
        )
    )

    # Use the shared manager, which now holds the fixture: an unlisted name must
    # still resolve to nothing even though sibling local metadata is present.
    manager = aider_models.model_info_manager
    unlisted_db = manager.get_model_from_cached_json_db(UNLISTED_MODEL)
    results.append(
        check(
            "C2a get_model_from_cached_json_db(unlisted) == {} (no fabrication)",
            unlisted_db == {},
            f"got={unlisted_db!r}",
        )
    )

    unlisted_info = manager.get_model_info(UNLISTED_MODEL)
    results.append(
        check(
            "C2b get_model_info(unlisted) == {} (no fabricated capabilities)",
            unlisted_info == {},
            f"got={unlisted_info!r}",
        )
    )
    results.append(
        check(
            "C2c unlisted metadata claims no context window/cost/capability keys",
            not any(
                k in unlisted_info
                for k in (
                    "max_input_tokens",
                    "max_output_tokens",
                    "input_cost_per_token",
                    "output_cost_per_token",
                    "supports_function_calling",
                )
            ),
        )
    )

    unlisted_model = aider_models.Model(UNLISTED_MODEL)
    results.append(
        check(
            "C3a Model.info for unlisted model is empty",
            unlisted_model.info == {},
            f"got={unlisted_model.info!r}",
        )
    )
    results.append(
        check(
            "C3b max_input_tokens lookup yields no claimed value",
            not unlisted_model.info.get("max_input_tokens"),
        )
    )
    results.append(
        check(
            "C3c max_chat_history_tokens falls back to the 1k safe floor",
            unlisted_model.max_chat_history_tokens == 1024,
            f"got={unlisted_model.max_chat_history_tokens}",
        )
    )

    io = RecordingIO()
    problem = aider_models.sanity_check_model(io, unlisted_model)
    unknown_warning = [
        w for w in io.warnings if "Unknown context window size and costs" in w
    ]
    results.append(
        check(
            "C4a sanity_check_model flags the unknown model (returns True)",
            problem is True,
            f"returned={problem!r}",
        )
    )
    results.append(
        check(
            "C4b explicit warning names the unknown-capabilities condition",
            len(unknown_warning) == 1 and UNLISTED_MODEL in unknown_warning[0],
            f"warnings={io.warnings!r}",
        )
    )

    # Control: the described model must NOT produce that warning, proving the
    # warning above is about absence of metadata rather than a blanket message.
    control_io = RecordingIO()
    aider_models.sanity_check_model(control_io, aider_models.Model(LISTED_MODEL))
    results.append(
        check(
            "C4c control: described model raises no unknown-costs warning",
            not any(
                "Unknown context window size and costs" in w for w in control_io.warnings
            ),
            f"warnings={control_io.warnings!r}",
        )
    )

    print()
    print(f"json5 backend:   {JSON5_BACKEND}")
    print(f"litellm backend: {LITELLM_BACKEND}")
    print(f"oslex backend:   {OSLEX_BACKEND}")
    passed = sum(1 for r in results if r)
    print(f"contract clauses passed: {passed}/{len(results)}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
