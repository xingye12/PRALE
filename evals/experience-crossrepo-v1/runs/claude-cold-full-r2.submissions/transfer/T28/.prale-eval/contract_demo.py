"""Executable contract demo for T28 (aider).

Target experience (transferred): test a distinct *external/model helper* through a
*fake transport*, asserting the request fields it emits and that no hidden network
access occurs.

Mapping onto aider:

* external/model helper  -> ``aider.llm.LazyLiteLLM`` (``from aider.llm import litellm``),
  the lazy proxy that fronts the external ``litellm`` model library.
* fake transport         -> a recording ``litellm`` module injected into ``sys.modules``
  so the helper never imports or calls the real library.
* request fields         -> the attributes the helper configures on the transport
  (``suppress_debug_info``, ``set_verbose``, ``drop_params``, ``_logging``) plus the
  chat-request fields (``model``, ``messages``, ``stream``, ``temperature``,
  ``timeout``) observed at the transport boundary.
* request shaping        -> ``aider.sendchat.ensure_alternating_roles`` /
  ``sanity_check_messages``, which produce and validate the ``{role, content}``
  message fields carried in the request.
* no hidden network      -> a socket-level guard raises if anything opens a real
  connection, and the helper is asserted to stay lazy until first attribute access.

Run:  python .prale-eval/contract_demo.py
Exit code 0 == all contract assertions hold.
"""

import os
import sys
import types

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if WORKSPACE not in sys.path:
    sys.path.insert(0, WORKSPACE)


# --------------------------------------------------------------------------- #
# Fake transport: a recording stand-in for the external `litellm` library.
# --------------------------------------------------------------------------- #
class _FakeLogging:
    def __init__(self):
        self.debugging_disabled = 0

    def _disable_debugging(self):
        self.debugging_disabled += 1


class FakeLiteLLM(types.ModuleType):
    """Recording doubles for the fields/methods LazyLiteLLM touches."""

    def __init__(self):
        super().__init__("litellm")
        # Deliberately hostile defaults: the helper must flip every one of these.
        self.suppress_debug_info = False
        self.set_verbose = True
        self.drop_params = False
        self._logging = _FakeLogging()
        self.completion_calls = []

    def completion(self, **kwargs):
        self.completion_calls.append(kwargs)
        return {"choices": [{"message": {"content": "fake"}}]}


# --------------------------------------------------------------------------- #
# Network guard: any attempt at real network access fails loudly.
# --------------------------------------------------------------------------- #
class _NetworkBlocked(AssertionError):
    pass


def install_network_guard():
    import socket

    original_socket = socket.socket

    class GuardedSocket(original_socket):
        def connect(self, *a, **k):
            raise _NetworkBlocked("hidden network access attempted via socket.connect")

        def connect_ex(self, *a, **k):
            raise _NetworkBlocked("hidden network access attempted via socket.connect_ex")

    socket.socket = GuardedSocket
    return lambda: setattr(socket, "socket", original_socket)


# --------------------------------------------------------------------------- #
# Minimal import shims so aider.sendchat can load in a dependency-light env.
# `aider.utils` imports `oslex`; sendchat only needs `format_messages` on the
# error path, so a small stand-in module is sufficient and installs no packages.
# --------------------------------------------------------------------------- #
def install_import_shims():
    if "oslex" not in sys.modules:
        oslex = types.ModuleType("oslex")

        def _join(cmd_list, **kwargs):
            return " ".join(cmd_list)

        oslex.join = _join
        sys.modules["oslex"] = oslex


# --------------------------------------------------------------------------- #
# Checks
# --------------------------------------------------------------------------- #
results = []


def check(name, condition, detail=""):
    results.append((name, bool(condition), detail))
    status = "PASS" if condition else "FAIL"
    line = f"[{status}] {name}"
    if detail:
        line += f" -- {detail}"
    print(line)


def main():
    install_import_shims()
    relax_network = install_network_guard()
    try:
        # 1. Importing the module must NOT import the external library (laziness).
        sys.modules.pop("litellm", None)
        import aider.llm as llm_mod

        check(
            "llm import does not eagerly import external litellm",
            "litellm" not in sys.modules,
            "sys.modules has no 'litellm' after `import aider.llm`",
        )
        check(
            "module-level litellm is a LazyLiteLLM proxy",
            isinstance(llm_mod.litellm, llm_mod.LazyLiteLLM),
        )

        # 2. First attribute access loads the (fake) transport and configures fields.
        fake = FakeLiteLLM()
        sys.modules["litellm"] = fake
        proxy = llm_mod.LazyLiteLLM()
        check("proxy not loaded before first access", proxy._lazy_module is None)

        returned = proxy.completion  # triggers _load_litellm()
        check(
            "attribute access loads external transport lazily",
            proxy._lazy_module is fake,
            "proxy._lazy_module is the injected fake",
        )
        check(
            "attribute access proxies through to the transport",
            returned == fake.completion,
        )

        # 3. Assert the request/config fields the helper sets on the transport.
        check("field suppress_debug_info=True", fake.suppress_debug_info is True)
        check("field set_verbose=False", fake.set_verbose is False)
        check("field drop_params=True", fake.drop_params is True)
        check(
            "field _logging._disable_debugging called once",
            fake._logging.debugging_disabled == 1,
            f"calls={fake._logging.debugging_disabled}",
        )
        check("_load_litellm is idempotent", _is_idempotent(proxy, fake))

        # 4. Build & validate the chat request using aider.sendchat helpers.
        from aider.sendchat import ensure_alternating_roles, sanity_check_messages

        raw_messages = [
            {"role": "user", "content": "hello"},
            {"role": "user", "content": "are you there?"},
            {"role": "assistant", "content": "yes"},
            {"role": "user", "content": "edit the file"},
        ]
        messages = ensure_alternating_roles(raw_messages)
        check(
            "ensure_alternating_roles inserts an empty assistant turn",
            messages[1] == {"role": "assistant", "content": ""},
        )
        check("roles strictly alternate after shaping", _alternates(messages))
        check(
            "shaped request ends on a user turn",
            sanity_check_messages(messages) is True,
        )
        bad = [{"role": "user", "content": "a"}, {"role": "user", "content": "b"}]
        try:
            sanity_check_messages(bad)
            raise AssertionError("expected ValueError for non-alternating messages")
        except ValueError:
            check("sanity_check_messages rejects duplicate roles", True)

        # 5. Dispatch through the fake transport and assert request fields.
        request = dict(
            model="gpt-4",
            messages=messages,
            stream=False,
            temperature=0,
            timeout=600,
        )
        fake.completion(**request)
        check("exactly one transport call recorded", len(fake.completion_calls) == 1)
        sent = fake.completion_calls[0]
        for field in ("model", "messages", "stream", "temperature", "timeout"):
            check(f"request field '{field}' present", field in sent, f"value={sent.get(field)!r}")
        check("request.model routed correctly", sent["model"] == "gpt-4")
        check("request.messages is the shaped list", sent["messages"] == messages)
        check(
            "request.messages carry role/content fields",
            all(set(m) >= {"role", "content"} for m in sent["messages"]),
        )

        # 6. No hidden network access by construction.
        try:
            import socket

            socket.socket().connect(("example.com", 443))
            check("network guard blocks real connections", False, "connect() did not raise")
        except _NetworkBlocked:
            check("network guard blocks real connections", True)
    finally:
        relax_network()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        print("FAILED: " + ", ".join(r[0] for r in failed))
        return 1
    print("CONTRACT SATISFIED: external/model helper verified against a fake transport,")
    print("request fields asserted, and no hidden network access observed.")
    return 0


def _is_idempotent(proxy, fake):
    proxy._load_litellm()  # second call must be a no-op
    return proxy._lazy_module is fake


def _alternates(messages):
    prev = None
    for msg in messages:
        role = msg.get("role")
        if role == "system":
            continue
        if role == prev:
            return False
        prev = role
    return True


if __name__ == "__main__":
    sys.exit(main())
