# Contract deliverable — learn/08 (repository `aider`, mode `contract`)

## Scope

Contract for **ambiguous search/replace matches** in aider's edit-block handling,
centred on `aider/coders/search_replace.py` and the edit-block matcher in
`aider/coders/editblock_coder.py`, with a focused failure case added to
`tests/basic/test_editblock.py`.

## The contract (normalized operation result)

An edit is only applied when the SEARCH side identifies a **unique** location.

1. **Ambiguous `...` elision → failure.** When a SEARCH block contains a `...`
   elision, `try_dotdotdots()` splits it into pieces and, for each piece, raises
   `ValueError` if `whole.count(part) == 0` **or `whole.count(part) > 1`**
   (`aider/coders/editblock_coder.py:190-240`). `replace_most_similar_chunk()`
   catches that `ValueError` and returns `None` (`:157-187`), so no edit is
   applied; `EditBlockCoder.apply_edits` then reports it via the
   `SearchReplaceNoExactMatch` failure message.
2. **Unique `...` elision → applied.** The mirror case with a piece that occurs
   exactly once is applied normally.
3. **Plain duplicate SEARCH → first occurrence only.** Without `...`, a SEARCH
   that matches several locations replaces only the first occurrence
   (`perfect_replace`, and the existing `test_replace_multiple_matches`).
4. **`search_replace.py` strategy does not guard ambiguity.**
   `search_and_replace()` computes `num = original_text.count(search_text)` but
   the ambiguity guard is commented out (`# if num > 1: raise
   SearchTextNotUnique()`), so it calls `str.replace(search_text, replace_text)`
   with no count and rewrites **every** occurrence
   (`aider/coders/search_replace.py:434-444`). `SearchTextNotUnique` is defined
   (`:524-525`) as the marker exception for this case but is not raised here.

## Focused failure case added

`tests/basic/test_editblock.py::TestUtils.test_replace_ambiguous_match_with_ellipsis_fails`
(`:616-630`):

```python
whole = "beta\nalpha\nbeta\ngamma\n"
part = "beta\n...\nbeta\n"      # the "beta\n" piece matches TWICE -> ambiguous
replace = "beta2\n...\nbeta2\n"
assert eb.replace_most_similar_chunk(whole, part, replace) is None   # edit FAILS
```

The mirror case `test_replace_unambiguous_match_with_ellipsis_succeeds`
(`:632-639`) applies a unique `...` piece, guarding against an over-broad fix.

## Executable demo

`.prale-eval/demo_ambiguous_match.py` runs the **real repository functions**
(extracted from `aider/coders/editblock_coder.py` and
`aider/coders/search_replace.py` via AST) and asserts the four contract points
above. AST extraction is used because the aider runtime imports third-party
packages that are not installed in this sandbox (`json5`, `diff_match_patch`,
`pathspec`, …) and installing dependencies is out of scope; only `re`/`math`/
`difflib` are needed by the extracted bodies.

```
$ python .prale-eval/demo_ambiguous_match.py
{
  "ambiguous_ellipsis_match":      {"returned": null,                     "outcome": "failed"},
  "unambiguous_ellipsis_match":    {"returned": "alpha\nbeta\nGAMMA\n",   "outcome": "applied"},
  "search_replace_ambiguity_guard":{"occurrences": 2, "returned": "bar\nmid\nbar\n", "guard_enabled": false},
  "duplicate_plain_search_first_occurrence": {"occurrences": 2, "returned": "new_line\nline2\nline1\nline3\n"}
}
CONTRACT HOLDS: ambiguous `...` matches fail; unique matches apply.
```

Exit status 0 = every assertion held.

## Validation status

- `python .prale-eval/demo_ambiguous_match.py` → **passed** (exit 0).
- `python -m pytest tests/basic/test_editblock.py` → **not run**: collection fails
  with `ModuleNotFoundError: No module named 'json5'` (also `diff_match_patch`
  unavailable). This is the recorded limitation; the demo substitutes a
  dependency-free execution of the same real functions.
