# Demo deliverable — T13 / aider / code-map ignore contract

## What this demo is

An executable, self-validating demonstration that aider's code map
(`aider/repomap.py`) contains the tracked source of a repository and a relevant
definition symbol, while **ignored and generated files are absent** from that
map.

* Artifact: `.prale-eval/demo_code_map.py`
* Run: `python3 .prale-eval/demo_code_map.py`
* Result: JSON report on stdout, exit code `0` when every check passes.

## Contract being demonstrated

The code map is built through this pipeline in `aider/repomap.py`:

| Stage | Symbol | Lines |
|---|---|---|
| raw directory walk | `find_src_files` | 787–795 |
| entry point | `RepoMap.get_repo_map` | 103–167 |
| ranking / token budget | `RepoMap.get_ranked_tags_map_uncached` | 629–706 |
| symbol extraction (tree-sitter) | `RepoMap.get_tags_raw` | 279–363 |
| render map text | `RepoMap.to_tree` | 748–784 |

The key invariant: **`RepoMap` never discovers files itself.** It only renders
the file paths the caller hands it as `other_files`. The caller is
`BaseCoder.get_repo_map` (`aider/coders/base_coder.py:709`), which derives
`all_abs_files` from `Repo.get_tracked_files()` (`aider/repo.py:433`). That
function walks the git tree/index and drops anything matched by `.aiderignore`
(`Repo.ignored_file`, `aider/repo.py:526`). Gitignored and generated artifacts
are therefore never tracked, never passed to `RepoMap`, and can never appear in
the map — even though `find_src_files` (a bare `os.walk`) *does* see them on
disk.

So the demonstrated behavior is a **pipeline property**, not a property of the
walk alone.

## Miniature repository used by the demo

The demo materializes a miniature git repository at
`.prale-eval/.mini-repo/` (removed again at the end of the run):

```
.gitignore            -> ignores generated/, vendor/, *.pyc, .aider*
src/app.py            -> tracked; defines class CodeMapBuilder (the relevant symbol)
generated/schema.py   -> ignored/generated; defines leaked_generated_symbol
vendor/bundle.js      -> ignored/generated; defines leakedVendorSymbol
src/compiled.pyc      -> ignored/generated compiled artifact
```

Git history is created with `git init` + `git add -A` + `commit`. `git add -A`
honours `.gitignore`, so only `.gitignore` and `src/app.py` become tracked.

## Checks asserted (all pass)

1. `find_src_files` (raw walk) **sees** `generated/schema.py`,
   `vendor/bundle.js`, `src/compiled.pyc` — proving the walk does no filtering.
2. The tracked-file filter (`git ls-files`, mirroring `Repo.get_tracked_files`)
   **drops** all three ignored/generated files.
3. The rendered code map **omits** all three ignored/generated files.
4. The code map **contains** the tracked file `src/app.py`.
5. The relevant symbol `CodeMapBuilder` (class definition) is **present** in the
   map.
6. The generated symbol `leaked_generated_symbol` is **absent** from the map.

Observed summary from the run:

```
walked : ['.gitignore', 'generated/schema.py', 'src/app.py', 'src/compiled.pyc', 'vendor/bundle.js']
tracked: ['.gitignore', 'src/app.py']
pass = true  (6/6 checks)
```

## Dependency limitation

`import aider.repomap` is **not possible** in this evaluation environment: the
optional runtime dependencies `grep_ast` and `diskcache` are not installed
(`tree_sitter`, `tree-sitter-language-pack`, `pygments` and `tqdm` are).

To keep the demo executable rather than merely descriptive, `demo_code_map.py`
runs an *equivalent* engine that:

* mirrors `find_src_files` (`repomap.py:787`) verbatim,
* reuses aider's **own** tree-sitter tag queries,
  `aider/queries/tree-sitter-language-pack/<lang>-tags.scm`, exactly as
  `get_tags_raw` / `get_scm_fname` do,
* mirrors the ignore semantics of `Repo.get_tracked_files`
  (`aider/repo.py:433`) via `git ls-files`.

This limitation is recorded in `validation.notes` of `result.json`.
