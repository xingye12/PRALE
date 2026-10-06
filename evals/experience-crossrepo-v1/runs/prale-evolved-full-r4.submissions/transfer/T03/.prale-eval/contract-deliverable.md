# T03 contract — distinct newline/whitespace edit fixture (repository `aider`)

Executable demo: **`.prale-eval/edit_contract_demo.py`**
Re-run validation: **`python .prale-eval/edit_contract_demo.py`** (exit code 0 = contract + artifact check pass)

The contract answers one question: for a fixture whose two candidate edit sites differ
only by **newline/whitespace**, does an *exact* edit succeed exactly once, and does a
*non-unique* edit fail without partially mutating the text?

---

## 1. Fixture

```
ORIGINAL   = 'def first():\n    log("done")\n    return 1\n\n\ndef second():\n    log("done")'   # no EOF newline
SEARCH(A)  = '    log("done")\n'      # carries the newline  -> 1 occurrence  (site: first())
SEARCH(B)  = '    log("done")'        # newline dropped       -> 2 occurrences (first() and second())
SEARCH(C)  = '    log("done") \n'     # trailing space added  -> 0 occurrences
REPLACE    = '    log("done", 2)\n'
```

The *same* logical edit is distinct or ambiguous depending only on the bytes of the
SEARCH text: the trailing newline is the whole distinction. That is the newline/whitespace
nature of the fixture — and it is also why `whitespace is not "close enough"`: variant (C)
is a different, absent text, not a fuzzy match.

## 2. Contract

```
apply_edit(original, search, replace) -> normalized operation result
  occurrences = original.count(search)          # exact byte match, newline/whitespace included
  occurrences == 0  -> status "no_match"              applied_count 0, result == original
  occurrences >  1  -> status "rejected_non_unique"   applied_count 0, result == original  (no partial mutation)
  occurrences == 1  -> status "applied"               applied_count 1,
                        result = repo_primitive(search, replace, original)   (== original.replace(search, replace, 1))
```

Two guarantees are asserted, not merely described:

* **P1 — an exact edit succeeds once**: `applied_count == 1`, exactly one mutated site,
  the sibling site byte-identical, and the edit lands on the intended site (`first()`).
* **P2 — a non-unique edit fails without partial mutation**: `applied_count == 0`,
  result byte-identical to the input (same sha256, zero mutated sites).

The uniqueness precondition lives in the contract because this checkout has none on the
search/replace path: in `aider/coders/search_replace.py:437-439` the guard is commented out
(`# if num > 1:  #    raise SearchTextNotUnique()`) and line 443 calls `str.replace` with no
count, i.e. it rewrites **every** occurrence. The only live `count > 1` guard in the
repository is `editblock_coder.try_dotdotdots` (lines 233-236).

## 3. Normalized operation result (actual demo output)

`·` = space, `\n` = newline. `occ` = occurrences of the SEARCH in the fixture,
`applied` = how many edits took effect, `sites` = mutated sites, `identical` = result is
byte-identical to the input.

| case | search | occ | status | applied | sites | identical |
|---|---|---|---|---|---|---|
| exact_newline_distinct_edit (`apply_edit`) | `····log("done")\n` | 1 | `applied` | 1 | 1 | False |
| non_unique_edit (`apply_edit`) | `····log("done")` | 2 | `rejected_non_unique` | 0 | 0 | **True** |
| whitespace_distinct_no_match (`apply_edit`) | `····log("done")·\n` | 0 | `no_match` | 0 | 0 | **True** |
| baseline: `search_and_replace` (unguarded) | `····log("done")` | 2 | `applied_unguarded` | 2 | 2 | False |
| baseline: `flexible_search_and_replace` (distinct) | `····log("done")\n` | 1 | `applied_unguarded` | 1 | 1 | False |
| baseline: `flexible_search_and_replace` (ambiguous) | `····log("done")` | 2 | `applied_unguarded` | 2 | 2 | False |
| baseline: editblock `replace_most_similar_chunk` | `····log("done")\n` | 1 | `applied_unguarded` | 1 | 1 | False |
| repo: non-unique chunked edit fails | `····total·=·0\n` | 2 | `rejected_non_unique` | 0 | 0 | **True** |

Reading of the rows:

1. **P1 holds** on the distinct SEARCH (row 1): one application, one mutated site, sibling site intact.
2. **P2 holds** for the ambiguous SEARCH (row 2): rejected, zero mutation, unchanged hash.
3. Rows 4-6 are the *hazard* the contract must absorb: the repository primitives do **not**
   fail on ambiguity. `search_and_replace` mutates both sites; the flexible ladder
   (`flexible_search_and_replace` over `editblock_strategies`) returns that lenient first
   result, so the ambiguity is never reported; `replace_most_similar_chunk` /
   `perfect_replace` silently resolve to the first match. Hence the contract's own count check.
4. Row 8 is the **repository's own failing path**, exercised through real code:
   `try_dotdotdots` counts chunk 2 (`'    total = 0\n'`) twice → `ValueError`; the mutation
   applied to chunk 1 beforehand existed only in a local variable and is discarded;
   `replace_most_similar_chunk` swallows the error and returns `None`; `do_replace` propagates
   `None`; `EditBlockCoder.apply_edits` writes only `if new_content:` — the fixture file on
   disk stayed byte-identical (sha256 unchanged). This is "fails without partial mutation"
   demonstrated end-to-end, plus the positive counterpart: the unique chunk was written
   exactly once.

## 4. Newline/whitespace specifics that the demo pins down

* `strip_blank_lines` (`search_replace.py:611-614`, `text.strip("\n") + "\n"`) and `prep`
  (`editblock_coder.py:127-131`, appends a missing EOF newline) both **normalize newlines
  before matching**; under `prep` the fixture's EOF-newline distinction disappears, so
  distinctness must be decided on the raw SEARCH bytes (which the contract does).
* `try_strategy` (`search_replace.py:586-608`) returns `None` — never a half-transformed
  text — when a strategy fails or the relative-indent back-conversion raises, which is the
  per-attempt mechanism behind "no partial mutation" on the ladder path.
* The editblock unique edit returns `original.replace(SEARCH, REPLACE, 1) + "\n"`, i.e. the
  single edit **plus** the EOF-newline normalization performed by `prep` (recorded as
  `sites=1` because the REPLACE marker appears once).

## 5. Validation

```
$ python .prale-eval/edit_contract_demo.py
PHASE 1 - contract demo : 29/29 checks ok
PHASE 2 - artifact check: .prale-eval/result.json schema + AST citation verification: all ok
RESULT: PASS - exact edit applied once; non-unique edit rejected without partial mutation
        result.json schema OK; every cited symbol lies inside its reported line range
```

Phase 2 checks `task_id == T03`, `repository == aider`, `mode == contract`, the presence of
`evidence` / `claims` / `conclusion` / `validation` (with `command` / `status` / `notes`), that
each evidence entry names a real symbol whose definition (AST-resolved) lies inside the
reported inclusive `start_line`/`end_line`, that every `claims[].evidence_paths` is cited in
`evidence`, and that the required path `aider/coders/search_replace.py` is covered.

### Recorded limitation (not worked around)

Optional runtime dependencies of this checkout are **not installed** and installing them is
prohibited: `json5` (imported by `aider/models.py`), `litellm`, `diff_match_patch`, GitPython
and `oslex` are all missing. Therefore `aider.coders.*` cannot be imported normally and
`python -m pytest tests/basic/test_editblock.py -x -q` fails at collection (1 error).
Substituted, lower-strength evidence: both modules under test are loaded directly from source
with `importlib.util.spec_from_file_location`, with stubs for the unrelated `Coder`/prompt
base classes and for `diff_match_patch` that raise if touched (they are never touched, since
the contract exercises only exact-string strategies). Consequences: the
`diff_match_patch`-based strategies (`dmp_apply`, `dmp_lines_apply`, `diff_lines`) are out of
scope here and were not executed, and the file-level `_contract_fixture.tmp` check replaces a
full `EditBlockCoder` run (the write-on-success policy it mirrors is read from
`EditBlockCoder.apply_edits:41-124`).

No source file, task metadata, hidden-oracle file, lock file or git configuration was
modified; the only writes are inside `.prale-eval/`, and the demo deletes its temporary
fixture file in a `finally` block.
