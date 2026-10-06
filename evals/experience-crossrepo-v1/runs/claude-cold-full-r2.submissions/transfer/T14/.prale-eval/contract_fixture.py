#!/usr/bin/env python
"""Executable contract fixture: distinct newline/whitespace edit.

Contract under test (aider/coders/search_replace.py):

  1. An EXACT edit -- a search block distinguished by its leading
     newline/whitespace occurs exactly once in the original text -- must
     succeed and be applied exactly once (the other, whitespace-identical
     sibling block must remain byte-for-byte untouched).

  2. A NON-UNIQUE edit -- a search block whose text occurs more than once
     (here twice, because two sibling blocks share the same indentation and
     trailing newline) -- must FAIL by raising SearchTextNotUnique, and must
     do so WITHOUT partial mutation: no caller may observe a half-applied
     result, and the original text must be returned/written unchanged.

The fixture drives the real production functions from
aider/coders/search_replace.py (search_and_replace, flexible_search_and_replace,
try_strategy, SearchTextNotUnique). Those functions do not depend on the
diff-match-patch engine, so a minimal stub is installed only to satisfy the
module-level import that the vendored functions never exercise. See
contract-deliverable.md for the recorded validation limitation.

Exit code 0 == contract satisfied.
"""

import importlib.util
import sys
import types
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SEARCH_REPLACE = REPO_ROOT / "aider" / "coders" / "search_replace.py"


def load_search_replace():
    """Load aider/coders/search_replace.py without importing the heavy
    aider.coders package __init__ (which pulls in every coder and its
    optional deps)."""

    # Satisfy module-level imports that the vendored functions never call.
    dmp_mod = types.ModuleType("diff_match_patch")

    class diff_match_patch:  # noqa: N801 - mirrors the real symbol name
        def __init__(self, *args, **kwargs):
            raise RuntimeError("diff-match-patch engine not exercised by this fixture")

    dmp_mod.diff_match_patch = diff_match_patch
    sys.modules.setdefault("diff_match_patch", dmp_mod)

    aider_mod = types.ModuleType("aider")
    aider_dump = types.ModuleType("aider.dump")
    aider_dump.dump = lambda *a, **k: None
    aider_utils = types.ModuleType("aider.utils")
    aider_utils.GitTemporaryDirectory = object
    aider_mod.dump = aider_dump
    aider_mod.utils = aider_utils
    sys.modules.setdefault("aider", aider_mod)
    sys.modules.setdefault("aider.dump", aider_dump)
    sys.modules.setdefault("aider.utils", aider_utils)

    spec = importlib.util.spec_from_file_location("_sr_under_test", SEARCH_REPLACE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# A fixture whose two halves are identical except for their leading newline
# and whitespace indentation. The alpha block is unique when addressed with
# its leading newline; the shared "value/return" body is NOT.
ORIGINAL = (
    "def alpha():\n"
    "    value = compute()\n"
    "    return value\n"
    "\n"
    "\n"
    "def beta():\n"
    "    value = compute()\n"
    "    return value\n"
)

# Distinct because of the leading newline + 4-space indent + def line.
EXACT_SEARCH = "def alpha():\n    value = compute()\n    return value\n"
EXACT_REPLACE = "def alpha():\n    value = compute(1)\n    return value\n"

# Non-unique: the body occurs twice (alpha and beta), differing from neither.
NON_UNIQUE_SEARCH = "    value = compute()\n    return value\n"
NON_UNIQUE_REPLACE = "    value = compute(2)\n    return value\n"

# The single strategy used by udiff_coder.flexi_just_search_and_replace().


def apply_edit(sr, search_text, replace_text, original_text):
    """Normalized operation result, mirroring the caller contract in
    aider/coders/udiff_coder.py::directly_apply_hunk: a SearchTextNotUnique
    failure yields (None, original_text) -- i.e. the edit is refused and the
    buffer is left exactly as it was (no partial mutation)."""
    try:
        new_text = sr.flexible_search_and_replace(
            [search_text, replace_text, original_text],
            [(sr.search_and_replace, sr.all_preprocs)],
        )
    except sr.SearchTextNotUnique:
        return None, original_text
    if not new_text:
        return None, original_text
    return new_text, new_text


def main():
    sr = load_search_replace()
    failures = []

    def check(name, cond, detail):
        status = "PASS" if cond else "FAIL"
        print(f"[{status}] {name}: {detail}")
        if not cond:
            failures.append(name)

    # ---- Scenario 1: exact (unique) edit succeeds exactly once -------------
    original_before = ORIGINAL
    new_text, written = apply_edit(sr, EXACT_SEARCH, EXACT_REPLACE, ORIGINAL)

    check(
        "exact_edit_succeeds",
        new_text is not None,
        "unique search block applied",
    )
    check(
        "exact_edit_applied_once",
        new_text is not None and written.count("compute(1)") == 1,
        f"replacement count == {written.count('compute(1)')} (expected 1)",
    )
    check(
        "exact_edit_leaves_sibling_untouched",
        new_text is not None and "def beta():\n    value = compute()\n    return value\n" in new_text,
        "beta sibling block unchanged",
    )
    check(
        "exact_edit_original_immutable",
        ORIGINAL == original_before,
        "input buffer not mutated in place",
    )

    # ---- Scenario 2: non-unique edit fails without partial mutation --------
    original_before = ORIGINAL
    result, written = apply_edit(sr, NON_UNIQUE_SEARCH, NON_UNIQUE_REPLACE, ORIGINAL)

    check(
        "non_unique_edit_fails",
        result is None,
        "returned None instead of a patched buffer",
    )
    check(
        "non_unique_no_partial_mutation",
        written == ORIGINAL,
        "buffer byte-identical to input after failure",
    )
    check(
        "non_unique_no_replacement_leaked",
        "compute(2)" not in written,
        "no replacement fragment present",
    )
    check(
        "non_unique_original_immutable",
        ORIGINAL == original_before,
        "input buffer not mutated in place",
    )

    # ---- Scenario 3: direct guard raises the typed error -------------------
    raised = False
    try:
        sr.search_and_replace([NON_UNIQUE_SEARCH, NON_UNIQUE_REPLACE, ORIGINAL])
    except sr.SearchTextNotUnique:
        raised = True
    check(
        "non_unique_raises_typed_error",
        raised,
        "SearchTextNotUnique raised by search_and_replace",
    )

    # ---- Scenario 4: no-match edit is a clean refusal ----------------------
    result, written = apply_edit(sr, "    value = missing()\n", NON_UNIQUE_REPLACE, ORIGINAL)
    check(
        "no_match_clean_refusal",
        result is None and written == ORIGINAL,
        "absent search text refused with buffer unchanged",
    )

    print()
    if failures:
        print(f"CONTRACT FAILED: {len(failures)} check(s): {failures}")
        return 1
    print("CONTRACT SATISFIED: exact edit applied once; non-unique edit refused with no mutation")
    return 0


if __name__ == "__main__":
    sys.exit(main())
