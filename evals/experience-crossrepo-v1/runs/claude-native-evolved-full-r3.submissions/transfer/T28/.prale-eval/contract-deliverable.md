# T28 — Cross-repository experience transfer: external/model helper under a fake transport

Repository: `aider` · Mode: `contract` · Task: `T28`

## What the contract is

The requested evaluation — *"test a distinct external/model helper with a fake transport,
asserting request fields and no hidden network access"* — is satisfied by a normalized,
executable test contract over aider's external-model boundary:

- **External/model helper:** `aider/llm.py` → `LazyLiteLLM` (lines 21–42). It is the single
  deferred boundary to the external `litellm` model library. `__getattr__` postpones the
  import until first attribute access; `_load_litellm` imports `litellm` once, caches it,
  and writes the exact transport configuration (`suppress_debug_info=True`,
  `set_verbose=False`, `drop_params=True`, `_logging._disable_debugging()`).
- **Request-field contract:** `aider/sendchat.py` → `ensure_alternating_roles` (lines 29–61)
  and `sanity_check_messages` (lines 5–26) define the shape of the `messages` request field:
  user/assistant turns must alternate (an empty opposite-role turn is inserted otherwise) and
  the last non-system turn must be the user's.
- **Request builder (consumer):** `aider/models.py` → `Model.send_completion` (lines 985–1037)
  assembles `model`, `stream`, `temperature`, `tools`/`tool_choice`, `messages` and `timeout`
  and issues exactly one call to the `aider.llm` transport (line 1036).

## Executable demo

`tests/basic/test_external_model_fake_transport.py`

The demo substitutes a `FakeLiteLLM` module for `importlib.import_module` on `aider.llm`, so
the real `litellm` package is never imported. An **autouse socket guard** replaces
`socket.socket.connect`, `socket.socket.connect_ex`, `socket.create_connection` and
`socket.getaddrinfo` with raisers, so any real network access fails the test.

Four cases:

1. `test_lazy_llm_defers_import_and_configures_fake_transport` — asserts `_lazy_module is None`
   before access, that the first attribute access triggers exactly one
   `import_module("litellm")`, that the cached module is the fake, that the loader wrote
   `suppress_debug_info=True`, `set_verbose=False`, `drop_params=True`, called
   `_logging._disable_debugging()` once, and that a second access re-uses the cache (no re-import).
2. `test_completion_request_fields_reach_only_the_fake_transport` — routes a completion request
   through the helper and asserts exactly one request reached the fake with fields
   `model`/`messages`/`stream`/`temperature` intact and unmutated, plus the fake response returned.
3. `test_sendchat_normalises_messages_request_field` — asserts `ensure_alternating_roles` turns
   `[user, user]` into `[user, assistant, user]`, that `sanity_check_messages` accepts it, and
   that this normalised list is exactly what travels in the request's `messages` field.
4. `test_transport_is_injected_and_absent_from_real_modules` — asserts the completion was served
   by the injected fake and that no real `litellm` module entered `sys.modules`.

### Validation command

```
python -m pytest tests/basic/test_external_model_fake_transport.py -v
```

Result: **4 passed**.

## Normalized operation result

| Aspect | Contract |
|---|---|
| Transport | Injected fake module; real `litellm` never imported |
| Deferred load | `_lazy_module is None` until first attribute access |
| Config fields written | `suppress_debug_info=True`, `set_verbose=False`, `drop_params=True`, `_logging._disable_debugging()` |
| Request fields forwarded | `model`, `messages`, `stream`, `temperature` — asserted equal to the input, once |
| Messages contract | `ensure_alternating_roles` output is alternating; `sanity_check_messages` returns `True` |
| Hidden network | Blocked by socket guard; no connection attempted |

## Environment limitation (recorded, not worked around)

Optional dependencies `litellm` and `json5` are **not installed** in this environment, and no
dependencies were installed. Consequently:

- the real external `litellm` transport cannot be imported — which is precisely why the fake
  transport is used, and no hidden import/network occurs;
- `aider.models` cannot be imported (it imports `json5`), so `Model.send_completion` is cited as
  the request builder but not executed by the demo;
- `aider.sendchat` is importable only after a minimal stub for the missing `oslex` module (used
  solely by `aider/utils.py`'s `oslex.join`) is installed into `sys.modules`; this adds no
  network behaviour.

Equivalent correct implementations of this contract are acceptable.
