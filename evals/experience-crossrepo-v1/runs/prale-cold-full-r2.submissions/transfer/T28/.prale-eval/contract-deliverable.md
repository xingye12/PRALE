# T28 / aider / contract — fake-transport contract for aider's external model helper

## Deliverable

An executable, offline contract test was added to the repository:

- `tests/basic/test_llm_fake_transport.py` (6 tests)

It drives aider's external/model call path with a **fake transport** and asserts
(a) the request fields that reach the transport, (b) how the request's
`messages` field is normalised, and (c) that no hidden network access happens.

Run it with:

```bash
python -m pytest tests/basic/test_llm_fake_transport.py -q
# 6 passed
```

## System under test

| Piece | File | Role |
| --- | --- | --- |
| `Model.send_completion` / `simple_send_with_retries` | `aider/models.py` (985–1108) | builds the request kwargs (`model`, `messages`, `stream`, `temperature`, `tools`/`tool_choice`, `timeout`), hashes them, then calls `litellm.completion(**kwargs)` |
| `sanity_check_messages`, `ensure_alternating_roles` | `aider/sendchat.py` (5–61) | validate / repair the `messages` field before dispatch |
| `LazyLiteLLM` + `litellm` singleton | `aider/llm.py` (21–45) | deferred `import litellm` proxy; the only place the external SDK is loaded and configured |

## Contract asserted

1. **Request fields.** For `send_completion(..., stream=False)` the transport
   records exactly `model`, `messages`, `stream=False`, `temperature=0`,
   `timeout=600`; the returned `sha1` hash equals the sha1 of the canonical
   (`sort_keys=True`) JSON of the non-message fields. With a function schema the
   transport additionally receives
   `tools=[{"type": "function", "function": <schema>}]` and
   `tool_choice={"type": "function", "function": {"name": "lookup"}}`.
2. **`messages` normalisation (sendchat).** `ensure_alternating_roles()` turns
   consecutive same-role turns into an alternating list by inserting an empty
   turn of the opposite role, and `send_completion` applies it for
   `deepseek/deepseek-r1`. `sanity_check_messages()` (enabled with
   `AIDER_SANITY_CHECK_TURNS=1`) raises `ValueError` on non-alternating input
   *before* the transport is called (the transport call counter stays at 1 for
   the whole test).
3. **Transport wiring (llm).** The fake `litellm` module is installed as
   `sys.modules["litellm"]`; the real `LazyLiteLLM._load_litellm` path is
   exercised and asserts `importlib.import_module` was asked only for
   `"litellm"`, that `litellm._lazy_module` is the fake module, and that the
   loader configured it (`suppress_debug_info=True`, `set_verbose=False`,
   `drop_params=True`, `logging._disable_debugging()` called once).
4. **No hidden network access.** `socket.socket.connect`, `connect_ex` and
   `socket.create_connection` are replaced by a guard that records attempts and
   raises; every test asserts the attempt list is empty. `Path.home()` is
   redirected to a workspace-local scratch directory before `aider.models` is
   imported and a warm `~/.aider/caches/model_prices_and_context_window.json` is
   seeded, so the real `ModelInfoManager._update_cache()` HTTP download
   (`MODEL_INFO_URL`) is never requested — a recorder asserts that list is empty
   too. A negative control test proves the guard would fire on a real connect.

## Normalized operation result

Observed on this checkout (recorded from the fake transport, `python` snippet
equivalent to the tests):

```json
{
  "hash": "ff99356177d3bc2b4cb6ed444cd5d2b1fc21151a",
  "request": {
    "model": "deepseek/deepseek-r1",
    "stream": false,
    "timeout": 600,
    "messages": [
      {"role": "user", "content": "a"},
      {"role": "assistant", "content": ""},
      {"role": "user", "content": "b"}
    ]
  }
}
```

Note the empty `assistant` turn: it is `ensure_alternating_roles()`'s repair of
the two consecutive `user` turns. A `gpt-4` request with a tool schema yields
`model`, `stream`, `temperature=0`, `tools`, `tool_choice`, `timeout=600`,
`messages` — and no other field.

## Environment / limitations recorded

- Optional runtime dependencies `litellm`, `json5` and `oslex` are **not
  installed** in this checkout, so the test installs minimal stand-ins for those
  *import-time* dependencies only (documented in the test's module docstring).
  Everything that is asserted — `aider/llm.py`, `aider/sendchat.py`,
  `aider/models.py` — is the real repository code.
- Because the real `litellm` SDK is unavailable, the fake transport is the
  substitute delivery channel; that is precisely what makes the "no hidden
  network access" assertions meaningful here.
- `flake8` is not installed, so the `[flake8]` style config could not be run;
  line length (<= 100) was checked manually.
- The wider `tests/basic` suite cannot be collected in this environment
  (`ModuleNotFoundError: No module named 'mixpanel'`, `json5`, ...), which is
  pre-existing and unrelated to this change; validation is therefore focused on
  the new test module.
