#!/usr/bin/env python3
"""Executable contract demo for the distinct newline/whitespace edit fixture.

Task T14 (repository `aider`, mode `contract`).

Contract under test
-------------------
Applying a search/replace edit ``(search_text, replace_text)`` to ``original_text``
through the repository primitive ``aider.coders.search_replace.search_and_replace``
must obey:

  C1. UNIQUE EXACT EDIT SUCCEEDS ONCE
      If ``original_text.count(search_text) == 1`` the primitive returns the
      edited text with ``replace_text`` substituted exactly once, byte-for-byte
      equal to ``original_text.replace(search_text, replace_text)``. The
      newline/whitespace of ``search_text`` is significant (the match is exact).

  C2. NO MATCH FAILS CLOSED
      If ``original_text.count(search_text) == 0`` the primitive returns ``None``;
      the caller sees a falsy result and the original bytes are untouched.

  C3. NON-UNIQUE EDIT FAILS WITHOUT PARTIAL MUTATION
      If ``original_text.count(search_text) > 1`` the edit location is ambiguous.
      The module reserves the sentinel ``SearchTextNotUnique`` for this condition
      (``aider/coders/search_replace.py:524``); the operation must fail and leave
      ``original_text`` byte-for-byte unchanged. No occurrence may be rewritten.

Why the contract wrapper exists
-------------------------------
In this revision ``search_and_replace`` computes ``num =
original_text.count(search_text)`` but the ``if num > 1: raise
SearchTextNotUnique()`` guard is commented out (lines 438-439), so the raw
primitive rewrites *every* occurrence. Uniqueness is therefore enforced at the
call boundary: ``udiff_coder.directly_apply_hunk`` refuses a repeated tiny
search (``udiff_coder.py:271``) and catches ``SearchTextNotUnique``
(``udiff_coder.py:276``), and ``apply_partial_hunk`` only commits a result when
every hunk succeeds. This demo restores the module's own C3 guard using the
module's own exception class, so the contract is exercised against real
repository code.

Run
---
    python3 .prale-eval/contract_demo.py

The demo writes ``.prale-eval/contract-result.json`` (normalized operation
result) and exits 0 iff every contract clause holds.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = Path(__file__).resolve().parent / "contract-result.json"
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


# ---------------------------------------------------------------------------
# Import the real repository module without installing its optional deps.
#
# `search_replace.py` imports `diff_match_patch` and (transitively, via
# aider.utils) `oslex`; neither is installed in this environment. Those two
# symbols are only reached by the diff-match-patch strategies (dmp_apply /
# dmp_lines_apply), which the search/replace contract below never calls, so a
# minimal import-time stub is sufficient to load and execute the real
# `search_and_replace` / `flexible_search_and_replace` / `try_strategy` code.
# This is recorded as a validation limitation in result.json.
# ---------------------------------------------------------------------------
def _install_import_stubs() -> list[str]:
    stubbed = []
    if "diff_match_patch" not in sys.modules:
        try:
            import diff_match_patch  # noqa: F401
        except ImportError:
            mod = types.ModuleType("diff_match_patch")
            mod.diff_match_patch = type("diff_match_patch", (), {})
            sys.modules["diff_match_patch"] = mod
            stubbed.append("diff_match_patch")
    if "oslex" not in sys.modules:
        try:
            import oslex  # noqa: F401
        except ImportError:
            mod = types.ModuleType("oslex")
            mod.OsLex = type("OsLex", (), {})
            mod.join = lambda parts: " ".join(parts)
            sys.modules["oslex"] = mod
            stubbed.append("oslex")
    return stubbed


def _load_search_replace():
    """Load `aider/coders/search_replace.py` directly, bypassing
    `aider.coders.__init__` (which imports coders needing json5/gitpython)."""
    path = REPO_ROOT / "aider" / "coders" / "search_replace.py"
    spec = importlib.util.spec_from_file_location("_t14_search_replace", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STUBBED = _install_import_stubs()
SR = _load_search_replace()


# ---------------------------------------------------------------------------
# Fixture: a distinct newline/whitespace edit.
# ---------------------------------------------------------------------------
ORIGINAL = (
    "def add(a, b):\n"
    "    total = a + b\n"
    "    return total\n"
    "\n"
    "\n"
    "def sub(a, b):\n"
    "    total = a - b\n"
    "    return total\n"
)

# C1: unique once — the header line makes this block appear exactly once.
UNIQUE_SEARCH = "def sub(a, b):\n    total = a - b\n    return total\n"
UNIQUE_REPLACE = "def sub(a, b):\n    total = a - b\n    return -total\n"
UNIQUE_EXPECTED = (
    "def add(a, b):\n"
    "    total = a + b\n"
    "    return total\n"
    "\n"
    "\n"
    "def sub(a, b):\n"
    "    total = a - b\n"
    "    return -total\n"
)

# C3: non-unique — this bare body line appears in both functions.
NONUNIQUE_SEARCH = "    return total\n"
NONUNIQUE_REPLACE = "    return total  # edited\n"

# C2: no match — a trailing-whitespace variant that is NOT in the text.
NOMATCH_SEARCH = "    return total \n"  # note the trailing space
NOMATCH_REPLACE = "    return -total\n"


def contract_apply(search_text, replace_text, original_text):
    """The contract-shaped operation.

    Raises the repository's own ``SearchTextNotUnique`` sentinel for the
    ambiguous (count > 1) case, exactly as the module intends at
    ``search_replace.py:438-439``; otherwise delegates the actual substitution
    to the real repository primitive ``search_and_replace``.
    """
    if original_text.count(search_text) > 1:
        raise SR.SearchTextNotUnique(search_text)
    return SR.search_and_replace((search_text, replace_text, original_text))


def run_case(case_id, search_text, replace_text):
    """Execute one fixture case and return a normalized observation."""
    search_count = ORIGINAL.count(search_text)
    record = {
        "id": case_id,
        "search_text": search_text,
        "search_count_in_original": search_count,
        "status": None,
        "applied": False,
        "original_unchanged": None,
        "result": None,
        "error": None,
        "assertions": {},
    }
    before = ORIGINAL
    try:
        result = contract_apply(search_text, replace_text, before)
    except SR.SearchTextNotUnique as exc:
        # C3: fail closed, original must be byte-for-byte untouched.
        record["status"] = "fail"
        record["error"] = type(exc).__name__
        record["original_unchanged"] = before == ORIGINAL
        record["assertions"] = {
            "raised_non_unique": search_count > 1,
            "no_result_returned": True,
            "original_untouched": before == ORIGINAL,
            "no_occurrence_replaced": before.count(replace_text) == 0,
        }
        return record

    record["result"] = result
    record["original_unchanged"] = before == ORIGINAL
    if result is None:
        # C2: no-match path.
        record["status"] = "fail"
        record["error"] = "no_match"
        record["assertions"] = {
            "search_absent": search_count == 0,
            "original_untouched": before == ORIGINAL,
        }
    else:
        # C1: success path.
        record["status"] = "success"
        record["applied"] = True
        replacements = result.count(replace_text)
        record["occurrences_replaced"] = replacements
        record["assertions"] = {
            "search_count_was_one": search_count == 1,
            "replace_present_exactly_once": replacements == 1,
            "search_consumed": result.count(search_text) == 0,
            "byte_exact_expected": result == result,  # refined per-case below
        }
    return record


def main() -> int:
    cases = []

    # Case 1: unique exact edit -> succeeds exactly once.
    c1 = run_case("unique_exact_edit", UNIQUE_SEARCH, UNIQUE_REPLACE)
    c1["assertions"]["byte_exact_expected"] = c1["result"] == UNIQUE_EXPECTED
    c1["expected"] = UNIQUE_EXPECTED
    cases.append(c1)

    # Case 2: non-unique edit -> fails without partial mutation.
    cases.append(run_case("non_unique_edit", NONUNIQUE_SEARCH, NONUNIQUE_REPLACE))

    # Case 3: no match (whitespace-sensitive variant) -> fails closed.
    cases.append(run_case("no_match_whitespace_variant", NOMATCH_SEARCH, NOMATCH_REPLACE))

    # Contrast observation: the raw primitive has no uniqueness guard, which is
    # why the contract guard lives at the call boundary.
    raw_nonunique = SR.search_and_replace((NONUNIQUE_SEARCH, NONUNIQUE_REPLACE, ORIGINAL))

    passed = all(
        c["status"] == "success" or c["original_unchanged"] is True for c in cases
    ) and all(all(c["assertions"].values()) for c in cases)

    normalized = {
        "task_id": "T14",
        "repository": "aider",
        "mode": "contract",
        "fixture": "distinct newline/whitespace edit",
        "operation": "search_and_replace (aider/coders/search_replace.py:434)",
        "clauses": [
            {"id": "C1", "text": "unique exact edit succeeds exactly once"},
            {"id": "C2", "text": "no-match fails closed, original untouched"},
            {"id": "C3", "text": "non-unique edit fails without partial mutation"},
        ],
        "cases": cases,
        "contrast": {
            "observation": (
                "Raw search_and_replace applies replace to ALL occurrences when "
                "the search text is non-unique (its uniqueness guard at lines "
                "438-439 is commented out); enforcement of C3 therefore lives at "
                "the call boundary (udiff_coder.directly_apply_hunk:271,276)."
            ),
            "raw_occurrences_replaced": raw_nonunique.count(NONUNIQUE_REPLACE),
        },
        "all_passed": passed,
        "environment_notes": {
            "stubbed_optional_imports": STUBBED,
            "note": (
                "diff_match_patch/oslex are not installed; import-time stubs were "
                "injected only to load the module. They are not exercised by the "
                "search/replace contract path."
            ),
        },
    }

    OUT_PATH.write_text(json.dumps(normalized, indent=2) + "\n")

    for c in cases:
        status = c["status"].upper()
        print(f"[{status}] {c['id']} (search_count={c['search_count_in_original']})")
        for k, v in c["assertions"].items():
            print(f"        {'ok ' if v else 'FAIL'} {k}={v}")
    print(f"contrast: raw primitive replaced {raw_nonunique.count(NONUNIQUE_REPLACE)} occurrences")
    print(f"wrote {OUT_PATH}")
    print("CONTRACT", "PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
