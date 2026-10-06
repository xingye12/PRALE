# Contract deliverable — explicit unknown-model handling (aider)

- **task_id**: `T24`
- **repository**: `aider`
- **mode**: `contract`
- **contract**: unknown model handling in `aider/models.py` is explicit and never
  silently claims unsupported capabilities.
- **fixture**: `.prale-eval/contract/local-model-metadata.json` (a local model
  metadata file in the shape consumed by `--model-metadata-file` /
  `.aider.model.metadata.json`).
- **executable contract**: `.prale-eval/contract/check_unknown_model_contract.py`
- **normalized operation result**: `.prale-eval/contract/contract-report.json`
- **status**: `pass` (7/7 assertions) via
  `python .prale-eval/contract/check_unknown_model_contract.py`

## 1. The fixture (a *different* local model metadata fixture)

```json
{
    "meta/aurora-1-mini": {
        "max_input_tokens": 1234, "litellm_provider": "meta", "mode": "chat"
    },
    "meta/aurora-1-pro": {
        "max_input_tokens": 32000, "max_output_tokens": 4000,
        "litellm_provider": "meta", "mode": "chat",
        "supports_function_calling": false
    }
}
```

`meta/aurora-1-mini` deliberately declares *partial* metadata (no cost keys, no
capability flags). `meta/aurora-1-pro` deliberately declares an *explicit denial*
(`supports_function_calling: false`). `meta/ghost-404` is declared nowhere at all.

## 2. The contract, executed against the real code

The check script imports the repository's `aider.models` module, registers the
fixture through the public entry point `models.register_litellm_models([...])`
(the same function `aider.main.register_litellm_models` calls), and then exercises
lookup, `Model` construction and `sanity_check_model`. Each assertion produces a
normalized record `{id, status, expectation, observed}`:

| id | contract assertion | observed (normalized) | status |
|----|--------------------|-----------------------|--------|
| C1 | `register_litellm_models` stores fixture entries *verbatim* | `files_loaded == [fixture]`; registered exactly `meta/aurora-1-mini`, `meta/aurora-1-pro`; `fixture_entries_augmented == []` | pass |
| C2 | undeclared model ⇒ metadata is an explicit empty mapping | `meta/ghost-404 → {}` (`dict`) | pass |
| C3 | no silent basename/prefix inheritance | `aurora-1-mini → {}` (prefix stripping only when the entry's `litellm_provider` equals the prefix) | pass |
| C4 | unknown model is reported *explicitly* | `Model("meta/ghost-404").info == {}`; `sanity_check_model` returned `True`; warnings: `"Unknown which environment variables are required."`, `"Unknown context window size and costs, using sane defaults."` | pass |
| C5 | unknown model gets sane defaults and claims nothing | `max_chat_history_tokens == 1024`, `get_repo_map_tokens() == 1024`, `accepts_settings == []`, `extra_params is None` | pass |
| C6 | partial fixture entry surfaces exactly as declared | looked-up keys `{max_input_tokens: 1234, litellm_provider: "meta", mode: "chat"}`; `invented_keys == []`; `supports_function_calling` and `input_cost_per_token` **absent** | pass |
| C7 | explicit `false` capability is preserved, not upgraded | `info["supports_function_calling"] is False`; `Model(...).accepts_settings == []` (metadata never enables `thinking_tokens`/`reasoning_effort`) | pass |

Failure semantics: the script exits `1` and the report's top-level `status`
becomes `fail` if any assertion fails; the script prints one
`[PASS]`/`[FAIL] <id>` line per assertion.

## 3. Contract clauses (the normative reading)

1. **Absence is explicit.** A model with no entry in any registered metadata
   source resolves to `{}` — never to a synthesized cost/context/capability set.
2. **Never claim support silently.** Missing keys stay missing
   (`supports_function_calling`, `supports_tool_choice`, `input_cost_per_token`,
   …). An explicit `false` stays `false`; only an explicit `true` asserts support.
   Metadata never turns on optional request settings (`accepts_settings` stays `[]`).
3. **Unknown models are announced.** `sanity_check_model` returns a truthy
   "problem" flag and emits the two `Unknown …` warnings, so callers can tell the
   difference between "known defaults" and "we do not know this model".
4. **Defaults are documented constants, not inferences.** `max_chat_history_tokens`
   and `get_repo_map_tokens()` fall back to the 1024-token sane default when
   `info` has no `max_input_tokens`.
5. **Registration is verbatim.** `register_litellm_models` only merges declared
   dictionaries into `model_info_manager.local_model_metadata`; it does not
   enrich or normalize capability keys.
6. **Hermetic operation.** `HOME` is redirected to
   `.prale-eval/contract/_home` (aider's metadata cache lives under
   `$HOME/.aider/caches`) and outbound HTTP is disabled, so the contract touches
   no network and writes only inside the workspace.

## 4. Source citations (repository-relative)

| file | symbol | lines | role in the contract |
|------|--------|-------|----------------------|
| `aider/models.py` | `ModelInfoManager.get_model_from_cached_json_db` | 223–247 | returns `dict()` for unknown models; prefix fallback guarded by `litellm_provider` |
| `aider/models.py` | `ModelInfoManager.get_model_info` | 249–274 | returns `cached_info` (possibly `{}`) and never fabricates keys for unknown models |
| `aider/models.py` | `Model.__init__` | 330–369 | `self.info = self.get_model_info(model)`; `max_input_tokens or 0` ⇒ 1024-token history default |
| `aider/models.py` | `Model.configure_model_settings` | 385–435 | `accepts_settings` defaults to `[]`; optional settings only via explicit settings/name rules |
| `aider/models.py` | `Model.get_repo_map_tokens` | 782–789 | documented 1024-token default when context window is unknown |
| `aider/models.py` | `register_litellm_models` | 1112–1133 | public registration entry point; merges fixture data verbatim |
| `aider/models.py` | `sanity_check_model` | 1164–1200 | explicit `Unknown …` warnings and truthy return for unknown models |

## 5. Limitation of this run (optional validation dependency unavailable)

`litellm`, `json5` and `oslex` are not installed in this environment
(`pip install` / dependency installation is out of scope), so the harness
installs narrow in-process shims before importing `aider.models`:

- `litellm` — stub reproducing the behaviour the contract depends on:
  `get_model_info` raises with the `model_prices_and_context_window.json`
  message for unmapped models (the error `aider/models.py` catches and ignores),
  `validate_environment` returns `{"keys_in_environment": False, "missing_keys": []}`,
  `model_cost = {}`. Real litellm completions/encodings are never exercised.
- `json5` — shim parsing strict JSON plus `//` line comments (the subset used by
  aider metadata files).
- `oslex` — `shlex`-based `join`/`split` shim; `aider.utils` only uses
  `oslex.join` for shell escaping, which this contract does not call.

These limitations are recorded verbatim in
`.prale-eval/contract/contract-report.json` under `environment.limitations`, and
the generic environment facts (`http_disabled: true`, `litellm_stubbed: true`)
are recorded alongside them. Everything asserted about `aider/models.py` is real
repository code; only the third-party boundary is simulated.

## 6. Reproducing

```bash
python .prale-eval/contract/check_unknown_model_contract.py   # exit 0, status pass
```

Run from the repository root (the script also resolves the root itself from its
own path). The command rewrites `.prale-eval/contract/contract-report.json`.
