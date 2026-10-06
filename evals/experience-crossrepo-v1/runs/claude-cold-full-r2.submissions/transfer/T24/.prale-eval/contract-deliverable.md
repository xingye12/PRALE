# Contract deliverable — unknown model handling in `aider/models.py`

Task `T24` · repository `aider` · mode `contract`

## Contract statement

> For a local model metadata fixture, unknown model handling is **explicit** and does
> **not silently claim unsupported capabilities**.

Concretely, when a model name is not described by the loaded local metadata fixture
and is unknown to the upstream litellm model database, aider must:

1. resolve its metadata to an empty result — never invent a context window, cost, or
   capability flag from a sibling entry or a default;
2. leave capability lookups absent in `Model.info`, falling back only to documented,
   clearly-labelled defaults (e.g. the 1024-token history floor);
3. report the situation to the user explicitly (a warning plus fuzzy-match
   suggestions), so the unknown state is surfaced rather than silently accepted.

## Executable demo

`.prale-eval/contract_unknown_model.py` — run from the workspace root:

```
python .prale-eval/contract_unknown_model.py
```

It wrote the fixture to a temp file and loaded it through the public entry point
`aider.models.register_litellm_models` (the `--model-metadata-file` path). The fixture
is a *different* local model metadata set from any pre-existing one: it fully describes
`local/fixture-listed` (context window, costs, provider, chat mode) and deliberately
contains **no entry** for `local/fixture-unlisted`.

### Clauses and observed results

| Clause | Assertion | Result |
| --- | --- | --- |
| C0 | fixture file is loaded by `register_litellm_models` | PASS |
| C1 | the described model resolves to the fixture's `max_input_tokens` (32768) | PASS |
| C1b | control: described model has non-empty info, `input_cost_per_token == 5e-07`, `max_chat_history_tokens == 2048` | PASS |
| C2a | `get_model_from_cached_json_db("local/fixture-unlisted") == {}` | PASS |
| C2b | `get_model_info("local/fixture-unlisted") == {}` | PASS |
| C2c | no context-window / cost / `supports_*` keys are claimed for the unlisted model | PASS |
| C3a | `Model(...).info == {}` for the unlisted model | PASS |
| C3b | `info.get("max_input_tokens")` yields no claimed value | PASS |
| C3c | `max_chat_history_tokens == 1024` (documented safe floor, not a fabricated capability) | PASS |
| C4a | `sanity_check_model` returns `True` for the unlisted model | PASS |
| C4b | explicit warning `"Warning for local/fixture-unlisted: Unknown context window size and costs, using sane defaults."` is emitted, plus `"Unknown which environment variables are required."` | PASS |
| C4c | control: the described model does **not** raise the unknown-costs warning | PASS |

**12/12 clauses pass; exit code 0.**

## Normalized operation result

```
metadata fixture (local/fixture-listed only)
        │  register_litellm_models(fixture)
        ▼
ModelInfoManager.local_model_metadata = {"local/fixture-listed": {...}}

lookup "local/fixture-listed"   -> {"max_input_tokens": 32768, ...}   (explicit)
lookup "local/fixture-unlisted" -> {}                                 (explicit unknown)

Model("local/fixture-unlisted").info == {}
  .info.get("max_input_tokens") -> None      (no capability claimed)
  .max_chat_history_tokens      -> 1024      (documented default)

sanity_check_model(io, model) -> True
  tool_warning("... Unknown context window size and costs, using sane defaults.")
```

## Contract surface (non-negotiable behaviours)

| Behaviour | Source |
| --- | --- |
| miss paths return a literal `{}` | `aider/models.py:223-247` (`get_model_from_cached_json_db`) |
| unknown-model errors from litellm are swallowed into `{}`, not into data | `aider/models.py:249-274` (`get_model_info`) |
| `self.info` keeps the empty dict; history tokens fall back to 1024 | `aider/models.py:348-358` (`Model.__init__`) |
| unknown model is reported explicitly (`show = True` + warning + suggestions) | `aider/models.py:1164-1200` (`sanity_check_model`) |
| a fixture only contributes names it literally contains | `aider/models.py:1112-1133` (`register_litellm_models`) |
| environment requirements are reported as an explicit `missing_keys` list | `aider/models.py:1136-1143` (`validate_variables`) |

## Environment limitation

The optional runtime dependencies `litellm`, `json5`, and `oslex` are **not installed**
in this environment and were not installed (task constraint: do not install
dependencies). Consequently the repository's own `tests/basic/test_models.py` cannot be
collected (`ModuleNotFoundError: No module named 'json5'`) — the same missing-module
failure reproduces at the top of `aider/models.py` itself.

To keep the contract executable without installing anything, the demo installs minimal
in-process shims *before* importing `aider.models`:

- `json5` → stdlib `json.loads` (the fixture is plain JSON, a strict JSON5 subset);
- `litellm` → an empty-knowledge module: `model_cost = {}`, `get_model_info` raises for
  any model, `validate_environment` returns `{"keys_in_environment": False,
  "missing_keys": []}` — i.e. exactly the "no knowledge of this model" condition the
  contract is about;
- `oslex` → `shlex.join` (used by `aider/utils.py` only for shell quoting).

If the real packages are importable, the demo uses them instead and prints which backend
each shim resolved to. `aider/models.py` itself is never modified or monkey-patched;
only third-party knowledge sources are substituted, and the shimmed behaviour agrees
with the repository's own expectation in `tests/basic/test_models.py:28-31`
(`test_get_model_info_nonexistent` asserts `get_model_info(...) == {}`).
