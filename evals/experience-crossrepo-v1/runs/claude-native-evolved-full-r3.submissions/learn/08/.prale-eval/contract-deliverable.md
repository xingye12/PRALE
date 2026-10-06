# Contract deliverable — ambiguous-match failure case (task 08)

Repository: `aider` · Mode: `contract` · Task id: `08`

## Contract statement

**When a SEARCH block is *ambiguous*, edit-block handling must fail rather than edit an
arbitrary (potentially wrong) location.**

Concretely, for elided (`...`) SEARCH blocks the contract is:

1. A `...`-delimited SEARCH piece that matches the file content **more than once** is
   ambiguous. `try_dotdotdots` raises `ValueError` on `whole.count(part) > 1`
   (`aider/coders/editblock_coder.py:235`).
2. `replace_most_similar_chunk` catches that `ValueError` and returns `None`
   (`aider/coders/editblock_coder.py:176-181`), so the edit block is **rejected**; the
   caller (`do_replace`) surfaces it as a non-match instead of writing a wrong edit.
3. When exactly one piece matches, the identical edit **succeeds**.

This edit-block behaviour is the analogue of the library-level ambiguity signal
`SearchTextNotUnique(ValueError)` in `aider/coders/search_replace.py:524`, which
`udiff_coder` imports and catches. Note the plain (non-elided) path resolves ambiguity
differently — it deterministically edits the **first** occurrence (see
`test_replace_multiple_matches`, `tests/basic/test_editblock.py:278`); that first-occurrence
rule is intentionally left unchanged. The new failure case pins the *elided* ambiguity
contract, which is the one that refuses.

## Executable demo / added case

Added to `tests/basic/test_editblock.py` (lines 300–321):

```python
def test_replace_most_similar_chunk_ambiguous_dotdotdots_fails(self):
    part = "aaa\n...\nbbb\n"
    replace = "REPL1\n...\nREPL2\n"

    # Ambiguous: the 'aaa' and 'bbb' pieces each appear twice -> must fail.
    whole_ambiguous = "aaa\nxxx\nbbb\naaa\nyyy\nbbb\nccc\n"
    self.assertIsNone(eb.replace_most_similar_chunk(whole_ambiguous, part, replace))

    # Control: the identical edit succeeds when each piece is unique.
    whole_unique = "aaa\nxxx\nbbb\nccc\n"
    self.assertEqual(
        eb.replace_most_similar_chunk(whole_unique, part, replace),
        "REPL1\nxxx\nREPL2\nccc\n",
    )
```

Run it with:

```
python -m pytest tests/basic/test_editblock.py -k ambiguous -q
```

## Normalized operation result

| Input (`whole`) | `part` / `replace` | Result |
| --- | --- | --- |
| `"aaa\nxxx\nbbb\naaa\nyyy\nbbb\nccc\n"` (pieces duplicated) | `"aaa\n...\nbbb\n"` / `"REPL1\n...\nREPL2\n"` | `None` — **edit rejected** (ambiguous) |
| `"aaa\nxxx\nbbb\nccc\n"` (pieces unique) | same | `"REPL1\nxxx\nREPL2\nccc\n"` — applied |
| `"line1\nline2\nline1\nline3\n"` | `"line1\n"` / `"new_line\n"` | `"new_line\nline2\nline1\nline3\n"` — first occurrence (unchanged contract) |

Failing/`None` return is the contract signal: callers treat a falsy result as "this SEARCH
block did not match" and raise the user-facing non-match error rather than mutating the file.

## Minimal change

Only `tests/basic/test_editblock.py` was modified (one new test method). No production code,
task metadata, hidden-oracle files, package locks, or git configuration were touched.

## Validation limitation

`.prale-eval/result.json` records the environment limitation: `python -m pytest
tests/basic/test_editblock.py -k ambiguous -q` cannot be collected here because optional
runtime dependencies (`json5`, `diff_match_patch`, `gitpython`) are absent and were not
installed. The exact assertions of the new test were instead executed against the real,
unmodified `aider/coders/editblock_coder.py` (loaded with lightweight import stubs) and all
passed; see the `validation` object in `result.json`.
