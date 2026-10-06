# T28 · aider · contract deliverable

**Request:** *test a distinct external/model helper with a fake transport, asserting
request fields and no hidden network access.*

## What was built

An executable contract demo at `.prale-eval/contract_demo.py` (pure stdlib + `aider`),
runnable with:

```
python .prale-eval/contract_demo.py
```

Exit code `0` means every contract assertion holds. Current result: **24/24 checks pass**.

## The experience → aider mapping

| Transferred concept | aider realization |
| --- | --- |
| external/model helper | `aider.llm.LazyLiteLLM` — the lazy proxy fronting the external `litellm` library (`from aider.llm import litellm`) |
| fake transport | a recording `litellm` module injected into `sys.modules["litellm"]`, so the helper binds to it instead of the real library |
| request fields | config fields the helper sets on the transport (`suppress_debug_info`, `set_verbose`, `drop_params`, `_logging`) + chat-request fields observed at the boundary (`model`, `messages`, `stream`, `temperature`, `timeout`) |
| request shaping / validation | `aider.sendchat.ensure_alternating_roles` and `sanity_check_messages` |
| no hidden network access | socket-level guard that raises on `connect`/`connect_ex`, plus a laziness assertion |

## Contract asserted

1. **Laziness / no eager import.** After `import aider.llm`, `sys.modules` contains no
   `litellm`; the module-level `litellm` is a `LazyLiteLLM` and its `_lazy_module` is
   `None` until first attribute access. (`aider/llm.py:24-45`)
2. **Fake-transport loading.** Installing a fake `litellm` and touching one attribute
   binds `_lazy_module` to the fake and proxies the attribute through to it;
   `_load_litellm` is idempotent. (`aider/llm.py:30-42`)
3. **Transport config fields.** The load sets `suppress_debug_info=True`,
   `set_verbose=False`, `drop_params=True`, and calls `_logging._disable_debugging()`
   exactly once. (`aider/llm.py:39-42`)
4. **Request message fields.** `ensure_alternating_roles` inserts an empty
   opposite-role turn so roles strictly alternate; `sanity_check_messages` accepts the
   shaped request (ends on a user turn) and rejects duplicate consecutive roles with
   `ValueError`. (`aider/sendchat.py:5-61`)
5. **Emitted request fields.** Dispatching `model="gpt-4", messages=<shaped>,
   stream=False, temperature=0, timeout=600` through the fake transport records
   exactly one call whose captured fields match, with every message carrying
   `role`/`content`.
6. **No hidden network access.** A guarded `socket.socket` raises on any real
   `connect`/`connect_ex`; it is never tripped because the helper talks only to the
   injected fake.

## Normalized operation result

```
input:  messages = [user, user, assistant, user]
        request  = {model: "gpt-4", stream: False, temperature: 0, timeout: 600}

shaped: ensure_alternating_roles -> [user, assistant(""), user, assistant, user]
valid:  sanity_check_messages   -> True
emit:   fake litellm.completion(model, messages, stream, temperature, timeout)
        -> 1 recorded call, all fields present, no network connection opened

result: PASS (24/24 checks, exit 0)
```

## Environment limitations recorded

`litellm` and `oslex` are not installed in this environment. Rather than install
dependencies, the demo injects a recording fake `litellm` module and a minimal `oslex`
stand-in via `sys.modules`. This makes the test hermetic: it neither imports the real
external library nor opens a socket. No task metadata, oracle files, package locks, or
git configuration were modified.
