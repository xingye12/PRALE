# Demo: aider model-info lookup path (task learn/10)

Repository: `aider` · Mode: `demo` · Task id: `10`

## What is demonstrated

The real, unmodified `aider.models.ModelInfoManager` lookup path driven entirely
by a **local fixture cache**, including every **fallback used when metadata is
unavailable**. No network access is performed and the real `$HOME` is never
written to.

| Artifact | Purpose |
| --- | --- |
| `.prale-eval/fixtures/model_prices_and_context_window.json` | Local fixture standing in for litellm's upstream metadata file (entries: `fixture-model`, `shared-model`, `gpt-4o`, `openrouter/vendor/model-x`). |
| `.prale-eval/demo_model_info_lookup.py` | Executable demo: 21 assertions across 9 scenario groups, prints one JSON object per check plus a summary, exits non-zero on any failure. |
| `.prale-eval/result.json` | Task result with evidence, claims, conclusion and validation. |

## How to run

```bash
cd /tmp/prale-real-eval-6w_0ugit/workspace
python .prale-eval/demo_model_info_lookup.py
```

Observed result: **21/21 checks passed, exit code 0**; summary line
`{"checks": 21, "failed": 0, "passed": 21, ...}`.

## Contract exercised (repository code)

- `aider/models.py` `ModelInfoManager` (161-323): cache location `~/.aider/caches/model_prices_and_context_window.json`, `CACHE_TTL = 24h`, upstream metadata URL.
- `_load_cache` (184-201): load-once guard, TTL check; `JSONDecodeError` ⇒ cache treated as missing (`self.content = None`).
- `get_model_from_cached_json_db` (223-247): `local_model_metadata` shortcut → cache file exact match → `provider/model` match via `pieces[1]` + `litellm_provider` → `{}`.
- `get_model_info` (249-274): falls through to `litellm.get_model_info` when litellm is loaded or the cache missed (errors mentioning `model_prices_and_context_window.json` swallowed) → OpenRouter cached db → legacy scrape → returns `{}`.
- `Model.get_model_info` (371-372) + `Model.__init__` (348-358): delegate to the module-level `model_info_manager` singleton and derive `max_chat_history_tokens`.
- `tests/basic/test_models.py` `test_get_model_info_nonexistent` (28-31): the contract that an unknown model yields exactly `{}`; `test_max_context_tokens` (33-47): exact `info["max_input_tokens"]` values surfaced through `Model.info`.

## Normalized operation result (what the demo prints)

Each scenario emits `{"case", "ok", "expected", "observed", "note"}`. Normalized
outcomes:

1. **1a-1c — exact cache hit**: `fixture-model` returns the fixture dict verbatim; refresh called 0 times; `litellm._lazy_module is None`, i.e. a cache hit short-circuits before the external source is even imported.
2. **2a-2b — in-memory precedence**: `local_model_metadata["memory-only-model"]` is returned with no cache file present and 0 cache/network calls.
3. **3a-3c — provider prefix**: `openai/shared-model` resolves via `pieces[1]` because `litellm_provider == "openai"`; `azure/shared-model` returns `{}` (provider mismatch); `openrouter/vendor/model-x` hits the cache exactly.
4. **4a-4c — corrupted cache**: invalid JSON ⇒ `content is None`, lookup returns `{}`, refresh attempted once.
5. **5a-5b — stale cache**: file older than `CACHE_TTL` is ignored, `_update_cache()` runs exactly once, refreshed content serves `refreshed-model`.
6. **6a-6b — metadata unavailable**: `get_model_info("non-existent-model") == {}` (mirrors the repo unit test) with one offline refresh attempt; no exception escapes.
7. **7a — litellm fallback**: cache miss ⇒ litellm metadata is returned when truthy (`litellm-only-model`).
8. **8a-8c — OpenRouter ladder**: cached OpenRouter db wins (legacy scrape asserted not to run); if it misses, the legacy scrape answers; if both miss, `{}`.
9. **9a-9b — Model level**: with the singleton swapped for the fixture manager, `Model("fixture-model").info` is the fixture dict and `max_chat_history_tokens == 4096/16 == 1024`.

## Environment limitations (recorded, not worked around by installing packages)

The focused repository test could not be collected:

```
$ python -m pytest tests/basic/test_models.py -q
aider/models.py:15: in <module>
    import json5
E   ModuleNotFoundError: No module named 'json5'
1 error in 0.12s
```

`litellm` and `oslex` are missing as well (and the wider suite also needs
`pexpect`/`grep_ast`). Installing dependencies is out of scope. The demo
therefore injects controlled stand-ins into `sys.modules` for those import-time
needs; the stand-in for `litellm` mirrors its two relevant behaviours (raises for
unknown models with a message naming `model_prices_and_context_window.json`;
returns the metadata dict for known models). No repository source file, package
lock, git configuration, or task metadata was modified.

A dependency-free supplementary check (AST) verified that each cited symbol
exists and its node lies inside the cited inclusive range:

```
aider/models.py: ModelInfoManager 161-323, _load_cache 184-201,
                 get_model_from_cached_json_db 223-247, get_model_info 249-274,
                 Model.get_model_info 371-372
tests/basic/test_models.py: test_get_model_info_nonexistent 28-31,
                            test_max_context_tokens 33-47
```

Temporary per-case homes live under `.prale-eval/_demo_tmp/` and are removed on
exit (including on failure).
