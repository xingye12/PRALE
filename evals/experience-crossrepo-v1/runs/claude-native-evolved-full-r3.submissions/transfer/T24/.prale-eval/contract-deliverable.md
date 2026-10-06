# T24 — Contract: explicit unknown-model handling in `aider.models`

Repository: `aider` · Mode: `contract` · Task id: `T24`

## Contract statement

Given a **local model metadata fixture** registered through the public
`register_litellm_models()` entry point, a model name that is *unknown
everywhere* (not shipped in `aider/resources/model-metadata.json`, not declared
in the local fixture, and not known to litellm) must be handled **explicitly**:

1. **No fabricated metadata.** `ModelInfoManager.get_model_from_cached_json_db()`
   and `ModelInfoManager.get_model_info()` must return `{}` for the unknown
   name, never invented context-window / cost / provider values.
2. **Explicit warning.** `sanity_check_model()` must report the problem
   (`return True`) and emit
   `"Unknown context window size and costs, using sane defaults."` instead of
   silently proceeding with guessed limits.
3. **No silent capability claims.** `Model.accepts_settings` must not contain
   any capability the model has not been shown to support
   (`thinking_tokens`, `reasoning_effort`). Aider's capability list is derived
   only from built-in name heuristics / `MODEL_SETTINGS`; unregistered local
   metadata contributes model facts (context/cost), not capability opt-ins, so
   an unmatched unknown model gets an empty list.
4. **Exact registration.** Registering the fixture must register *only* its
   declared model names — no provider-wide or fuzzy registration — and an
   unregistered sibling name must remain unknown.

The check is non-vacuous: a model whose name *is* known to support reasoning
(`gpt-5.5`) does declare `reasoning_effort`, proving the assertion in (3) is
not trivially true because the field is always empty.

## Executable demo

`demo_unknown_model_contract.py` — run from the repository root:

```
python .prale-eval/demo_unknown_model_contract.py
```

It is self-contained: it registers the fixture below, drives the real
`aider.models` code paths, prints one `PASS`/`FAIL` line per contract clause,
and exits non-zero on any failure. It also emits a JSON summary
(`checks_passed` / `checks_total` / `passed` / `results`).

The demo is hermetic: `HOME` is redirected to a temporary directory inside the
workspace and the shared `model_info_manager` cache hooks are neutralised, so
no network access and no writes outside the workspace occur.

### Different local model metadata fixture

`.prale-eval/fixtures/local-model-metadata.json` — a local metadata fixture
distinct from the shipped `aider/resources/model-metadata.json`; it declares a
single locally-served chat model:

```json
{
    "local/demo-chat-model": {
        "max_tokens": 2048,
        "max_input_tokens": 4096,
        "max_output_tokens": 2048,
        "input_cost_per_token": 0.0,
        "output_cost_per_token": 0.0,
        "litellm_provider": "local",
        "mode": "chat"
    }
}
```

## Normalized operation result

| Check | Expectation | Observed |
| --- | --- | --- |
| `fixture_registered_exactly` | only fixture keys registered | `['local/demo-chat-model']` |
| `known_model_metadata_is_explicit` | fixture model resolves to fixture facts | `max_input_tokens=4096` |
| `unknown_model_metadata_is_empty` | `lookup == {}`, `info == {}`, `model.info == {}` | `{}` / `{}` / `{}` |
| `unknown_model_claims_no_fabricated_metadata` | no context/cost/provider keys | none present |
| `unknown_model_warned_explicitly` | `True` + "Unknown context window size and costs, using sane defaults." | warning emitted |
| `unknown_model_claims_no_capabilities` | `accepts_settings == []` | `[]` |
| `capability_claim_check_is_non_vacuous` | a known reasoning model does claim it | `gpt-5.5 -> ['reasoning_effort']` |
| `unregistered_sibling_stays_unknown` | `local/model-not-in-fixture -> {}` | `{}` |
| `unknown_model_not_self_matched` | unknown name not echoed as a known match | `matches=[]` |

**Result: 9/9 checks passed (exit status 0).**

## Source map (see `result.json` `evidence`)

- `ModelInfoManager.get_model_from_cached_json_db` (`aider/models.py:223`)
  — exact-match lookup over local metadata then the cached litellm DB; returns
  `dict()` when nothing matches (explicit unknown, no fabrication).
- `ModelInfoManager.get_model_info` (`aider/models.py:249`) — falls back to
  litellm, then OpenRouter, and finally returns the empty cached info.
- `Model.__init__` (`aider/models.py:330`) — assigns `self.info` from the
  lookup and derives `max_chat_history_tokens` from it (defaults when empty).
- `Model.configure_model_settings` / `apply_generic_model_settings`
  (`aider/models.py:385`, `437`) — only name-heuristic / `MODEL_SETTINGS`
  matches append to `accepts_settings`; no match leaves it empty.
- `register_litellm_models` (`aider/models.py:1112`) — loads the local fixture
  into `model_info_manager.local_model_metadata` with exact-name granularity.
- `sanity_check_model` (`aider/models.py:1164`) — raises the explicit
  unknown-model / unknown-env warning and returns a problem flag.
- `fuzzy_match_models` (`aider/models.py:1227`) — suggests alternatives; an
  unknown name is not returned as a known model.

## Validation

Command: `python .prale-eval/demo_unknown_model_contract.py` — status
**passed** (9/9, exit 0).

Limitation: `litellm`, `json5` and `oslex` are not installed in this
environment. The demo installs minimal in-process stand-ins for them at run
time (only the attributes `aider.models`/`aider.llm` touch). All aider logic
exercised by the contract — fixture registration, metadata lookup, capability
configuration, warning emission and fuzzy matching — is the repository's real
code; the stand-ins only replace the absent third-party provider client. No
dependency was installed and no file outside the workspace was read or written.
