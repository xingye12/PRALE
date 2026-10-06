#!/usr/bin/env python
"""Executable contract demo for task T14 (repository: aider).

Contract under test -- a *distinct newline/whitespace edit fixture*:

  C1  An exact edit whose search text is unique -- here unique only because the
      fixture distinguishes the two near-twin blocks with trailing whitespace and
      a blank-line/newline layout -- succeeds and is applied exactly once.

  C2  A non-unique edit (the same search text occurring twice) fails and leaves
      the target file byte-for-byte unchanged (no partial mutation).

Both properties are verified against the repository's own code:

  * aider/coders/search_replace.py :: search_and_replace  -> exact substring
    search/replace engine used by every non-fuzzy strategy.
  * aider/coders/udiff_coder.py   :: directly_apply_hunk   -> caller-level
    uniqueness guard that refuses a repeated search/replace on a tiny bit of
    non-whitespace context (and swallows SearchTextNotUnique).
  * aider/coders/udiff_coder.py   :: apply_edits           -> writes the file
    only when the hunk produced content, i.e. a refused hunk is never written.

Import shims: this sandbox lacks the optional third-party packages
``diff_match_patch`` and ``GitPython``, and ``aider.utils`` imports ``oslex``.
The demo therefore installs in-memory stand-ins for those modules (and for the
heavy ``aider``/``aider.coders`` package inits) so that the *unmodified* source
files ``aider/coders/search_replace.py`` and ``aider/coders/udiff_coder.py`` can
be imported and executed.  No dependency is installed and no repository file is
modified.

Usage:
    python .prale-eval/demo_search_replace_contract.py [--json]
Exit status 0 means the contract is satisfied (C1 and C2 both hold).
"""

from __future__ import annotations

import json
import sys
import tempfile
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
FIXTURES = HERE / "fixtures"


# --------------------------------------------------------------------------- #
# import shims
# --------------------------------------------------------------------------- #
def _module(name: str) -> types.ModuleType:
    mod = types.ModuleType(name)
    sys.modules[name] = mod
    return mod


def install_import_shims() -> None:
    """Make the repo importable without installing optional dependencies."""
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))

    # 1. diff_match_patch (third-party, not installed in this sandbox).
    dmp_mod = _module("diff_match_patch")

    class diff_match_patch:  # noqa: N801 - mirrors the upstream class name
        Diff_Timeout = 0
        Match_Threshold = 0
        Match_Distance = 0
        Match_MaxBits = 0
        Patch_Margin = 0

    dmp_mod.diff_match_patch = diff_match_patch

    # 2. Stub the `aider` / `aider.coders` package __init__ files (they pull in
    #    the whole coder stack) but keep the real on-disk submodules importable.
    aider_pkg = _module("aider")
    aider_pkg.__path__ = [str(ROOT / "aider")]
    coders_pkg = _module("aider.coders")
    coders_pkg.__path__ = [str(ROOT / "aider" / "coders")]

    dump_mod = _module("aider.dump")
    dump_mod.dump = lambda *a, **k: None

    utils_mod = _module("aider.utils")

    class GitTemporaryDirectory:  # only reachable via the cherry-pick paths
        def __enter__(self):
            raise RuntimeError("git-cherry-pick strategies are not exercised by this demo")

        def __exit__(self, *exc):
            return False

    utils_mod.GitTemporaryDirectory = GitTemporaryDirectory

    base_coder_mod = _module("aider.coders.base_coder")
    base_coder_mod.Coder = object

    udiff_prompts_mod = _module("aider.coders.udiff_prompts")
    udiff_prompts_mod.UnifiedDiffPrompts = object


def load_repo_modules():
    import importlib

    sr = importlib.import_module("aider.coders.search_replace")
    uc = importlib.import_module("aider.coders.udiff_coder")

    # Sanity: we really loaded the repository sources, not the stubs.
    assert Path(sr.__file__).resolve() == (ROOT / "aider" / "coders" / "search_replace.py")
    assert Path(uc.__file__).resolve() == (ROOT / "aider" / "coders" / "udiff_coder.py")
    return sr, uc


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text()


# --------------------------------------------------------------------------- #
# checks
# --------------------------------------------------------------------------- #
def main(emit_json: bool = False) -> int:
    install_import_shims()
    sr, uc = load_repo_modules()

    original = fixture("original.txt")
    search_unique = fixture("search_unique.txt")
    replace_unique = fixture("replace_unique.txt")
    search_ws_blind = fixture("search_whitespace_blind.txt")
    search_nonunique = fixture("search_nonunique.txt")
    replace_nonunique = fixture("replace_nonunique.txt")

    checks = []

    def check(name, ok, detail):
        checks.append({"check": name, "ok": bool(ok), "detail": detail})
        return bool(ok)

    # --- fixture shape -----------------------------------------------------
    check(
        "fixture_unique_search_occurs_once",
        original.count(search_unique) == 1
        and original.count(search_nonunique) == 2,
        {
            "unique_search_occurrences": original.count(search_unique),
            "nonunique_search_occurrences": original.count(search_nonunique),
            "distinguisher": "trailing 3 spaces after paint() in the first block",
        },
    )

    # --- C1: exact/unique edit succeeds exactly once -----------------------
    sr_result = sr.search_and_replace([search_unique, replace_unique, original])
    expected_unique = original.replace(search_unique, replace_unique, 1)
    check(
        "C1_search_and_replace_unique_applied_once",
        sr_result == expected_unique
        and sr_result.count(replace_unique) == 1
        and sr_result.count(search_unique) == 0
        and sr_result.count("def second():") == 1,
        {
            "returned_text_is_none": sr_result is None,
            "replace_occurrences": None if sr_result is None else sr_result.count(replace_unique),
            "sibling_block_preserved": None
            if sr_result is None
            else sr_result.count("def second():\n    paint()\n    return 1\n") == 1,
        },
    )

    # Same edit routed through the caller path used by the udiff coder.
    hunk_unique = [
        "-def first():\n",
        "-    paint()   \n",
        "-    return 1\n",
        "+def first():\n",
        "+    paint()\n",
        "+    return 1\n",
    ]
    caller_unique = uc.directly_apply_hunk(original, hunk_unique)
    check(
        "C1_directly_apply_hunk_unique_succeeds_once",
        caller_unique == expected_unique
        and caller_unique.count("paint()   ") == 0
        and caller_unique.count(replace_unique) == 1,
        {"applied": caller_unique is not None},
    )

    # --- whitespace-distinctness is load bearing ---------------------------
    # A whitespace-normalised guess (same lines, no trailing spaces) matches
    # nothing, so the exact edit is refused rather than applied to the twin.
    ws_blind = sr.search_and_replace([search_ws_blind, replace_unique, original])
    check(
        "exact_match_is_whitespace_sensitive",
        original.count(search_ws_blind) == 0 and ws_blind is None,
        {
            "whitespace_blind_search_occurrences": original.count(search_ws_blind),
            "search_and_replace_result": ws_blind,
        },
    )

    # --- C2: non-unique edit fails without partial mutation ----------------
    direct_nonunique = sr.search_and_replace([search_nonunique, replace_nonunique, original])
    hunk_nonunique = ["-    return 1\n", "+    RETURN 1\n"]
    caller_nonunique = uc.directly_apply_hunk(original, hunk_nonunique)

    # Simulate the apply_edits contract: write only a truthy hunk result.
    tmpdir = Path(tempfile.mkdtemp(prefix="t14-", dir=HERE))
    target = tmpdir / "target.txt"
    target.write_text(original)
    if caller_nonunique:
        target.write_text(caller_nonunique)
    on_disk = target.read_text()
    target.unlink()
    tmpdir.rmdir()

    check(
        "C2_nonunique_edit_refused_without_partial_mutation",
        caller_nonunique is None and on_disk == original,
        {
            "guard_reason": (
                "directly_apply_hunk refuses when the non-whitespace context is "
                "<10 chars and content.count(before) > 1 (aider/coders/udiff_coder.py:270)"
            ),
            "unique_call_result_is_none": caller_nonunique is None,
            "file_bytes_unchanged": on_disk == original,
            "file_changed_after_refusal": on_disk != original,
        },
    )

    # Documented hazard / limitation: the uniqueness check inside
    # search_and_replace is commented out (search_replace.py:437-438), so a raw
    # non-unique call rewrites every occurrence instead of raising.  Refusal is
    # therefore the caller's responsibility (udiff_coder.directly_apply_hunk).
    check(
        "observed_hazard_raw_nonunique_call_replaces_all_occurrences",
        direct_nonunique is not None and direct_nonunique.count(replace_nonunique) == 2,
        {
            "search_and_replace_result": direct_nonunique,
            "substitutions": None if direct_nonunique is None else direct_nonunique.count(replace_nonunique),
            "note": "refusal is enforced one level up, not inside search_and_replace",
        },
    )

    check(
        "failure_signal_type_is_documented_exception",
        issubclass(sr.SearchTextNotUnique, ValueError),
        {"exception": "aider.coders.search_replace.SearchTextNotUnique (ValueError subclass)"},
    )

    contract_ok = all(c["ok"] for c in checks if c["check"].startswith(("C1_", "C2_", "fixture_")))

    summary = {
        "task_id": "T14",
        "repository": "aider",
        "mode": "contract",
        "demo": ".prale-eval/demo_search_replace_contract.py",
        "fixtures": ".prale-eval/fixtures/",
        "modules_under_test": [
            "aider/coders/search_replace.py",
            "aider/coders/udiff_coder.py",
        ],
        "contract_satisfied": contract_ok,
        "checks": checks,
        "limitations": [
            "diff_match_patch and GitPython are not installed in this sandbox, so the "
            "fuzzy dmp_* and git-cherry-pick strategies are covered only by import shims; "
            "the checks exercise the exact-match search_and_replace path and the "
            "directly_apply_hunk refusal guard, which is the path the contract is about.",
            "The unique/non-unique guard lives in the *caller* "
            "(udiff_coder.directly_apply_hunk), not in search_and_replace: the "
            "SearchTextNotUnique raise inside search_and_replace is commented out, so a raw "
            "non-unique search_and_replace call rewrites all occurrences "
            "(recorded as observed_hazard_raw_nonunique_call_replaces_all_occurrences).",
        ],
    }

    if emit_json:
        out = json.dumps(summary, indent=2)
    else:
        lines = [
            "T14 contract demo -- distinct newline/whitespace edit fixture",
            "=" * 62,
        ]
        for c in checks:
            lines.append(f"[{'PASS' if c['ok'] else 'FAIL'}] {c['check']}")
            lines.append(f"        {json.dumps(c['detail'])}")
        lines.append("=" * 62)
        lines.append(f"contract_satisfied: {contract_ok}")
        out = "\n".join(lines)

    print(out)
    return 0 if contract_ok else 1


if __name__ == "__main__":
    sys.exit(main(emit_json="--json" in sys.argv[1:]))
