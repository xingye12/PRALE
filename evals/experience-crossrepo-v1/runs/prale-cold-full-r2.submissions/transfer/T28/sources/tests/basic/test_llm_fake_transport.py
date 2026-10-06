"""Fake-transport contract test for aider's external model helper.

Contract under test
-------------------
``Model.send_completion`` (``aider/models.py``) is the single choke point aider
uses to talk to an external model provider.  It normalises the outgoing message
list with the helpers in ``aider/sendchat.py`` and then hands the request to the
lazily imported ``litellm`` client exposed by ``aider/llm.py``.

Approach (distinct from ``tests/basic/test_sendchat.py``)
--------------------------------------------------------
``tests/basic/test_sendchat.py`` patches ``litellm.completion`` with
``unittest.mock``.  This test instead installs a *fake transport module* named
``litellm`` into ``sys.modules``, so that ``aider.llm.LazyLiteLLM`` runs its
real deferred-import path and is forced to configure the fake transport.  The
assertions cover three things:

* the request fields (``model``, ``messages``, ``stream``, ``temperature``,
  ``timeout``) that reach the transport,
* the message-shaping helpers from ``aider/sendchat.py`` that decide the
  ``messages`` field,
* the absence of hidden network access - every socket entry point is replaced
  by a guard that fails loudly if anything tries to dial out.

Environment note
----------------
This checkout ships without the optional runtime dependencies ``litellm``,
``json5`` and ``oslex``.  Minimal stand-ins are installed for the *missing
import-time dependencies only*; the modules under test (``aider/llm.py``,
``aider/sendchat.py``, ``aider/models.py``) are the real repository files.  The
test therefore runs offline with no network and no extra installs.
"""

import hashlib
import importlib.util
import json
import os
import socket
import sys
import types
from pathlib import Path
from unittest import mock

import pytest


def _install_missing_dependency_shims():
    """Provide stand-ins for optional dependencies that are not installed.

    Only import-time dependencies are faked; nothing that the assertions below
    inspect is replaced.
    """
    installed = []

    def missing(name):
        try:
            return importlib.util.find_spec(name) is None
        except (ImportError, ValueError):
            return True

    if missing("json5"):
        json5 = types.ModuleType("json5")
        json5.loads = json.loads
        json5.load = json.load
        json5.dumps = json.dumps
        sys.modules["json5"] = json5
        installed.append("json5")

    if missing("oslex"):
        oslex = types.ModuleType("oslex")
        oslex.join = lambda cmd, *args, **kwargs: " ".join(cmd)
        oslex.split = lambda text, *args, **kwargs: text.split()
        sys.modules["oslex"] = oslex
        installed.append("oslex")

    return installed


# ``aider.models`` resolves ``Path.home()`` at import time, so redirect HOME to a
# workspace-local scratch directory before importing it and never touch the real
# user home.  A warm model-info cache is seeded there so that the real
# ``ModelInfoManager`` resolves metadata locally instead of falling back to the
# ``ModelInfoManager.MODEL_INFO_URL`` HTTP download.
_SCRATCH_HOME = Path(__file__).resolve().parents[2] / ".prale-eval" / "test-home"
_MODEL_INFO_URL = (
    "https://raw.githubusercontent.com/BerriAI/litellm/main/"
    "model_prices_and_context_window.json"
)
_CACHE_FILE = _SCRATCH_HOME / ".aider" / "caches" / "model_prices_and_context_window.json"
_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
_CACHE_FILE.write_text(
    json.dumps(
        {
            "gpt-4": {"litellm_provider": "openai", "max_input_tokens": 8192},
            "deepseek/deepseek-r1": {"litellm_provider": "deepseek", "max_input_tokens": 65536},
        }
    )
)
_PREVIOUS_HOME = os.environ.get("HOME")
os.environ["HOME"] = str(_SCRATCH_HOME)

_FAKED_DEPENDENCIES = _install_missing_dependency_shims()

from aider.llm import litellm  # noqa: E402
from aider.models import Model, model_info_manager  # noqa: E402
from aider.sendchat import ensure_alternating_roles, sanity_check_messages  # noqa: E402

if _PREVIOUS_HOME is None:
    os.environ.pop("HOME", None)
else:
    os.environ["HOME"] = _PREVIOUS_HOME


class FakeLogging:
    """``litellm._logging`` stand-in used by LazyLiteLLM._load_litellm."""

    def __init__(self):
        self.disable_debugging_calls = 0

    def _disable_debugging(self):
        self.disable_debugging_calls += 1


class FakeResponse:
    """Minimal litellm completion response: ``choices[0].message.content``."""

    def __init__(self, content="fake completion"):
        self.choices = [types.SimpleNamespace(message=types.SimpleNamespace(content=content))]


class FakeLitellmTransport(types.ModuleType):
    """A fake ``litellm`` module: records requests, answers locally, never dials out."""

    def __init__(self):
        super().__init__("litellm")
        self.requests = []
        self.responses = []
        # attributes configured by aider.llm.LazyLiteLLM._load_litellm
        self.suppress_debug_info = False
        self.set_verbose = True
        self.drop_params = False
        self._logging = FakeLogging()
        # attributes read by aider.models
        self.model_cost = {}
        self.completion_calls = 0

    def completion(self, **kwargs):
        self.completion_calls += 1
        self.requests.append(kwargs)
        if self.responses:
            return self.responses.pop(0)
        return FakeResponse()

    def get_model_info(self, model):
        return {
            "litellm_provider": "fake",
            "max_input_tokens": 65536,
            "max_output_tokens": 8192,
            "supports_function_calling": True,
            "supports_vision": False,
        }

    def validate_environment(self, model):
        return {"keys_in_environment": True, "missing_keys": []}

    def token_counter(self, model=None, messages=None, text=None):
        return 1

    def encode(self, model=None, text=None):
        return []

    def reset(self):
        self.requests = []
        self.responses = []
        self.completion_calls = 0


def _add_fake_exception_classes(transport):
    """``LiteLLMExceptions`` looks exception classes up by name on litellm."""
    from aider.exceptions import EXCEPTIONS

    for ex_info in EXCEPTIONS:
        setattr(transport, ex_info.name, type(ex_info.name, (Exception,), {}))


@pytest.fixture
def fake_transport(monkeypatch):
    """Install the fake transport and let aider.llm import/configure it for real."""
    transport = FakeLitellmTransport()
    _add_fake_exception_classes(transport)

    monkeypatch.setitem(sys.modules, "litellm", transport)
    # Force the deferred loader in aider/llm.py to run for each test.
    monkeypatch.setattr(litellm, "_lazy_module", None)
    monkeypatch.delenv("AIDER_SANITY_CHECK_TURNS", raising=False)

    # Keep the model-info HTTP fallback out of the picture and record any attempt
    # to use it.  A warm cache is seeded at import time, so the real
    # get_model_info() path should never ask for the download.
    info_fetches = []
    monkeypatch.setattr(
        model_info_manager,
        "_update_cache",
        lambda: info_fetches.append(_MODEL_INFO_URL),
    )
    transport.model_info_fetches = info_fetches
    return transport


@pytest.fixture
def imported_modules(monkeypatch):
    """Record every module aider.llm asks importlib for."""
    names = []
    real_import_module = importlib.import_module

    def recording_import_module(name, *args, **kwargs):
        names.append(name)
        return real_import_module(name, *args, **kwargs)

    monkeypatch.setattr(importlib, "import_module", recording_import_module)
    return names


@pytest.fixture
def no_network(monkeypatch):
    """Fail the test if anything opens a socket."""
    attempts = []

    def guarded(*args, **kwargs):
        attempts.append(args)
        raise AssertionError(f"hidden network access attempted: {args!r}")

    for attr in ("connect", "connect_ex"):
        monkeypatch.setattr(socket.socket, attr, guarded)
    monkeypatch.setattr(socket, "create_connection", guarded)
    return attempts


def test_request_fields_reach_fake_transport(fake_transport, no_network):
    """send_completion forwards the assembled request fields to the transport."""
    messages = [
        {"role": "system", "content": "be nice"},
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi"},
        {"role": "user", "content": "bye"},
    ]
    model = Model("gpt-4")

    hash_object, response = model.send_completion(messages, functions=None, stream=False)

    assert fake_transport.completion_calls == 1
    request = fake_transport.requests[0]

    # request fields asserted explicitly
    assert request["model"] == "gpt-4"
    assert request["messages"] == messages
    assert request["stream"] is False
    assert request["temperature"] == 0
    assert request["timeout"] == 600

    # the hash covers the canonicalised non-message fields
    canonical = {k: request[k] for k in ("model", "stream", "temperature")}
    expected_hash = hashlib.sha1(json.dumps(canonical, sort_keys=True).encode())
    assert hash_object.hexdigest() == expected_hash.hexdigest()

    assert response.choices[0].message.content == "fake completion"
    assert fake_transport.model_info_fetches == []
    assert no_network == []


def test_tools_request_fields(fake_transport, no_network):
    """A function definition is forwarded as litellm tool_choice/tools fields."""
    functions = [{"name": "lookup", "parameters": {"type": "object", "properties": {}}}]

    Model("gpt-4").send_completion(
        [{"role": "user", "content": "use the tool"}], functions=functions, stream=True
    )

    request = fake_transport.requests[0]
    assert request["tools"] == [{"type": "function", "function": functions[0]}]
    assert request["tool_choice"] == {"type": "function", "function": {"name": "lookup"}}
    assert request["stream"] is True
    assert fake_transport.model_info_fetches == []
    assert no_network == []


def test_sendchat_helpers_decide_the_messages_field(fake_transport, monkeypatch, no_network):
    """aider/sendchat.py helpers shape the request's messages field."""
    # ensure_alternating_roles() repairs consecutive same-role turns ...
    consecutive = [
        {"role": "user", "content": "a"},
        {"role": "user", "content": "b"},
    ]
    repaired = ensure_alternating_roles(consecutive)
    assert repaired == [
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": ""},
        {"role": "user", "content": "b"},
    ]
    assert sanity_check_messages(repaired) is True

    # ... and send_completion performs that repair for deepseek-r1 models.
    deepseek = Model("deepseek/deepseek-r1")
    assert deepseek.is_deepseek_r1()
    deepseek.send_completion(consecutive, functions=None, stream=False)
    assert fake_transport.requests[0]["messages"] == repaired
    assert fake_transport.requests[0]["model"] == "deepseek/deepseek-r1"

    # sanity_check_messages() rejects non-alternating turns before the transport
    # is ever called (it runs ahead of ensure_alternating_roles in
    # send_completion).
    monkeypatch.setenv("AIDER_SANITY_CHECK_TURNS", "1")
    for model in (deepseek, Model("gpt-4")):
        with pytest.raises(ValueError, match="don't properly alternate"):
            model.send_completion(consecutive, functions=None, stream=False)
    assert fake_transport.completion_calls == 1  # rejected requests never reached it
    assert fake_transport.model_info_fetches == []
    assert no_network == []


def test_simple_send_with_retries_uses_fake_transport(fake_transport, no_network):
    """The retry helper reads the transport response and sends no extra fields."""
    fake_transport.responses.append(FakeResponse("answer"))

    result = Model("gpt-4").simple_send_with_retries([{"role": "user", "content": "q"}])

    assert result == "answer"
    assert fake_transport.completion_calls == 1
    request = fake_transport.requests[0]
    assert request["stream"] is False
    assert "functions" not in request
    assert request["messages"] == [{"role": "user", "content": "q"}]
    assert fake_transport.model_info_fetches == []
    assert no_network == []


def test_no_hidden_network_access(fake_transport, imported_modules, no_network):
    """Only the fake transport is used: no real litellm import, no socket."""
    transport = fake_transport

    result = Model("gpt-4").simple_send_with_retries([{"role": "user", "content": "q"}])

    assert result == "fake completion"

    # aider.llm's deferred loader imported exactly one module, the fake litellm
    assert imported_modules == ["litellm"]
    assert litellm._lazy_module is transport

    # the real loader configured the transport it loaded
    assert transport.suppress_debug_info is True
    assert transport.set_verbose is False
    assert transport.drop_params is True
    assert transport._logging.disable_debugging_calls == 1

    # the model-info download was never requested either
    assert transport.model_info_fetches == []

    # and nothing touched the network
    assert no_network == []


def test_fake_transport_blocks_network_guard():
    """Sanity check that the network guard itself would catch a real connection."""
    with mock.patch.object(socket, "create_connection", side_effect=AssertionError("blocked")):
        with pytest.raises(AssertionError, match="blocked"):
            socket.create_connection(("example.com", 80))
