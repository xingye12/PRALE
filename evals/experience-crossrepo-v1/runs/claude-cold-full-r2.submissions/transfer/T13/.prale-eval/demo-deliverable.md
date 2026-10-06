# Demo deliverable — miniature-repo code-map (aider)

**Task:** T13 · **Repository:** aider · **Mode:** demo

## What this demo proves

Given a supplied miniature git repository (`demo/mini_repo`), a code-map is
built and two properties of aider's repo-map contract are demonstrated:

1. **Ignored / generated files are absent** — `generated/models_pb2.py` and
   `build/artifact.py` (both matched by the mini repo's `.gitignore`) do not
   appear in the map, and neither do their symbols `GeneratedModel` or
   `build_artifact`.
2. **A relevant symbol is present** — the tracked source `app/core.py` appears
   with its definitions, including `CodeMapBuilder`, `build_code_map`,
   `extract_symbols`, `parse_source`.

The unfiltered directory walk *does* see the generated files, so the demo
shows the exclusion is a real filter rather than an artifact of the fixture.

## Executable demo

```bash
python demo/repo_map_demo.py
```

The script:

1. (Re)creates the miniature repository `demo/mini_repo` with `git init`,
   commits the tracked sources, and leaves two gitignored/generated artifacts
   on disk (`generated/models_pb2.py`, `build/artifact.py`).
2. Computes the **unfiltered walk** (`os.walk`, the behaviour of
   `find_src_files` in `aider/repomap.py`) — this includes the generated files.
3. Computes the **git-tracked file set** (`git ls-files`, mirroring
   `GitRepo.get_tracked_files` in `aider/repo.py`, which drops ignored paths) —
   this excludes the generated files.
4. Builds the code-map from the tracked set, extracting definition symbols with
   the repository's **own** tree-sitter tags query
   `aider/queries/tree-sitter-language-pack/python-tags.scm`, i.e. the same
   `name.definition.*` capture contract used by `RepoMap.get_tags_raw`.
5. Asserts the properties above and writes `demo/demo-output.json`.

## Contract being exercised

From `aider/repomap.py`:

- `RepoMap.get_repo_map` (lines 103–167) is the public entry point and returns
  the rendered listing produced from the supplied file lists.
- `RepoMap.get_ranked_tags_map_uncached` (lines 629–706) builds the map only
  from `chat_fnames`/`other_fnames` handed in — it never scans the filesystem.
- `find_src_files` (lines 787–795) is a plain `os.walk` helper with **no**
  ignore filtering, so the "ignored files absent" property is not enforced
  inside repomap.

From `aider/repo.py`:

- `GitRepo.get_tracked_files` (lines 433–488) is the git-aware producer of the
  file list, filtering with `if not self.ignored_file(fname)`. This is where
  gitignored/generated paths are dropped before reaching `RepoMap`.

## Normalized operation result

`demo/demo-output.json`:

| Field | Value |
|---|---|
| `raw_walk` | `.gitignore`, `app/__init__.py`, `app/core.py`, `app/util.py`, `build/artifact.py`, `generated/models_pb2.py` |
| `tracked_files` (fed to the map) | `.gitignore`, `app/__init__.py`, `app/core.py`, `app/util.py` |
| `code_map` | `app/core.py → CodeMapBuilder, build_code_map, extract_symbols, parse_source`; `app/util.py → normalize_name`; `.gitignore`, `app/__init__.py` → no defs |
| `status` | `pass` (8/8 checks) |

## Validation

```bash
python demo/repo_map_demo.py    # status: pass
```

Result recorded in `.prale-eval/result.json` (`validation`).

**Limitation:** the real `aider.repomap.RepoMap` cannot be instantiated in this
environment because the optional third-party dependencies `diskcache` (also
`grep_ast`, GitPython) are not installed, and dependencies must not be
installed. The demo records this as `real_repomap.status = "unavailable"`
(`ModuleNotFoundError: No module named 'diskcache'`) and validates the same
contract using the repository's own tags query for symbol extraction.
