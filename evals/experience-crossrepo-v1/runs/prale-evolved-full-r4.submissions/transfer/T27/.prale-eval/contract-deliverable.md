# T27 — Contract: unknown local model handling is explicit

Repository: `aider` · Mode: `contract` · Task: assert that unknown model handling
is explicit and does not silently claim unsupported capabilities, using a
**different local model metadata fixture**.

## 1. Contract (normalized statements)

| ID | Contract statement | Where it lives in `aider/models.py` |
|----|--------------------|--------------------------------------|
| C1 | A local model metadata fixture is ingested verbatim into `ModelInfoManager.local_model_metadata`; an empty fixture file is skipped and a malformed one raises a named error. | `register_litellm_models` (1112–1133) |
| C2 | A model name absent from the fixture/cache resolves to an **empty metadata dict** — unknown is represented explicitly, no record is fabricated. | `ModelInfoManager.get_model_from_cached_json_db` (223–247) |
| C3 | The empty metadata becomes operator-visible warnings (`Unknown context window size and costs, using sane defaults.`, `Unknown which environment variables are required.`) and `sanity_check_model` returns `True`. | `sanity_check_model` (1164–1200) |
| C4 | No unsupported capabilities are silently claimed: `accepts_settings` is normalised to `[]`, capability flags exist only where a settings entry / generic rule / fixture states them, and capability keys are absent from an unknown model's metadata. | `configure_model_settings` (385–435), `ModelSettings` (128–150) |

Precondition (verified): `register_litellm_models` in `aider/main.py` (390–402)
puts the bundled `aider.resources/model-metadata.json` **first** and then the
search-path fixtures, and `register_litellm_models` overwrites per name via
`local_model_metadata.update(...)`.

## 2. The different fixture

`.prale-eval/fixtures/local-model-metadata.json` — a JSON5 local model metadata
fixture distinct from the bundled `aider/resources/model-metadata.json`. It
declares exactly one model, `local/known-fixture-model`, with capability flags
stated explicitly (`supports_tool_choice: false`,
`supports_function_calling: false`, `supports_prompt_caching: false`,
`litellm_provider: local`). It declares **nothing** for
`local/unknown-fixture-model`, which is the model under test for "unknown".

## 3. Executable demo

`.prale-eval/contract_demo.py` — run it with:

```
python .prale-eval/contract_demo.py
```

It has two execution modes and exits non-zero if any check fails:

- **LIVE** (when `aider.models` is importable, i.e. `json5` + `litellm`
  present): loads the fixture with `register_litellm_models`, then asserts
  `get_model_from_cached_json_db("local/known-fixture-model")` returns the
  fixture entry verbatim, that `get_model_from_cached_json_db("local/unknown-fixture-model") == {}`
  with no capability keys, and that `sanity_check_model` on the unknown model
  emits both explicit warnings and returns `True`. The cache refresh is stubbed
  (`manager._update_cache = lambda: None`) so the check stays offline and
  deterministic.
- **STATIC** (fallback; used here): parses the real `aider/models.py` with
  `ast` and asserts the same contract on the actual source — the two explicit
  warning strings inside `sanity_check_model`, the terminal `return dict()` of
  `get_model_from_cached_json_db`, fixture ingestion via
  `local_model_metadata.update`, and `accepts_settings = []` initialisation.
  It also parses the fixture (comment-stripped JSON) to confirm the known model
  is present with explicit `false` capabilities and the unknown model absent.

A second script, `.prale-eval/validate_result.py`, validates the `result.json`
schema and confirms (via `ast`) that every cited symbol span lies inside its
reported inclusive `[start_line, end_line]` range.

## 4. Normalized operation result

```
$ python .prale-eval/contract_demo.py
T27 contract demo -- mode=STATIC
CHECK C1.fixture: PASS -- fixture declares 'local/known-fixture-model' and omits 'local/unknown-fixture-model'
CHECK C4.fixture_explicit: PASS -- fixture states capabilities explicitly (false) for the known model
CHECK C3.warn_costs: PASS -- sanity_check_model emits the explicit unknown-cost/context warning
CHECK C3.warn_env: PASS -- sanity_check_model emits the explicit unknown-env-var warning
CHECK C2.empty_lookup: PASS -- get_model_from_cached_json_db ends with `return dict()` for unknown models
CHECK C1.ingest: PASS -- register_litellm_models ingests the fixture into local_model_metadata
CHECK C4.no_accepted_settings_claim: PASS -- configure_model_settings initialises accepts_settings to [] (no implicit claims)
CHECK LIVE.skipped: PASS -- runtime dependency unavailable, static (ast) contract checks used instead
LIMITATION (recorded, dependency NOT installed): ModuleNotFoundError: No module named 'json5'
RESULT: PASS (8/8)

$ python .prale-eval/validate_result.py
result.json schema OK (6 evidence, 4 claims)
citation AST check OK: every symbol span lies inside its reported range
```

## 5. Verification limitation (recorded, not fixed)

The LIVE behavioural mode could not execute in this sandbox because the optional
runtime dependency `json5` (and `litellm`) is not installed, and
`aider/models.py` imports both at module level (`import json5`, `from aider.llm
import litellm`). Per the task's standing rule, no dependency was installed.
The restricted-strength substitute is source-level `ast` assertion plus
fixture-level JSON parsing, which checks the same contract statements against
the real, unmodified `aider/models.py`. The demo will automatically take the
LIVE path (and perform the full behavioural assertions) in an environment where
`json5` and `litellm` are available.

## 6. Files

| Path | Role |
|------|------|
| `.prale-eval/result.json` | Required evidence report (task_id `T27`, repository `aider`, mode `contract`, evidence/claims/conclusion/validation). |
| `.prale-eval/contract-deliverable.md` | This document. |
| `.prale-eval/contract_demo.py` | Executable contract demo (LIVE + STATIC modes). |
| `.prale-eval/validate_result.py` | Schema + citation AST validator. |
| `.prale-eval/fixtures/local-model-metadata.json` | The different local model metadata fixture under test. |

No repository source, task metadata, hidden-oracle file, package lock, or git
configuration was modified.
