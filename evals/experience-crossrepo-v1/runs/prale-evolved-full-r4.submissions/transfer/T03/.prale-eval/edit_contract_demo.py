#!/usr/bin/env python
"""Executable contract for the *distinct newline/whitespace edit* fixture.

Task: T03 / repository: aider / mode: contract.

Phase 1 (contract demo)
-----------------------
The fixture is the pair of ``log("done")`` call sites below.  Their only textual
difference is the trailing newline at EOF, so the *same* logical edit is either
distinct or ambiguous depending purely on whether the SEARCH text carries the
newline:

    distinct   SEARCH = '    log("done")\\n'   -> 1 occurrence  -> exactly one edit
    ambiguous  SEARCH = '    log("done")'      -> 2 occurrences -> must be rejected
    whitespace SEARCH = '    log("done") \\n'  -> 0 occurrences  -> no match, no write

Every operation is applied with the repository's own primitives
(``aider/coders/search_replace.py`` and ``aider/coders/editblock_coder.py``) and
reported as a normalized operation result (status / occurrences / applied_count /
mutated_sites / content hashes).

Phase 2 (artifact check)
------------------------
Re-reads ``.prale-eval/result.json`` and verifies, programmatically, that
task_id/repository/mode match, that every required key is present, and that every
cited symbol really does lie inside the inclusive line range reported for it
(AST based, no substring guessing).

Environment note (recorded limitation, see result.json -> validation.notes)
---------------------------------------------------------------------------
The optional runtime dependencies of this checkout (``json5``, ``litellm``,
``diff_match_patch``, GitPython, ``oslex``) are *not* installed and must not be
installed.  The two modules under test are therefore loaded straight from source
with ``importlib``; the unrelated ``Coder``/prompt base classes and the
``diff_match_patch`` library are replaced by stubs that raise if touched, and the
demo asserts they are never touched.  Consequently ``pytest tests/basic/...``
cannot even be collected in this environment; that gap is recorded rather than
worked around by installing packages.

Run: python .prale-eval/edit_contract_demo.py
"""

import ast
import hashlib
import importlib.util
import json
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # workspace root
ARTIFACT = ROOT / ".prale-eval" / "result.json"

FAILURES = []
NOTES = []


def check(condition, message):
    if condition:
        print(f"  ok   {message}")
    else:
        print(f"  FAIL {message}")
        FAILURES.append(message)
    return bool(condition)


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def esc(text):
    return text.replace("\n", "\\n").replace(" ", "\u00b7")


# ---------------------------------------------------------------------------
# dependency-free loading of the repository modules under test
# ---------------------------------------------------------------------------
class Unavailable:
    """Placeholder for an optional dependency the contract never exercises."""

    def __init__(self, *args, **kwargs):
        raise RuntimeError("contract demo touched an unavailable dependency / unused entry point")


def _stub(name, **attrs):
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    sys.modules[name] = module
    return module


def _load_module(name, rel_path):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_repo_modules():
    _stub("aider", __path__=[str(ROOT / "aider")])
    _stub("aider.dump", dump=Unavailable)
    _stub("aider.utils", GitTemporaryDirectory=Unavailable)
    _stub("aider.coders", __path__=[str(ROOT / "aider" / "coders")])
    _stub("aider.coders.base_coder", Coder=type("Coder", (), {}))
    _stub("aider.coders.editblock_prompts", EditBlockPrompts=type("EditBlockPrompts", (), {}))
    _stub("diff_match_patch", diff_match_patch=Unavailable)
    sr = _load_module("aider.coders.search_replace", "aider/coders/search_replace.py")
    eb = _load_module("aider.coders.editblock_coder", "aider/coders/editblock_coder.py")
    return sr, eb


SR, EB = load_repo_modules()

# ---------------------------------------------------------------------------
# fixture (newline-distinct) + normalized operation result
# ---------------------------------------------------------------------------
ORIGINAL = 'def first():\n    log("done")\n    return 1\n\n\ndef second():\n    log("done")'
EXACT_SEARCH = '    log("done")\n'  # carries the newline -> exactly one site
AMBIGUOUS_SEARCH = '    log("done")'  # newline dropped -> two sites
SPACE_DISTINCT_SEARCH = '    log("done") \n'  # trailing space -> distinct text
REPLACE = '    log("done", 2)\n'


def mutated_sites(before, after, marker):
    """How many copies of the REPLACE `marker` the result carries (0 == no mutation)."""
    if before == after:
        return 0
    return after.count(marker)


def apply_edit(original, search, replace):
    """The contract operation.

    Exactness first: the SEARCH bytes are matched verbatim (newline/whitespace
    included), so `occurrences == original.count(search)` decides the outcome.
    A unique match is applied exactly once (through the repository primitive,
    which replaces every occurrence of its search text - hence the guard); a
    non-unique match is rejected before any mutation is attempted.
    """
    occurrences = original.count(search)
    if not search or occurrences == 0:
        return dict(status="no_match", occurrences=occurrences, applied_count=0, result=original)
    if occurrences > 1:
        return dict(
            status="rejected_non_unique", occurrences=occurrences, applied_count=0, result=original
        )
    result = SR.search_and_replace((search, replace, original))
    if result != original.replace(search, replace, 1):
        raise AssertionError("unique edit was not applied exactly once")
    return dict(status="applied", occurrences=occurrences, applied_count=1, result=result)


def record(case, search, applied, note="", original=None):
    original = ORIGINAL if original is None else original
    result = applied["result"]
    return dict(
        case=case,
        search=esc(search),
        occurrences=applied["occurrences"],
        status=applied["status"],
        applied_count=applied["applied_count"],
        mutated_sites=mutated_sites(original, result, REPLACE),
        identical=result == original,
        sha256_before=sha(original)[:12],
        sha256_after=sha(result)[:12],
        note=note,
    )


def print_table(rows):
    header = (
        f"| {'case':<44} | {'search':<22} | {'occ':>3} | {'status':<20} "
        f"| {'applied':>7} | {'sites':>5} | {'identical':>9} |"
    )
    print(header)
    print("|" + "-" * (len(header) - 2) + "|")
    for row in rows:
        print(
            f"| {row['case']:<44} | {row['search']:<22} | {row['occurrences']:>3} "
            f"| {row['status']:<20} | {row['applied_count']:>7} | {row['mutated_sites']:>5} "
            f"| {str(row['identical']):>9} |"
        )
    print()


def phase1_contract_demo():
    print("=" * 100)
    print("PHASE 1 - contract demo: distinct newline/whitespace edit fixture")
    print("=" * 100)
    print(f"fixture ORIGINAL = {ORIGINAL!r}\n")

    rows = []

    # -- required property 1: the exact (distinct-by-newline) edit succeeds once
    applied = apply_edit(ORIGINAL, EXACT_SEARCH, REPLACE)
    rows.append(record("exact_newline_distinct_edit", EXACT_SEARCH, applied))
    expected = ORIGINAL.replace(EXACT_SEARCH, REPLACE, 1)
    check(applied["status"] == "applied", "exact edit status == applied")
    check(applied["applied_count"] == 1, "exact edit applied_count == 1 (succeeds once)")
    check(applied["result"] == expected, "exact edit result == text.replace(SEARCH, REPLACE, 1)")
    check(applied["result"].count('log("done", 2)') == 1, "exactly one site carries the REPLACE text")
    check(applied["result"].count('    log("done")') == 1, "the other (second) site is untouched")
    check(
        applied["result"].split("def second()")[0].count('log("done", 2)') == 1,
        "the edit landed on the intended site (first), not on second()",
    )
    check(
        mutated_sites(ORIGINAL, applied["result"], REPLACE) == 1,
        "exact edit mutated exactly one site",
    )

    # -- required property 2: the non-unique edit fails without partial mutation
    rejected = apply_edit(ORIGINAL, AMBIGUOUS_SEARCH, REPLACE)
    rows.append(record("non_unique_edit", AMBIGUOUS_SEARCH, rejected))
    check(rejected["status"] == "rejected_non_unique", "non-unique edit status == rejected_non_unique")
    check(rejected["occurrences"] == 2, "non-unique SEARCH occurs twice in the fixture")
    check(rejected["applied_count"] == 0, "non-unique edit applied_count == 0 (fails)")
    check(rejected["result"] == ORIGINAL, "non-unique edit returns the original text unchanged")
    check(
        mutated_sites(ORIGINAL, rejected["result"], REPLACE) == 0,
        "non-unique edit performs no partial mutation",
    )
    check(sha(rejected["result"]) == sha(ORIGINAL), "non-unique edit: content hash identical (no write)")

    # -- whitespace is part of the identity: a space-only difference is a distinct, absent text
    spaced = apply_edit(ORIGINAL, SPACE_DISTINCT_SEARCH, REPLACE)
    rows.append(record("whitespace_distinct_no_match", SPACE_DISTINCT_SEARCH, spaced))
    check(spaced["status"] == "no_match", "whitespace-different SEARCH is a distinct text (no match)")
    check(spaced["result"] == ORIGINAL, "no_match leaves the text untouched")

    # -- why the contract needs its own uniqueness precondition: the repository
    #    primitive itself does NOT fail on a non-unique search (guard commented out)
    unguarded = SR.search_and_replace((AMBIGUOUS_SEARCH, REPLACE, ORIGINAL))
    rows.append(
        record(
            "baseline: search_and_replace (unguarded)",
            AMBIGUOUS_SEARCH,
            dict(status="applied_unguarded", occurrences=2, applied_count=2, result=unguarded),
            note="search_replace.py:437-439 guard is commented out -> mutates every match",
        )
    )
    check(unguarded.count('log("done", 2)') == 2, "baseline primitive silently mutates BOTH sites")
    check(
        mutated_sites(ORIGINAL, unguarded, REPLACE) == 2,
        "baseline primitive mutates two sites at once (no failure reported)",
    )

    # -- the same primitive behind the flexible strategy ladder
    flex_exact = SR.flexible_search_and_replace(
        (EXACT_SEARCH, REPLACE, ORIGINAL), SR.editblock_strategies
    )
    rows.append(
        record(
            "baseline: flexible_search_and_replace (distinct)",
            EXACT_SEARCH,
            dict(status="applied_unguarded", occurrences=1, applied_count=1, result=flex_exact),
        )
    )
    flex_ambig = SR.flexible_search_and_replace(
        (AMBIGUOUS_SEARCH, REPLACE, ORIGINAL), SR.editblock_strategies
    )
    rows.append(
        record(
            "baseline: flexible_search_and_replace (ambiguous)",
            AMBIGUOUS_SEARCH,
            dict(status="applied_unguarded", occurrences=2, applied_count=2, result=flex_ambig),
            note="lenient first strategy wins, ambiguity is not reported",
        )
    )
    check(flex_exact == expected, "flexible ladder reproduces the single exact edit")
    check(flex_ambig.count('log("done", 2)') == 2, "flexible ladder silently mutates both sites")

    # -- editblock path: unique chunk applied once (plus EOF newline normalization)
    eb_applied = EB.replace_most_similar_chunk(ORIGINAL, EXACT_SEARCH, REPLACE)
    rows.append(
        record(
            "baseline: editblock replace_most_similar_chunk",
            EXACT_SEARCH,
            dict(status="applied_unguarded", occurrences=1, applied_count=1, result=eb_applied),
            note="editblock_coder.prep() adds the missing EOF newline",
        )
    )
    check(eb_applied == expected + "\n", "editblock path applies the unique edit once (+EOF newline)")

    # -- repository path that really fails on a non-unique chunk, without partial mutation
    whole = (
        "def gamma():\n"
        "    pass\n"
        "\n"
        "\n"
        "def alpha():\n"
        "    total = 0\n"
        "    return total\n"
        "\n"
        "\n"
        "def beta():\n"
        "    total = 0\n"
        "    return total\n"
    )
    part = "def gamma():\n    pass\n...\n    total = 0\n"  # chunk 1 unique, chunk 2 non-unique
    updated = "def gamma():\n    return 0\n...\n    total = 1\n"
    try:
        EB.try_dotdotdots(whole, part, updated)
        raised = False
    except ValueError:
        raised = True
    check(raised, "try_dotdotdots raises ValueError on the non-unique chunk (count > 1)")
    check(whole.count("    total = 0\n") == 2, "the failing chunk really is non-unique")
    check(
        EB.replace_most_similar_chunk(whole, part, updated) is None,
        "replace_most_similar_chunk swallows the error -> returns None (edit fails)",
    )

    # file level: a failed edit performs no write (mirrors EditBlockCoder.apply_edits)
    tmp = ROOT / ".prale-eval" / "_contract_fixture.tmp"
    try:
        tmp.write_text(whole)
        before_hash = sha(tmp.read_text())
        new_content = EB.do_replace(tmp, whole, part, updated, EB.DEFAULT_FENCE)
        check(new_content is None, "do_replace returns None for the non-unique chunked edit")
        written = tmp.write_text(new_content) if new_content else None
        check(written is None, "no write happens when the edit fails (write-on-success only)")
        after_hash = sha(tmp.read_text())
        check(after_hash == before_hash, "on-disk fixture is byte-identical after the failed edit")

        # positive counterpart: the unique chunk would be written exactly once
        unique_part = "def gamma():\n    pass\n"
        unique_updated = "def gamma():\n    return 0\n"
        ok_content = EB.do_replace(tmp, whole, unique_part, unique_updated, EB.DEFAULT_FENCE)
        check(ok_content is not None, "do_replace succeeds for the unique chunk")
        if ok_content:
            tmp.write_text(ok_content)
        reread = tmp.read_text()
        check(reread.count("    return 0\n") == 1, "unique chunk written once on disk")
        check(reread.count("    pass\n") == 0, "unique chunk removed exactly at its own site")
    finally:
        tmp.unlink(missing_ok=True)
    rows.append(
        dict(
            case="repo: non-unique chunk fails, no partial mutation",
            search=esc("    total = 0\\n"),
            occurrences=2,
            status="rejected_non_unique",
            applied_count=0,
            mutated_sites=0,
            identical=after_hash == before_hash,
            sha256_before=before_hash[:12],
            sha256_after=after_hash[:12],
            note="try_dotdotdots counted chunk 2 twice -> ValueError -> no write",
        )
    )

    print_table(rows)

    for row in rows:
        if row["note"]:
            print(f"NOTE {row['case']}: {row['note']}")
    print()
    print("contract properties:")
    print("  1. distinct (newline-carrying) SEARCH -> applied exactly once : checked above")
    print("  2. non-unique SEARCH -> rejected with zero mutation           : checked above")
    print()


# ---------------------------------------------------------------------------
# phase 2: artifact + citation check
# ---------------------------------------------------------------------------
def symbol_ranges(rel_path):
    """name -> (start, end) for functions, classes (dotted methods) and assignments."""
    tree = ast.parse((ROOT / rel_path).read_text())
    ranges = {}

    def walk(body, prefix=""):
        for node in body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                ranges[prefix + node.name] = (node.lineno, node.end_lineno)
                if isinstance(node, ast.ClassDef):
                    walk(node.body, prefix + node.name + ".")
            elif isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        ranges[prefix + target.id] = (node.lineno, node.end_lineno)

    walk(tree.body)
    return ranges


def phase2_artifact_check():
    print("=" * 100)
    print("PHASE 2 - artifact check: .prale-eval/result.json schema + AST citation verification")
    print("=" * 100)
    if not ARTIFACT.exists():
        FAILURES.append("result.json is missing")
        print("  FAIL .prale-eval/result.json is missing")
        return

    data = json.loads(ARTIFACT.read_text())
    check(data.get("task_id") == "T03", "task_id == T03")
    check(data.get("repository") == "aider", "repository == aider")
    check(data.get("mode") == "contract", "mode == contract")
    for key in ("evidence", "claims", "conclusion", "validation"):
        check(key in data, f"required key present: {key}")
    check(isinstance(data.get("conclusion"), str) and data["conclusion"].strip() != "", "conclusion is non-empty")
    validation = data.get("validation", {})
    for key in ("command", "status", "notes"):
        check(key in validation, f"validation.{key} present")

    evidence = data.get("evidence", [])
    check(bool(evidence), "evidence is a non-empty list")
    evidence_paths = []
    for index, item in enumerate(evidence):
        for key in ("path", "symbol", "start_line", "end_line", "observation"):
            check(key in item, f"evidence[{index}].{key} present")
        rel = item["path"]
        evidence_paths.append(rel)
        start, end = item["start_line"], item["end_line"]
        check(
            (ROOT / rel).exists(),
            f"evidence[{index}] path exists: {rel}",
        )
        check(
            isinstance(start, int) and isinstance(end, int) and start <= end,
            f"evidence[{index}] inclusive range ordered: {start} <= {end}",
        )
        ranges = symbol_ranges(rel)
        symbol = item["symbol"]
        if not check(symbol in ranges, f"evidence[{index}] symbol is real: {symbol}"):
            continue
        sym_start, sym_end = ranges[symbol]
        check(
            start <= sym_start and sym_end <= end,
            f"evidence[{index}] range {start}-{end} contains {symbol} ({sym_start}-{sym_end})",
        )
        check(
            bool(item["observation"].strip()),
            f"evidence[{index}] observation is substantive",
        )

    required_path = "aider/coders/search_replace.py"
    check(required_path in evidence_paths, f"required source evidence present: {required_path}")

    claims = data.get("claims", [])
    check(bool(claims), "claims is a non-empty list")
    for index, claim in enumerate(claims):
        for key in ("claim", "evidence_paths"):
            check(key in claim, f"claims[{index}].{key} present")
        paths = claim.get("evidence_paths", [])
        check(
            bool(paths) and all(p in evidence_paths for p in paths),
            f"claims[{index}] evidence_paths all cited in evidence ({paths})",
        )
    check(
        any(required_path in claim.get("evidence_paths", []) for claim in claims),
        f"at least one claim cites {required_path}",
    )
    print()


def main():
    phase1_contract_demo()
    phase2_artifact_check()
    print("=" * 100)
    if FAILURES:
        print(f"RESULT: FAIL ({len(FAILURES)} check(s) failed)")
        for failure in FAILURES:
            print(f"  - {failure}")
        return 1
    print("RESULT: PASS - exact edit applied once; non-unique edit rejected without partial mutation")
    print("        result.json schema OK; every cited symbol lies inside its reported line range")
    return 0


if __name__ == "__main__":
    sys.exit(main())
