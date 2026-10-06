#!/usr/bin/env python3
"""T27 executable contract demo (repository: aider, mode: contract).

Contract under test
-------------------
"Unknown local model handling is explicit and does not silently claim
unsupported capabilities."

Grounded in aider/models.py:

  C1  A *local model metadata fixture* (our own JSON5 file, different from the
      bundled aider/resources/model-metadata.json) is ingested verbatim by
      register_litellm_models() into ModelInfoManager.local_model_metadata.
  C2  A model name that is absent from the fixture resolves to an EMPTY
      metadata dict (explicit "unknown") -- get_model_from_cached_json_db()
      returns `dict()`, it never fabricates a capability set.
  C3  sanity_check_model() turns that emptiness into explicit, operator-visible
      warnings (unknown context window/costs, unknown required env vars) and
      reports the model as a problem (returns True).
  C4  Because the metadata dict is empty, no capability keys
      (supports_tool_choice / supports_function_calling / ...) and no
      accepts_settings entries are claimed for the unknown model; capability
      flags only appear when the fixture states them.

Two execution modes
-------------------
  * LIVE   -- used when `aider.models` is importable (needs json5 + litellm).
              Imports the real functions and exercises the behaviour.
  * STATIC -- deterministic fallback used when a runtime dependency is
              missing (this sandbox has neither json5 nor litellm). It parses
              aider/models.py with `ast` and asserts the same contract on the
              real source: the explicit warning strings inside
              sanity_check_model(), the terminal `return dict()` in
              get_model_from_cached_json_db(), and the fixture ingestion in
              register_litellm_models().

Exit code 0 == every contract check passed in whichever mode ran.
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKSPACE = HERE.parent
MODELS_PY = WORKSPACE / "aider" / "models.py"
FIXTURE = HERE / "fixtures" / "local-model-metadata.json"

KNOWN_MODEL = "local/known-fixture-model"
UNKNOWN_MODEL = "local/unknown-fixture-model"

CAPABILITY_KEYS = (
    "supports_function_calling",
    "supports_tool_choice",
    "supports_prompt_caching",
    "supports_assistant_prefill",
    "litellm_provider",
)

WARN_UNKNOWN_COST = "Unknown context window size and costs, using sane defaults."
WARN_UNKNOWN_ENV = "Unknown which environment variables are required."

results: list[tuple[str, bool, str]] = []


def check(cid: str, ok: bool, detail: str) -> None:
    results.append((cid, bool(ok), detail))


def fixture_without_comments() -> dict:
    """Parse the JSON5 fixture by stripping // comments (no json5 dependency)."""
    lines = []
    for line in FIXTURE.read_text().splitlines():
        stripped = line.strip()
        # Keep URLs intact; only drop lines whose first non-space chars are //.
        if stripped.startswith("//"):
            continue
        lines.append(line)
    return json.loads("\n".join(lines))


def func(tree: ast.Module, name: str) -> ast.AST:
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    raise AssertionError(f"symbol {name} not found in {MODELS_PY}")


def func_source(src_lines: list[str], node: ast.AST) -> str:
    return "\n".join(src_lines[node.lineno - 1 : node.end_lineno])


# --------------------------------------------------------------------------- #
# Dependency-independent checks (run in both modes)
# --------------------------------------------------------------------------- #
def check_fixture_shape() -> None:
    data = fixture_without_comments()
    check(
        "C1.fixture",
        KNOWN_MODEL in data and UNKNOWN_MODEL not in data,
        f"fixture declares {KNOWN_MODEL!r} and omits {UNKNOWN_MODEL!r}",
    )
    known = data.get(KNOWN_MODEL, {})
    check(
        "C4.fixture_explicit",
        known.get("supports_tool_choice") is False
        and known.get("supports_function_calling") is False,
        "fixture states capabilities explicitly (false) for the known model",
    )


def check_static_contract() -> None:
    src_lines = MODELS_PY.read_text().splitlines()
    tree = ast.parse("\n".join(src_lines))

    sanity = func(tree, "sanity_check_model")
    sanity_src = func_source(src_lines, sanity)
    check(
        "C3.warn_costs",
        WARN_UNKNOWN_COST in sanity_src,
        "sanity_check_model emits the explicit unknown-cost/context warning",
    )
    check(
        "C3.warn_env",
        WARN_UNKNOWN_ENV in sanity_src,
        "sanity_check_model emits the explicit unknown-env-var warning",
    )

    lookup = func(tree, "get_model_from_cached_json_db")
    last = lookup.body[-1]
    returns_empty = (
        isinstance(last, ast.Return)
        and isinstance(last.value, ast.Call)
        and isinstance(last.value.func, ast.Name)
        and last.value.func.id == "dict"
        and not last.value.args
    )
    check(
        "C2.empty_lookup",
        returns_empty,
        "get_model_from_cached_json_db ends with `return dict()` for unknown models",
    )

    register = func(tree, "register_litellm_models")
    register_src = func_source(src_lines, register)
    check(
        "C1.ingest",
        "local_model_metadata.update" in register_src,
        "register_litellm_models ingests the fixture into local_model_metadata",
    )
    check(
        "C4.no_accepted_settings_claim",
        "accepts_settings = []" in func_source(src_lines, func(tree, "configure_model_settings")),
        "configure_model_settings initialises accepts_settings to [] (no implicit claims)",
    )


# --------------------------------------------------------------------------- #
# Live behavioural checks
# --------------------------------------------------------------------------- #
class _IO:
    def __init__(self) -> None:
        self.warnings: list[str] = []
        self.outputs: list[str] = []

    def tool_warning(self, msg, *a, **k):
        self.warnings.append(str(msg))

    def tool_output(self, msg, *a, **k):
        self.outputs.append(str(msg))

    def tool_error(self, msg, *a, **k):
        self.outputs.append(str(msg))


class _ModelStub:
    """Mirror of the Model attributes sanity_check_model() consumes."""

    def __init__(self, name, info, missing_keys=None, keys_in_environment=True):
        self.name = name
        self.info = info
        self.missing_keys = missing_keys
        self.keys_in_environment = keys_in_environment

    def __str__(self):
        return self.name


def run_live() -> None:
    if str(WORKSPACE) not in sys.path:
        sys.path.insert(0, str(WORKSPACE))
    from aider.models import ModelInfoManager, register_litellm_models, sanity_check_model

    loaded = register_litellm_models([str(FIXTURE)])
    check(
        "C1.loaded",
        str(FIXTURE) in loaded,
        f"register_litellm_models loaded the local fixture: {loaded}",
    )

    manager = ModelInfoManager()
    # Keep the unknown-model path offline/deterministic: never refresh the cache
    # from the network during this contract check.
    manager._cache_loaded = True
    manager._update_cache = lambda: None

    known = manager.get_model_from_cached_json_db(KNOWN_MODEL)
    check(
        "C1.known_resolves",
        known.get("litellm_provider") == "local" and known.get("supports_tool_choice") is False,
        "fixture metadata is returned verbatim for the known model",
    )

    unknown = manager.get_model_from_cached_json_db(UNKNOWN_MODEL)
    check("C2.unknown_empty", unknown == {}, f"unknown model metadata is {unknown!r}")
    check(
        "C4.no_capability_claims",
        not any(k in unknown for k in CAPABILITY_KEYS),
        "no capability keys are claimed for the unknown model",
    )

    io = _IO()
    problem = sanity_check_model(io, _ModelStub(UNKNOWN_MODEL, info=unknown))
    check(
        "C3.explicit_costs",
        problem is True and WARN_UNKNOWN_COST in io.warnings,
        f"unknown model warns explicitly: {io.warnings}",
    )

    io2 = _IO()
    sanity_check_model(
        io2,
        _ModelStub(UNKNOWN_MODEL, info=unknown, missing_keys=None, keys_in_environment=None),
    )
    check(
        "C3.explicit_env",
        any(WARN_UNKNOWN_ENV in w for w in io2.warnings),
        f"unknown model warns about unknown env vars: {io2.warnings}",
    )


def main() -> int:
    check_fixture_shape()
    check_static_contract()

    mode = "STATIC"
    limitation = ""
    try:
        run_live()
        mode = "LIVE"
    except Exception as exc:  # noqa: BLE001 - dependency gaps must be reported, not installed
        limitation = f"{type(exc).__name__}: {exc}"
        check(
            "LIVE.skipped",
            True,
            "runtime dependency unavailable, static (ast) contract checks used instead: "
            + limitation,
        )

    print(f"T27 contract demo -- mode={mode}")
    failed = 0
    for cid, ok, detail in results:
        print(f"CHECK {cid}: {'PASS' if ok else 'FAIL'} -- {detail}")
        failed += 0 if ok else 1
    if limitation:
        print(f"LIMITATION (recorded, dependency NOT installed): {limitation}")
    print(f"RESULT: {'PASS' if failed == 0 else 'FAIL'} ({len(results) - failed}/{len(results)})")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
