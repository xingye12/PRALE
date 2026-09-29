"""What may leave the process, asserted without a Langfuse instance.

The sanitizer is the only thing standing between a durable fact and a third
party, so these tests are written against the bytes that would be uploaded —
``json.dumps(sanitized.event(...))`` — rather than against the sanitizer's own
return values.
"""

import hashlib
import json
from dataclasses import asdict, is_dataclass

import pytest

from agent_harness.api.errors import ProjectConfigError
from agent_harness.integrations.langfuse import (
    CapturePolicy,
    LangfuseConfig,
    TelemetrySanitizer,
)
from agent_harness.runtime.telemetry import GenerationTelemetry, OperationTelemetry

SECRET = "sk-lf-0123456789abcdef"


def _sanitizer(profile: str, **kwargs) -> TelemetrySanitizer:
    return TelemetrySanitizer(CapturePolicy.for_profile(profile), **kwargs)


def _uploaded(value) -> str:
    """The bytes a sink would hand to the SDK, rendered as text."""

    if is_dataclass(value):
        value = asdict(value)
    return json.dumps(value, ensure_ascii=False, default=str)


def _generation(**overrides) -> GenerationTelemetry:
    fields: dict = {
        "session_id": "session-1",
        "lane": "main",
        "operation_id": "op-1",
        "attempt": 1,
        "model": "deepseek-flash",
        "input": [{"role": "user", "content": "read src/main.py"}],
        "output": {"content": "done"},
        "usage": {"prompt_tokens": 12, "completion_tokens": 3},
        "finish_reason": "stop",
        "started_at": 1_000,
        "ended_at": 2_000,
        "metadata": {"memory_bundle_hash": "abc123", "memory_item_count": 2},
    }
    return GenerationTelemetry(**{**fields, **overrides})


def test_the_metadata_profile_uploads_identity_instead_of_text() -> None:
    sanitizer = _sanitizer("metadata")

    uploaded = _uploaded(sanitizer.event(_generation()))

    assert "read src/main.py" not in uploaded
    assert "done" not in uploaded
    digest = hashlib.sha256(b"read src/main.py").hexdigest()[:12]
    assert digest in uploaded
    # Counts and booleans survive: a regression is usually visible in them.
    assert '"prompt_tokens": 12' in _uploaded(sanitizer.event(_generation(metadata={"is_error": True})))


def test_the_metadata_profile_still_uploads_the_structure_of_a_prompt() -> None:
    sanitizer = _sanitizer("metadata")

    described = sanitizer.payload([{"role": "user", "content": "hello"}])

    assert described == [
        {
            "role": {"chars": 4, "sha256": hashlib.sha256(b"user").hexdigest()[:12]},
            "content": {"chars": 5, "sha256": hashlib.sha256(b"hello").hexdigest()[:12]},
        }
    ]


def test_a_hash_is_stable_and_content_addressed() -> None:
    sanitizer = _sanitizer("metadata")

    first = sanitizer.describe("same text")
    again = sanitizer.describe("same text")
    other = sanitizer.describe("other text")

    assert first == again
    assert first != other


def test_the_redacted_profile_keeps_text_but_removes_credentials() -> None:
    sanitizer = _sanitizer("redacted", secrets=(SECRET,))
    event = _generation(
        output={
            "content": f'failed with {SECRET} and Authorization: Bearer abcdefgh12345678 for api_key="leaked-1"',
            "notes": ["-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----"],
        }
    )

    uploaded = _uploaded(sanitizer.event(event))

    assert SECRET not in uploaded
    assert "abcdefgh12345678" not in uploaded
    assert "leaked-1" not in uploaded
    assert "MIIEow" not in uploaded
    # Everything that was not a credential is still there, verbatim.
    assert "failed with" in uploaded


def test_a_secret_key_is_redacted_whatever_its_value_looks_like() -> None:
    sanitizer = _sanitizer("redacted")

    uploaded = _uploaded(sanitizer.event(_generation(input={"api_key": "not-shaped-like-a-token", "content": "kept"})))

    assert "not-shaped-like-a-token" not in uploaded
    assert "kept" in uploaded


def test_the_full_profile_still_removes_the_deployment_s_own_secrets() -> None:
    sanitizer = _sanitizer("full", secrets=(SECRET,))

    uploaded = _uploaded(sanitizer.event(_generation(output={"content": f"quoted {SECRET}"})))

    assert SECRET not in uploaded


def test_a_long_value_is_truncated_with_a_visible_marker() -> None:
    sanitizer = _sanitizer("redacted")

    uploaded = sanitizer.payload("x" * 5_000)

    assert isinstance(uploaded, str)
    assert len(uploaded) < 2_100
    assert "[truncated 3000 chars]" in uploaded


def test_depth_and_item_limits_bound_one_fact() -> None:
    sanitizer = _sanitizer("redacted")

    deep = {"a": {"b": {"c": {"d": {"e": {"f": {"g": "bottom"}}}}}}}
    assert "[depth limit]" in _uploaded(sanitizer.payload(deep))
    assert "bottom" not in _uploaded(sanitizer.payload(deep))

    wide = [f"item-{index}" for index in range(100)]
    assert "[50 more items]" in _uploaded(sanitizer.payload(wide))


def test_a_path_loses_the_machine_it_came_from() -> None:
    sanitizer = _sanitizer("redacted")
    sanitizer.bind_project_root("/srv/checkout")

    assert sanitizer.payload("/srv/checkout/src/main.py") == "src/main.py"
    assert sanitizer.payload("/srv/checkout") == "."
    foreign = _uploaded(sanitizer.payload("/home/someone/.ssh/config"))
    assert "someone" not in foreign
    assert "config" in foreign


def test_a_session_id_langfuse_would_refuse_is_hashed() -> None:
    sanitizer = _sanitizer("metadata")

    def session_key(session_id: str) -> str:
        event = OperationTelemetry(session_id=session_id, lane="main", operation_id="op-1", kind="run", phase="started")
        return sanitizer.event(event).session_id

    assert session_key("session-1") == "session-1"
    assert session_key("会话一") == session_key("会话一")
    assert session_key("会话一").startswith("sha256:")
    assert session_key("s" * 300).startswith("sha256:")
    assert len(session_key("s" * 300)) < 200


def test_tracing_is_off_unless_the_switch_says_so() -> None:
    assert LangfuseConfig.from_environment({}) is None
    assert LangfuseConfig.from_environment({"LANGFUSE_TRACING_ENABLED": "false"}) is None
    assert LangfuseConfig.from_environment({"LANGFUSE_TRACING_ENABLED": "0"}) is None


def test_an_enabled_switch_without_credentials_fails_without_echoing_them() -> None:
    environ = {
        "LANGFUSE_TRACING_ENABLED": "true",
        "LANGFUSE_PUBLIC_KEY": "pk-lf-public-placeholder",
        "LANGFUSE_SECRET_KEY": "",
    }

    with pytest.raises(ProjectConfigError) as error:
        LangfuseConfig.from_environment(environ)

    assert "LANGFUSE_SECRET_KEY" in str(error.value)
    assert "pk-lf-public-placeholder" not in str(error.value)


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("LANGFUSE_TRACING_ENVIRONMENT", "nightly"),
        ("LANGFUSE_TRACING_ENVIRONMENT", "langfuse-development"),
        ("PRALE_LANGFUSE_CAPTURE", "prompts"),
        ("PRALE_LANGFUSE_QUEUE_SIZE", "0"),
        ("PRALE_LANGFUSE_QUEUE_SIZE", "many"),
        ("PRALE_LANGFUSE_FLUSH_TIMEOUT_SECONDS", "soon"),
    ],
)
def test_an_unusable_value_is_refused_at_startup(key: str, value: str) -> None:
    environ = {
        "LANGFUSE_TRACING_ENABLED": "on",
        "LANGFUSE_PUBLIC_KEY": "pk",
        "LANGFUSE_SECRET_KEY": "sk",
        key: value,
    }

    with pytest.raises(ProjectConfigError) as error:
        LangfuseConfig.from_environment(environ)

    # The variable that is wrong is named; its value is not echoed.
    assert key in str(error.value)
    assert value not in str(error.value)


def test_the_configuration_is_described_without_any_credential() -> None:
    config = LangfuseConfig.from_environment(
        {
            "LANGFUSE_TRACING_ENABLED": "1",
            "LANGFUSE_PUBLIC_KEY": "pk-lf-live-public",
            "LANGFUSE_SECRET_KEY": SECRET,
            "LANGFUSE_TRACING_ENVIRONMENT": "staging",
            "PRALE_LANGFUSE_CAPTURE": "redacted",
        }
    )

    assert config is not None
    description = config.describe()
    assert SECRET not in description
    assert "pk-lf-live-public" not in description
    assert "staging" in description and "redacted" in description


def test_the_default_profile_uploads_no_payload_text() -> None:
    config = LangfuseConfig.from_environment(
        {"LANGFUSE_TRACING_ENABLED": "1", "LANGFUSE_PUBLIC_KEY": "pk", "LANGFUSE_SECRET_KEY": "sk"}
    )

    assert config is not None
    assert config.capture == "metadata"
    assert config.policy.uploads_text is False
