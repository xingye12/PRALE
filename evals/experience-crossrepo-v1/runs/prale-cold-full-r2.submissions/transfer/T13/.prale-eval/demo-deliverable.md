# Demo deliverable — aider code-map over a miniature repository

Task `T13`, repository `aider`, mode `demo`.

## What the demo is

An executable, dependency-light reproduction of the code-map pipeline that
`aider` uses, run against a supplied miniature repository
(`.prale-eval/mini_repo/`). It proves the two properties the request asks for:

1. **one relevant symbol is present** — `render_code_map` (defined in
   `mini_repo/src/codemap.py`) shows up in the emitted map;
2. **ignored/generated files are absent** — `generated/schema_pb2.py`,
   `ignored_secret.py`, `build/artifact.py` and `notes.log` never reach the
   map, even though all four exist on disk and each carries its own hidden
   symbol.

Run it with:

```
python3 .prale-eval/demo_code_map.py
```

Exit status is `0` when every check passes. The command prints the map plus a
`PASS`/`FAIL` line per check, and writes the normalized operation result to
`.prale-eval/demo-output.json`.

## Contract implemented

The demo mirrors the real code-map contract in `aider`:

| Stage | Upstream reference | Demo behaviour |
|---|---|---|
| file discovery / ignore filtering | `aider/repo.py::Repo.get_tracked_files` (`ignored_file`, `git_ignored_file`) — tracked, non-ignored files only | walks `mini_repo/`, applies the fixture `.gitignore` through `pathspec.GitWildMatchPattern` (the same matcher `Repo.ignored_file_raw` uses) |
| per-file symbol tags | `aider/repomap.py::RepoMap.get_tags_raw` (lines 279–363) — emits `def` / `ref` tags | Python `ast` yields `("def", name, line)` for functions/classes and `("ref", name, line)` for loads/imports |
| ranking | `aider/repomap.py::RepoMap.get_ranked_tags` (lines 365–574) — ident graph + PageRank, tags filtered to identifiers with both defs and refs | same shape of graph; `networkx.pagerank` with a frequency fallback |
| rendering | `aider/repomap.py::RepoMap.render_tree` (710–746) and `RepoMap.to_tree` (748–783) — `rel_fname:` blocks with lines of interest, then bare names for remaining files | renders `rel_fname:` followed by the definition lines, then bare relative names for files without ranked tags |

Because discovery happens **before** the map is built, an ignored or generated
file can never contribute a tag — this is exactly why `RepoMap` itself does not
need gitignore logic: callers hand it the discoverable file list.

## Normalized operation result

`demo-output.json` records:

- `discovered_files` — the source files that reached the map:
  `README.md`, `src/__init__.py`, `src/app.py`, `src/codemap.py`;
- `excluded_files` — files present on disk but filtered out:
  `build/artifact.py`, `generated/schema_pb2.py`, `ignored_secret.py`,
  `notes.log`;
- `ranked_definitions` — `count_symbols`, `render_code_map`,
  `tokenize_symbol` (all in `src/codemap.py`);
- `code_map` — the rendered text:

  ```
  src/codemap.py:
  def count_symbols(files):
  def render_code_map(files, mentioned_idents=None):
  def tokenize_symbol(name):

  README.md

  src/__init__.py

  src/app.py
  ```

- `checks` — all five booleans `true`:
  `relevant_file_present`, `relevant_symbol_present`,
  `ignored_files_exist_on_disk`, `ignored_files_absent`,
  `hidden_symbols_absent`;
- `status` — `pass`.

## Validation

Command: `python3 .prale-eval/demo_code_map.py` → `pass` (exit 0).

### Recorded limitation

The real `aider.repomap.RepoMap` class cannot be instantiated in this
environment: importing it fails with
`ModuleNotFoundError: No module named 'diskcache'` (its runtime stack also
needs `grep_ast`, which is not installed either). Dependencies were **not**
installed. The demo therefore probes `aider.repomap` for importability
(`upstream_repomap_importable: false`, `upstream_repomap_error` recorded in
`demo-output.json`) and falls back to the dependency-free normalized operation
described above, which preserves the contract's externally observable
behaviour: ignored/generated files absent, relevant symbol present. All other
dependencies used by the fallback (`pathspec`, `networkx`) are available.
