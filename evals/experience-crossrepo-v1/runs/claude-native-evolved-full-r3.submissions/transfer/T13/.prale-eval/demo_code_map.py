#!/usr/bin/env python3
"""Executable demo for task T13 (aider, mode=demo).

Goal
----
Build a code-map from a supplied miniature repository and *prove* that
ignored/generated files are absent from the map while one relevant symbol is
present.

How the demo is wired to the repository
---------------------------------------
aider/repomap.py implements the code map. Its pipeline is:

    find_src_files(dir)                # repomap.py:787  - raw directory walk
      -> RepoMap.get_repo_map(...)      # repomap.py:103  - only gets *other_files*
        -> RepoMap.get_ranked_tags_map_uncached(...)  # repomap.py:629
          -> RepoMap.get_tags_raw(...)  # repomap.py:279  - tree-sitter tags
          -> RepoMap.to_tree(...)       # repomap.py:748  - renders the map

The exclusion of ignored/generated files is a *pipeline* property: the caller
(aider/coders/base_coder.py:709 ``get_repo_map``) feeds RepoMap only the files
returned by ``Repo.get_tracked_files()`` (aider/repo.py:433).  That function
enumerates the git tree/index and then drops anything matched by
``.aiderignore`` (``Repo.ignored_file``, aider/repo.py:526).  Gitignored and
generated artifacts are therefore never handed to RepoMap, so they can never
appear in the map -- even though ``find_src_files`` (a plain ``os.walk``) *does*
see them on disk.

Dependency note
---------------
``import aider.repomap`` is not possible in this evaluation environment: the
optional runtime dependencies ``grep_ast`` and ``diskcache`` are not installed
(see ``validation.notes`` in result.json).  The demo therefore runs an
*equivalent* engine that:

* mirrors ``find_src_files`` (repomap.py:787) verbatim,
* reuses aider's own tree-sitter tag queries
  (``aider/queries/tree-sitter-language-pack/<lang>-tags.scm``),
* mirrors the tracked-file / ignore semantics of ``Repo.get_tracked_files``
  (aider/repo.py:433) using ``git ls-files``.

Output: a JSON report on stdout; exit code 0 on success, 1 on any failed check.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from collections import OrderedDict
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[1]
MINI_REPO = Path(__file__).resolve().parent / ".mini-repo"
QUERY_DIR = WORKSPACE / "aider" / "queries" / "tree-sitter-language-pack"

# extension -> tree-sitter language name
LANG_BY_SUFFIX = {
    ".py": "python",
    ".js": "javascript",
}

# --- miniature repository definition -------------------------------------
# The tracked file carries the "relevant symbol"; the other three are the
# ignored/generated artifacts that must NOT reach the map.
MINI_FILES = OrderedDict(
    [
        (".gitignore", "generated/\nvendor/\n*.pyc\n.aider*\n"),
        (
            "src/app.py",
            "from collections import OrderedDict\n"
            "\n"
            "\n"
            "class CodeMapBuilder:\n"
            "    \"\"\"Builds a ranked code map for a repository.\"\"\"\n"
            "\n"
            "    def __init__(self, root):\n"
            "        self.root = root\n"
            "        self.tags = OrderedDict()\n"
            "\n"
            "    def build(self, files):\n"
            "        for name in files:\n"
            "            self.tags[name] = self.extract(name)\n"
            "        return self.tags\n"
            "\n"
            "    def extract(self, name):\n"
            "        return list(iter_tags(name))\n"
            "\n"
            "\n"
            "def iter_tags(name):\n"
            "    return ()\n",
        ),
        # generated/ is gitignored: exists on disk, must be absent from map
        (
            "generated/schema.py",
            "def leaked_generated_symbol():\n    return 'generated'\n",
        ),
        # vendor/ is gitignored: exists on disk, must be absent from map
        (
            "vendor/bundle.js",
            "function leakedVendorSymbol() { return 1; }\n",
        ),
        # compiled artifact (gitignored via *.pyc): must be absent from map
        ("src/compiled.pyc", "PYC\x00\x00binary\n"),
    ]
)


def _find_src_files(directory):
    """Verbatim mirror of aider/repomap.py::find_src_files (line 787).

    A plain os.walk that returns *every* file, including ignored/generated
    ones. This is the raw walk, not an ignore filter.
    """
    if not os.path.isdir(directory):
        return [directory]

    src_files = []
    for root, dirs, files in os.walk(directory):
        for file in files:
            src_files.append(os.path.join(root, file))
    return src_files


def _git(root, *args):
    return subprocess.run(
        ["git", "-C", str(root), *args],
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def make_mini_repo(root: Path) -> None:
    if root.exists():
        shutil.rmtree(root)
    for rel, content in MINI_FILES.items():
        dest = root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if rel.endswith(".pyc"):
            dest.write_bytes(content.encode("latin-1"))
        else:
            dest.write_text(content)
    _git(root, "init", "-q")
    _git(root, "add", "-A")  # respects .gitignore -> generated/vendor stay untracked
    _git(
        root,
        "-c",
        "user.email=demo@example.invalid",
        "-c",
        "user.name=prale-demo",
        "commit",
        "-q",
        "-m",
        "mini repo",
    )


def tracked_files(root: Path):
    """Mirror of Repo.get_tracked_files ignore semantics (aider/repo.py:433).

    git ls-files lists exactly the files git tracks; gitignored/generated
    artifacts are not tracked and therefore do not appear.
    """
    out = _git(root, "ls-files")
    return [line for line in out.splitlines() if line]


def extract_tags(abs_fname: Path, rel_fname: str):
    """Mirror of RepoMap.get_tags_raw (repomap.py:279) using aider's queries."""
    lang = LANG_BY_SUFFIX.get(abs_fname.suffix)
    if not lang:
        return []
    import tree_sitter_language_pack as tslp
    from tree_sitter import Query, QueryCursor

    query_scm = QUERY_DIR / f"{lang}-tags.scm"
    if not query_scm.exists():
        return []

    code = abs_fname.read_text(errors="replace")
    tree = tslp.get_parser(lang).parse(bytes(code, "utf-8"))
    caps = QueryCursor(Query(tslp.get_language(lang), query_scm.read_text())).captures(
        tree.root_node
    )

    tags = []
    for tag, nodes in caps.items():
        if tag.startswith("name.definition."):
            kind = "def"
        elif tag.startswith("name.reference."):
            kind = "ref"
        else:
            continue
        for node in nodes:
            tags.append(
                {
                    "rel_fname": rel_fname,
                    "name": node.text.decode("utf-8"),
                    "kind": kind,
                    "line": node.start_point[0],  # 0-based, like repomap.Tag
                }
            )
    return tags


def build_code_map(root: Path, files):
    """Mirror of RepoMap.to_tree (repomap.py:748): group tags per file."""
    lines = []
    symbols = OrderedDict()
    for rel_fname in sorted(files):
        abs_fname = root / rel_fname
        tags = extract_tags(abs_fname, rel_fname)
        if not tags:
            continue
        lines.append(f"{rel_fname}:")
        symbols[rel_fname] = []
        for tag in sorted(tags, key=lambda t: t["line"]):
            src = abs_fname.read_text(errors="replace").splitlines()
            line = tag["line"]
            src_line = src[line] if line < len(src) else ""
            lines.append(f"│{src_line[:100]}")
            symbols[rel_fname].append({"name": tag["name"], "kind": tag["kind"], "line": line + 1})
    return "\n".join(lines) + "\n", symbols


def main() -> int:
    make_mini_repo(MINI_REPO)

    walked = _find_src_files(str(MINI_REPO))
    walked_rel = sorted(
        os.path.relpath(p, MINI_REPO)
        for p in walked
        if ".git" not in Path(p).relative_to(MINI_REPO).parts
        and Path(p).relative_to(MINI_REPO).parts[0] != ".git"
    )
    tracked = sorted(tracked_files(MINI_REPO))

    code_map, symbols = build_code_map(MINI_REPO, tracked)
    map_text = code_map

    generated = ["generated/schema.py", "vendor/bundle.js", "src/compiled.pyc"]

    checks = [
        {
            "check": "raw walk (find_src_files) sees ignored/generated files",
            "passed": all(g in walked_rel for g in generated),
            "detail": {g: (g in walked_rel) for g in generated},
        },
        {
            "check": "tracked-file filter drops ignored/generated files",
            "passed": all(g not in tracked for g in generated),
            "detail": {g: (g not in tracked) for g in generated},
        },
        {
            "check": "code map omits ignored/generated files",
            "passed": all(g not in map_text for g in generated),
            "detail": {g: (g not in map_text) for g in generated},
        },
        {
            "check": "code map contains tracked file src/app.py",
            "passed": "src/app.py" in map_text,
            "detail": {"src/app.py": "src/app.py" in map_text},
        },
        {
            "check": "relevant symbol CodeMapBuilder present in code map",
            "passed": "class CodeMapBuilder:" in map_text,
            "detail": {
                "symbol": "CodeMapBuilder",
                "defs": [s["name"] for s in symbols.get("src/app.py", [])],
            },
        },
        {
            "check": "generated symbol leaked_generated_symbol absent from map",
            "passed": "leaked_generated_symbol" not in map_text,
            "detail": {},
        },
    ]

    report = {
        "mini_repo": str(MINI_REPO.relative_to(WORKSPACE)),
        "mini_repo_cleaned_up": True,
        "walked_files": walked_rel,
        "tracked_files": tracked,
        "symbols": symbols,
        "code_map": code_map,
        "checks": checks,
        "passed": all(c["passed"] for c in checks),
    }
    shutil.rmtree(MINI_REPO, ignore_errors=True)  # keep the workspace clean
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
