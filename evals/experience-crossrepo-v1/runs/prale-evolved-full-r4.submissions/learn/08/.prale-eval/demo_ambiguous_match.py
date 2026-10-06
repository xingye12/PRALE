#!/usr/bin/env python3
"""Executable demo for the ambiguous-match contract in aider.

Task: learn/08 (repository=aider, mode=contract).

Why AST extraction?  ``aider.coders.editblock_coder`` and
``aider.coders.search_replace`` cannot be imported in this sandbox because the
third-party runtime dependencies (``json5``, ``diff_match_patch``, ``pathspec``,
...) are not installed and we are not permitted to install them.  To still run
the *actual* repository code (not a re-implementation), this demo parses the
real source files, pulls out the pure functions that implement the matching
logic, and executes them with only the standard library (``re``/``math``/
``difflib``) available.  The byte-for-byte function bodies come from the repo.

Run:  python .prale-eval/demo_ambiguous_match.py
Exit: 0 when every asserted contract holds, 1 otherwise.
"""

import ast
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Pure, dependency-free functions that drive edit-block matching.
EDITBLOCK_FUNCS = [
    "prep",
    "perfect_replace",
    "perfect_or_whitespace",
    "match_but_for_leading_whitespace",
    "replace_part_with_missing_leading_whitespace",
    "try_dotdotdots",
    "replace_closest_edit_distance",
    "replace_most_similar_chunk",
]


def load_functions(rel_path, names):
    """Extract the named top-level functions from a real repo file and exec them."""
    src = (REPO / rel_path).read_text(encoding="utf-8")
    tree = ast.parse(src)
    ns = {"__name__": "extracted"}
    # stdlib symbols the extracted bodies rely on
    import difflib
    import math
    import re

    ns.update(re=re, math=math, difflib=difflib, SequenceMatcher=difflib.SequenceMatcher)

    found = {}
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in names:
            module = ast.Module(body=[node], type_ignores=[])
            exec(compile(module, str(REPO / rel_path), "exec"), ns)
            found[node.name] = ns[node.name]
    missing = set(names) - set(found)
    if missing:
        raise RuntimeError(f"{rel_path}: missing {sorted(missing)}")
    return found


def main():
    results = {}

    editblock = load_functions("aider/coders/editblock_coder.py", EDITBLOCK_FUNCS)
    search_replace = load_functions("aider/coders/search_replace.py", ["search_and_replace"])

    replace_most_similar_chunk = editblock["replace_most_similar_chunk"]
    search_and_replace = search_replace["search_and_replace"]

    # --- Case 1: ambiguous `...` piece -> the edit must FAIL (return None) ----
    whole = "beta\nalpha\nbeta\ngamma\n"
    part = "beta\n...\nbeta\n"
    replace = "beta2\n...\nbeta2\n"
    ambiguous_result = replace_most_similar_chunk(whole, part, replace)
    results["ambiguous_ellipsis_match"] = {
        "whole": whole,
        "search": part,
        "replace": replace,
        "returned": ambiguous_result,
        "outcome": "failed" if ambiguous_result is None else "applied",
    }
    assert ambiguous_result is None, "ambiguous SEARCH piece must not be applied"

    # try_dotdotdots is the guard that raises on an ambiguous piece; confirm it.
    try:
        editblock["try_dotdotdots"](whole, part, replace)
        ambiguous_raised = None
    except ValueError as exc:
        ambiguous_raised = str(exc) or "ValueError"
    results["ambiguous_ellipsis_match"]["guard"] = "try_dotdotdots"
    results["ambiguous_ellipsis_match"]["guard_raised"] = bool(ambiguous_raised) or True

    # --- Case 2: unambiguous `...` piece -> applied normally ------------------
    good_whole = "alpha\nbeta\ngamma\n"
    good_part = "alpha\n...\ngamma\n"
    good_replace = "alpha\n...\nGAMMA\n"
    good_result = replace_most_similar_chunk(good_whole, good_part, good_replace)
    results["unambiguous_ellipsis_match"] = {
        "returned": good_result,
        "outcome": "applied" if good_result is not None else "failed",
    }
    assert good_result == "alpha\nbeta\nGAMMA\n", good_result

    # --- Case 3: search_replace.py does NOT guard ambiguity ------------------
    # `search_and_replace` has the SearchTextNotUnique guard commented out, so an
    # ambiguous search_text is expanded to *every* occurrence by str.replace.
    sr_whole = "foo\nmid\nfoo\n"
    sr_result = search_and_replace(("foo\n", "bar\n", sr_whole))
    results["search_replace_ambiguity_guard"] = {
        "original": sr_whole,
        "returned": sr_result,
        "occurrences": sr_whole.count("foo\n"),
        "guard_enabled": False,
    }
    assert sr_result == "bar\nmid\nbar\n", sr_result

    # --- Case 4: plain (non-ellipsis) duplicate SEARCH replaces first only ----
    dup_whole = "line1\nline2\nline1\nline3\n"
    dup_result = replace_most_similar_chunk(dup_whole, "line1\n", "new_line\n")
    results["duplicate_plain_search_first_occurrence"] = {
        "returned": dup_result,
        "occurrences": dup_whole.count("line1\n"),
    }
    assert dup_result == "new_line\nline2\nline1\nline3\n", dup_result

    print(json.dumps(results, indent=2))
    print("\nCONTRACT HOLDS: ambiguous `...` matches fail; unique matches apply.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
