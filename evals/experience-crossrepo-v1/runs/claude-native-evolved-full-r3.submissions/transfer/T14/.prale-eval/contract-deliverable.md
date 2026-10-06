# T14 — Contract: distinct newline/whitespace edit fixture

Repository: `aider` · Mode: `contract`

## Scope

An executable contract for applying a distinct (exact) newline/whitespace search/replace
edit to source text through `aider/coders/search_replace.py`. The fixture asserts two
outcomes:

* an **exact, unique** edit succeeds **exactly once**, byte-for-byte as specified;
* a **non-unique** edit **fails without partial mutation** — no occurrence is rewritten
  and the original bytes are untouched.

## Contract clauses

| id | clause | normal form |
|----|--------|-------------|
| C1 | unique exact edit succeeds once | `count(search, original) == 1` ⟹ result `== original.replace(search, replace)`, `result.count(replace) == 1`, `result.count(search) == 0` |
| C2 | no-match fails closed | `count(search, original) == 0` ⟹ result `is None`, `original` unchanged |
| C3 | non-unique fails without partial mutation | `count(search, original) > 1` ⟹ operation fails (`SearchTextNotUnique`), `original` byte-for-byte unchanged, `result.count(replace) == 0` |

The newline/whitespace of `search_text` is significant: matching is an exact substring
test, so a trailing-space or newline variant is a distinct key (exercised as C2).

## Where the behavior lives (`aider/coders/search_replace.py`)

* `search_and_replace` (434–445) computes `num = original_text.count(search_text)`;
  `num == 0` returns `None` (fail closed, C2), otherwise it returns
  `original_text.replace(search_text, replace_text)`.
* The uniqueness guard `if num > 1: raise SearchTextNotUnique()` is **commented out**
  (437–439) in this revision, so the raw primitive rewrites *all* occurrences. C3 is
  therefore enforced at the call boundary.
* `SearchTextNotUnique` (524–525) is the module's reserved sentinel for the ambiguous
  (non-unique) condition.
* `flexible_search_and_replace` (565–577) returns the first **truthy** strategy result
  and otherwise `None`, so a refused/failed edit produces no replacement text.
* `try_strategy` (586–608) applies the preprocessors (`strip_blank_lines`,
  relative-indent, reversal) that reconcile newline/whitespace divergence; it returns
  `None` on failure rather than mutating in place.
* Supplementary (call boundary): `udiff_coder.directly_apply_hunk` (261–279) refuses a
  repeated tiny search — `if len(before_lines) < 10 and content.count(before) > 1: return`
  (271) — and catches `SearchTextNotUnique` (276); `apply_partial_hunk` only commits when
  every hunk succeeds. That is the atomicity guarantee behind clause C3.

## Deliverable: executable demo

``.prale-eval/contract_demo.py`` loads the **real** `aider/coders/search_replace.py`
(via `importlib`, bypassing `aider.coders.__init__`) and runs the contract wrapper
`contract_apply`, which uses the module's own `SearchTextNotUnique` sentinel for the
count>1 case and the module's real `search_and_replace` for the substitution.

```bash
python3 .prale-eval/contract_demo.py
```

Fixture (one small Python-ish text with two functions):

| case | search | count | expected status |
|------|--------|-------|-----------------|
| `unique_exact_edit` | `def sub(a, b):\n    total = a - b\n    return total\n` | 1 | success, applied once, byte-exact |
| `non_unique_edit` | `    return total\n` | 2 | fail (`SearchTextNotUnique`), original untouched |
| `no_match_whitespace_variant` | `    return total \n` (trailing space) | 0 | fail closed, original untouched |

The demo also records a **contrast** observation: the raw primitive (without the wrapper)
replaced **2** occurrences on the non-unique input, confirming why C3 must be enforced at
the call boundary in this revision.

## Normalized operation result

The demo writes `.prale-eval/contract-result.json`:

```json
{
  "task_id": "T14",
  "repository": "aider",
  "mode": "contract",
  "clauses": ["C1 unique succeeds once", "C2 no-match fails closed", "C3 non-unique fails atomically"],
  "cases": [ /* three normalized case records, each with status + assertions */ ],
  "contrast": { "raw_occurrences_replaced": 2 },
  "all_passed": true
}
```

Each case record carries the normalized fields `status` (`success`/`fail`), `applied`,
`original_unchanged`, `result`, `error`, and an `assertions` map. `all_passed` is `true`
only if every clause holds. Observed run: all clauses PASS, exit code 0.

## Validation

Command: `python3 .prale-eval/contract_demo.py` — **pass** (exit 0).

Limitation: `diff_match_patch` and `oslex` are not installed in this environment. The demo
injects minimal import-time stubs for them solely so the real module can be imported; the
contract path (`search_and_replace` / `flexible_search_and_replace` / `try_strategy`) never
calls the diff-match-patch strategies, so the stubs are not exercised. This limitation is
recorded in `result.json` and in `contract-result.json`.
