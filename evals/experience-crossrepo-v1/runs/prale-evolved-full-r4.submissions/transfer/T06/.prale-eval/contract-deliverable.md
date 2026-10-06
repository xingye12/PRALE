# T06 contract deliverable — external/model helper with a fake transport (aider)

Task id: `T06` · Repository: `aider` · Mode: `contract`

## What the contract is

Calling a model provider in aider is routed through an **external/model helper** that
must (a) not touch the provider client until it is actually needed and (b) forward a
well-formed request. The public contract lives in two modules:

| Module | Symbol | Lines | Role |
| --- | --- | --- | --- |
| `aider/llm.py` | `LazyLiteLLM` | 21–42 | External/model helper. `__getattr__` (24–28) defers loading; `_load_litellm` (30–42) imports the `litellm` client and pins `suppress_debug_info=True`, `set_verbose=False`, `drop_params=True`, `_logging._disable_debugging()`. |
| `aider/llm.py` | `litellm = LazyLiteLLM()` | 45 | Shared gateway singleton; must stay unloaded (`_lazy_module is None`) on import. |
| `aider/sendchat.py` | `sanity_check_messages` | 5–26 | Validates the `messages` field alternates user/assistant; raises `ValueError` on consecutive same-role messages; returns `last_non_system_role == "user"`. |
| `aider/sendchat.py` | `ensure_alternating_roles` | 29–61 | Normalises `messages` by inserting an empty opposite-role message between same-role neighbours. |
| `aider/models.py` | `Model.send_completion` | 985–1037 | Supporting production caller: shapes `messages` with the sendchat helpers and dispatches `litellm.completion(**kwargs)` with `model/stream/temperature/tools/timeout/messages`. |

## Executable demo

Artifact: **`tests/basic/test_t06_fake_transport.py`**

The "fake transport" is a `RecordingTransport` module injected into
`sys.modules["litellm"]`. It records every request and performs no I/O, so the
demo never contacts a provider. The demo runs the helper against it and asserts:

1. **Lazy contract** — a fresh `LazyLiteLLM()` has `_lazy_module is None`; the
   transport is only resolved on first attribute access, and loading alone emits
   no request.
2. **Transport configuration** — after load the transport has
   `suppress_debug_info is True`, `set_verbose is False`, `drop_params is True`
   and its `_logging._disable_debugging()` was called.
3. **Request fields** — `helper.completion(model="gpt-4", stream=False,
   temperature=0, messages=[...])` arrives at the transport exactly once with
   `model`, `stream`, `temperature` and `messages` verbatim.
4. **No hidden network access** — with `socket.socket` patched to raise, the same
   flow still completes and `sys.modules["litellm"]` is the fake, never the real
   client.
5. **Shared singleton** — `aider.llm.litellm` is a `LazyLiteLLM` whose
   `_lazy_module` is still `None` (importing `aider.llm` triggers no provider
   import).
6. **Message-field contract** — `sanity_check_messages` returns `True` for a
   valid user/assistant/user request, raises `ValueError` for consecutive user
   messages and returns `False` when the last non-system role is the assistant;
   `ensure_alternating_roles` inserts the empty opposite-role gap and the result
   still satisfies `sanity_check_messages`.

Normalised operation result: the helper forwards a valid, alternating request to
whatever transport is installed, and no socket is ever opened.

## How to run

```bash
python -m pytest tests/basic/test_t06_fake_transport.py -q
# 9 passed
```

Standalone alternative: `python tests/basic/test_t06_fake_transport.py`.

## Recorded environment limitation

The sandbox lacks the third-party runtime packages `json5`, `diff_match_patch`,
`oslex` and `litellm`. Therefore:

* `aider.models` cannot be imported (it needs `json5`/`diff_match_patch`), so the
  demo drives `aider.llm.LazyLiteLLM` directly and cites `Model.send_completion`
  as supporting evidence rather than importing it.
* `aider.sendchat` imports `aider.utils`, which imports `oslex`; the demo injects
  a minimal `oslex` stub into `sys.modules` before importing `sendchat`. This is
  recorded here and in `result.json.validation.notes` instead of installing the
  missing dependency.
* The real `litellm` client is intentionally absent — the fake transport replaces
  it, which is exactly what makes the "no hidden network access" assertion
  meaningful.

## Boundary compliance

Created only `.prale-eval/result.json`, `.prale-eval/contract-deliverable.md` and
`tests/basic/test_t06_fake_transport.py`. No task metadata, hidden-oracle file,
package lock or git configuration was modified.
