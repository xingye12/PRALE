# Demo deliverable — model-info lookup path with local fixture/cache and fallback

- **Repository:** `aider`
- **Task:** learn/10, mode `demo`
- **Executable demo:** `.prale-eval/demo_model_info_lookup.py`
- **Run:** `python .prale-eval/demo_model_info_lookup.py` (exit `0` = contract holds)

## What is demonstrated

The demo drives the real `aider.models.ModelInfoManager` from this checkout along
its three-stage lookup/failure path:

1. **Local fixture metadata** — a JSON fixture file is registered through the
   real `register_litellm_models()` (`aider/models.py:1112`), which populates
   `model_info_manager.local_model_metadata`. `get_model_from_cached_json_db()`
   (`aider/models.py:223`) checks this dict *first*, so the fixture model
   `fixture/learn-10-model` resolves to its fixture metadata.
2. **On-disk cache fixture** — a fresh `ModelInfoManager` with `cache_file` pointed
   at a local
   `model_prices_and_context_window.json` fixture. `_load_cache()` (`aider/models.py:184`)
   reads it (within the 24 h `CACHE_TTL`) and `get_model_from_cached_json_db()`
   returns the fixture metadata without any network access.
3. **Unavailable-metadata fallback** — an unknown model
   (`definitely-not-a-real-model-xyzzy`) is absent from both the local metadata and
   the fixture cache. `get_model_info()` (`aider/models.py:249`) tries the deferred
   litellm lookup (which raises for an unmapped model), skips the OpenRouter branch
   (the name is not `openrouter/…`), and returns the empty `cached_info` — i.e.
   `{}` — instead of raising. This is exactly the contract pinned by
   `tests/basic/test_models.py:28` (`test_get_model_info_nonexistent`).

`Model.get_model_info()` (`aider/models.py:371`) is the thin delegation point that
routes construction-time lookups into this same singleton manager.

## Contract / normalized operation result

Lookup precedence implemented by `ModelInfoManager.get_model_info(model)`:

```
local_model_metadata[model]                     # register_litellm_models fixture
  -> cached JSON DB content[model]              # disk cache, with provider-qualified
                                                #   "provider/name" second attempt
  -> litellm.get_model_info(model)              # deferred runtime DB (may raise)
  -> openrouter manager / web scrape            # only for "openrouter/" models
  -> cached_info                                # final fallback, {} when nothing found
```

Normalized result of a run (JSON emitted to stdout):

```json
{
  "operation": "model_info_lookup",
  "repository": "aider",
  "source_file": "aider/models.py",
  "steps": [
    {"step": "local_fixture_metadata",       "model": "fixture/learn-10-model",              "source": "local_model_metadata",     "ok": true},
    {"step": "disk_cache_fixture",           "model": "fixture/learn-10-model",              "source": "_load_cache -> content",   "ok": true},
    {"step": "unavailable_metadata_fallback","model": "definitely-not-a-real-model-xyzzy",   "info": {}, "returns_empty_dict": true, "ok": true}
  ],
  "all_ok": true
}
```

## Dependency note

The sandbox does not have the runtime third-party dependencies `litellm`, `json5`,
or `oslex` installed, and installation is out of scope. The demo therefore installs
inert stand-in modules for exactly those three imports so the *real* `aider.models`
module can be imported; no lookup logic is replaced. The fallback test
`tests/basic/test_models.py::TestModels::test_get_model_info_nonexistent` was also
executed against the real test module using the same stubs on `PYTHONPATH`
(`HOME` redirected to a workspace-local temp dir so `~/.aider/caches` writes stay
inside the workspace): **1 passed**.

Tests that assert concrete provider metadata (e.g. `test_max_context_tokens`) could
not run because they require the real litellm model database; that limitation is
recorded in `.prale-eval/result.json` under `validation.notes`.
