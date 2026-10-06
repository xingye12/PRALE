# T14 contract deliverable — distinct newline/whitespace edit fixture (repository `aider`)

## 1. Deliverable

An executable, self-contained contract demo plus its fixture:

| Artifact | Role |
| --- | --- |
| `.prale-eval/demo_search_replace_contract.py` | Executable demo; runs the contract checks against the unmodified repository code and exits 0 iff the contract holds. |
| `.prale-eval/fixtures/*.txt` | The distinct newline/whitespace edit fixture (original, unique search/replace, whitespace-blind search, non-unique search/replace). |
| `.prale-eval/validation-log.txt` | Captured output of both demo runs (human-readable and `--json`). |
| `.prale-eval/result.json` | Machine-readable contract result (evidence, claims, conclusion, validation). |

Run from the repository root:

```
python .prale-eval/demo_search_replace_contract.py        # human readable
python .prale-eval/demo_search_replace_contract.py --json # machine readable
```

## 2. Contract

**Subject of the edit.** `original.txt` holds two near-twin blocks:

```
def first():
    paint()   <- trailing spaces
    return 1


def second():
    paint()
    return 1
```

The two blocks are textually identical except for (a) the trailing spaces after
`paint()` in the first block and (b) the blank-line/newline layout that separates
them. The block boundaries themselves are whitespace: the same logical edit
differs in uniqueness purely because of newline/space detail.

**C1 — an exact edit succeeds exactly once.**

* The unique search text `def first():\n    paint()   \n    return 1\n` occurs
  exactly once in `original.txt`; `search_and_replace` is expected to return the
  text with that single substitution applied and the sibling block untouched
  (verified by equality with `original.replace(search, replace, 1)`).
* The same edit routed through the coder's real caller entry point
  `udiff_coder.directly_apply_hunk(content, hunk)` must produce the identical
  result — matching what `udiff_coder.Coder.apply_edits` would write.
* Whitespace distinctness is load-bearing: the whitespace-blind search text
  (identical but without the trailing spaces) occurs **0** times, so the edit is
  refused (`search_and_replace` returns `None`) instead of being silently applied
  to the twin.

**C2 — a non-unique edit fails without partial mutation.**

* The search text `    return 1\n` occurs **2** times. Its non-whitespace context
  is 8 characters (`return 1`), which is under the guard's 10-character
  threshold.
* `udiff_coder.directly_apply_hunk` must refuse the hunk: it returns `None`
  (falsy), and it also maps `SearchTextNotUnique` to `None`.
* No partial mutation: `udiff_coder.Coder.apply_edits` writes the file only on
  the SUCCESS branch (`self.io.write_text(...)`), so a refused hunk leaves the
  target byte-for-byte unchanged. The demo simulates this write rule on a
  temporary copy and asserts the bytes are unchanged.

**Failure signal.** `aider.coders.search_replace.SearchTextNotUnique` is a
`ValueError` subclass and remains the module's designated ambiguity signal; the
demo asserts that invariant so `udiff_coder` can keep translating it into the
`UnifiedDiffNotUnique` message.

## 3. Where the behaviour lives (evidence)

Checked against the repository sources:

| Location | Behaviour used by the contract |
| --- | --- |
| `aider/coders/search_replace.py:434-445` — `search_and_replace` | Counts occurrences (l. 437) and returns `original.replace(search, replace)`; returns `None` on 0 matches. The `if num > 1: raise SearchTextNotUnique()` guard is commented out (l. 438-439), so uniqueness is the caller's responsibility. |
| `aider/coders/search_replace.py:524-525` — `SearchTextNotUnique` | The `ValueError` subclass used as the ambiguity failure signal (imported by `udiff_coder`). |
| `aider/coders/search_replace.py:565-577` — `flexible_search_and_replace` | Returns the first truthy strategy result; the exact-match strategy runs first (via `all_preprocs`, l. 528-538 and `try_strategy`, l. 586-608). |
| `aider/coders/search_replace.py:611-614` — `strip_blank_lines` | Normalises only outer blank lines, so interior trailing whitespace stays significant — the fixture's distinguisher survives the flexible path. |
| `aider/coders/udiff_coder.py:261-279` — `directly_apply_hunk` | The refusal guard: `< 10` non-whitespace characters **and** `content.count(before) > 1` → return `None` (l. 270); `SearchTextNotUnique` → `None` (l. 275-278). |
| `aider/coders/udiff_coder.py:69-118` — `apply_edits` | Writes only truthy content (`self.io.write_text`, l. 112); errors/`continue` on not-unique (l. 95) or no-match (l. 103) → no partial mutation. |

## 4. Normalized operation result

`python .prale-eval/demo_search_replace_contract.py` → exit code **0**,
`contract_satisfied: true`, 7/7 checks PASS:

| Check | Result |
| --- | --- |
| `fixture_unique_search_occurs_once` (1 unique / 2 non-unique occurrences) | PASS |
| `C1_search_and_replace_unique_applied_once` | PASS |
| `C1_directly_apply_hunk_unique_succeeds_once` | PASS |
| `exact_match_is_whitespace_sensitive` (whitespace-blind search → `None`) | PASS |
| `C2_nonunique_edit_refused_without_partial_mutation` (returns `None`, file bytes unchanged) | PASS |
| `observed_hazard_raw_nonunique_call_replaces_all_occurrences` (documented limitation) | PASS |
| `failure_signal_type_is_documented_exception` | PASS |

## 5. Limitations (recorded, not hidden)

1. **Missing optional dependencies.** `diff_match_patch` and `GitPython` are not
   installed and `import oslex` fails, so `aider/coders/search_replace.py` and
   `aider/coders/udiff_coder.py` cannot be imported as-is. The demo installs
   in-memory stand-in modules for those imports (plus the heavy `aider` /
   `aider.coders` package `__init__` files) and then imports the **unmodified**
   repository sources, asserting `sr.__file__` / `uc.__file__` point at the real
   files. The exact-match path and the refusal guard — the entire subject of this
   contract — use none of the missing packages. No dependency was installed.
2. **Rate of application for a raw non-unique call.** Because the raise inside
   `search_and_replace` is commented out, a raw non-unique
   `search_and_replace` call rewrites *all* occurrences (the demo records this as
   `observed_hazard_raw_nonunique_call_replaces_all_occurrences`). The contract's
   "fail without mutation" guarantee therefore comes from the caller-level guard
   `udiff_coder.directly_apply_hunk`, which is the path exercised by the demo.
   For non-unique hunks with a **long** non-whitespace context the `< 10` guard
   does not trigger; that case is outside this fixture (its context is 8
   characters) and is not claimed.
3. **Fuzzy strategies not exercised.** `dmp_apply` / `dmp_lines_apply` and the
   git-cherry-pick strategies require the missing packages and are out of scope
   for the exact/non-unique contract.
