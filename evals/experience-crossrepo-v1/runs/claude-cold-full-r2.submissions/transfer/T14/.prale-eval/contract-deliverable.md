# T14 — Contract: distinct newline/whitespace edit fixture (`aider`)

## Normalized operation result

The contract concerns the search/replace apply primitive in
`aider/coders/search_replace.py`, exercised through
`flexible_search_and_replace`, which is the single strategy used by
`udiff_coder.flexi_just_search_and_replace` (and therefore by
`directly_apply_hunk`).

The operation is normalized as:

```
apply(search_text, replace_text, original_text) -> (new_text | None, buffer)
```

* `SearchTextNotUnique` (or a falsy strategy result)  -> `(None, original_text)`
  — the edit is **refused** and the caller's buffer is left byte-identical
  to its input.
* a truthy result                                     -> `(new_text, new_text)`
  — the caller writes `new_text` as the new buffer.

## Contract clauses

1. **Exact edit succeeds exactly once.** When `search_text` occurs exactly
   once in `original_text`, `search_and_replace` returns the text with
   exactly one substitution. Newline/whitespace-distinct sibling blocks are
   not collateral.
2. **Non-unique edit fails without partial mutation.** When `search_text`
   occurs more than once, `search_and_replace` raises `SearchTextNotUnique`
   *before* calling `str.replace`, so no occurrence is patched. The caller
   observes `None` and the buffer is unchanged — never a half-applied edit.
3. **No-match edit is a clean refusal.** Zero occurrences returns `None`
   with the buffer unchanged.

## Minimal source change

`aider/coders/search_replace.py` shipped with the uniqueness guard
commented out (fixture baseline, lines 438–439):

```python
num = original_text.count(search_text)
# if num > 1:
#    raise SearchTextNotUnique()
if num == 0:
    return
new_text = original_text.replace(search_text, replace_text)   # replaces ALL
```

That shape cannot satisfy clause 2: a non-unique search silently rewrites
every occurrence. The class `SearchTextNotUnique` (line 524) existed but was
unreachable, as was the `except SearchTextNotUnique` handler in
`udiff_coder.py:276`. The minimal necessary change restores the guard:

```python
num = original_text.count(search_text)
if num > 1:
    raise SearchTextNotUnique()
if num == 0:
    return
```

No other file was touched.

## Executable demo

`.prale-eval/contract_fixture.py` — self-contained, exit code 0 on success:

```
python .prale-eval/contract_fixture.py
```

It loads the **real** functions from `aider/coders/search_replace.py`
(`search_and_replace`, `flexible_search_and_replace`, `all_preprocs`,
`SearchTextNotUnique`) and drives them over this newline/whitespace fixture:

```python
ORIGINAL = (
    "def alpha():\n"
    "    value = compute()\n"
    "    return value\n"
    "\n"
    "\n"
    "def beta():\n"
    "    value = compute()\n"
    "    return value\n"
)
```

| Scenario | search_text | Expectation |
| --- | --- | --- |
| exact / unique | `"def alpha():\n    value = compute()\n    return value\n"` | succeeds, 1 replacement, `beta` untouched |
| non-unique | `"    value = compute()\n    return value\n"` (2 sites) | `None` + buffer unchanged, never patched |
| no-match | `"    value = missing()\n"` | `None` + buffer unchanged |

Because `alpha` and `beta` bodies are byte-identical, only the leading
newline + `def` line distinguishes the unique block — the fixture is
genuinely a *distinct newline/whitespace* discrimination case.

Observed output (all checks PASS):

```
[PASS] exact_edit_succeeds
[PASS] exact_edit_applied_once: replacement count == 1 (expected 1)
[PASS] exact_edit_leaves_sibling_untouched
[PASS] exact_edit_original_immutable
[PASS] non_unique_edit_fails
[PASS] non_unique_no_partial_mutation: buffer byte-identical to input after failure
[PASS] non_unique_no_replacement_leaked
[PASS] non_unique_original_immutable
[PASS] non_unique_raises_typed_error
[PASS] no_match_clean_refusal
CONTRACT SATISFIED: exact edit applied once; non-unique edit refused with no mutation
```

### Counterfactual (why the guard is required)

Re-running the non-unique scenario against the pre-fix body (guard disabled)
produces `refused=False` and **2** `compute(2)` substitutions — i.e. both
sibling blocks are mutated. The guard is what converts silent
over-application into a typed, atomic refusal.

## Recorded validation limitation

The runtime environment for this fixture does not have the optional
`diff_match_patch`, `GitPython`, or `oslex` packages installed, and the task
forbids installing dependencies. `aider/coders/search_replace.py` imports
`diff_match_patch` at module scope, and importing the package path would
trigger `aider/coders/__init__.py` (which pulls every coder). The fixture
therefore loads the module by file path and installs minimal in-memory stubs
for `diff_match_patch` and the unused `aider.dump` / `aider.utils` symbols.
The functions under test never touch those stubs. The full repository test
suite (e.g. `pytest tests/basic/test_udiff.py`) could not be executed for the
same reason; the focused fixture above is the executed validation.
