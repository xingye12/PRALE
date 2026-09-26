import asyncio

import pytest

from agent_harness.api.errors import UnsupportedPromptMode
from agent_harness.domain.entries import Entry
from agent_harness.domain.memory import MemoryScope, SessionTraceArchive, TraceItem
from agent_harness.integrations.memory_provider import JsonMemoryExtractor
from agent_harness.memory.runtime import _trace_item


def test_json_memory_extractor_validates_l1_candidate_schema() -> None:
    async def completion(stage: str, payload: dict[str, object]) -> str:
        assert stage == "l1"
        return '[{"type":"work_task","content":"task","metadata":{},"source_record_ids":["x"]}]'

    async def scenario() -> None:
        archive = SessionTraceArchive(
            "archive",
            MemoryScope("team", "agent", "user"),
            "session",
            "lane",
            "operation",
            "run",
            None,
            "tip",
            ("entry",),
            "hash",
            "conversation-v1",
            1,
            "content",
            (TraceItem("entry", 1, 1, "message", "user", "x", {}),),
        )
        with pytest.raises(ValueError, match="required metadata"):
            await JsonMemoryExtractor(completion).extract_l1((archive,))

    asyncio.run(scenario())


def test_trace_materialization_redacts_nested_sensitive_fields() -> None:
    item = _trace_item(
        Entry("entry", None, 1, 1, "message", {"headers": {"authorization": "secret"}, "content": "safe"})
    )
    assert item.payload["headers"]["authorization"].startswith("[REDACTED:")
    assert item.redacted_paths == ("headers.authorization",)


def test_trace_materialization_redacts_text_credentials() -> None:
    item = _trace_item(Entry("entry", None, 1, 1, "message", {"role": "tool", "content": "Bearer abc token=def"}))
    assert item.content == "Bearer [REDACTED] token=[REDACTED]"
    assert item.payload["content"] == "Bearer [REDACTED] token=[REDACTED]"
    assert item.redacted_paths == ("content",)


def test_only_code_memory_prompt_mode_is_accepted() -> None:
    async def completion(stage: str, payload: dict[str, object]) -> str:
        return "[]"

    with pytest.raises(UnsupportedPromptMode):
        JsonMemoryExtractor(completion, mode="chat")


def test_executable_work_method_is_rejected_as_skill_content() -> None:
    async def completion(stage: str, payload: dict[str, object]) -> str:
        return (
            '[{"type":"work_method","content":"Step 1. edit SKILL.md",'
            '"metadata":{"scope":"repo","method_type":"method"},"source_record_ids":["x"]}]'
        )

    async def scenario() -> None:
        with pytest.raises(ValueError, match="SkillStore"):
            await JsonMemoryExtractor(completion).extract_l1(())

    asyncio.run(scenario())


def test_l2_create_update_and_merge_are_extracted_in_separate_calls() -> None:
    calls: list[str] = []

    async def completion(stage: str, payload: dict[str, object]) -> str:
        calls.append(stage)
        return "[]"

    async def scenario() -> None:
        assert await JsonMemoryExtractor(completion).extract_l2((), ()) == ()
        assert calls == ["l2_create", "l2_update", "l2_merge"]

    asyncio.run(scenario())


def test_l1_prompt_receives_l0_ancestor_background() -> None:
    async def completion(stage: str, payload: dict[str, object]) -> str:
        archives = payload["archives"]
        assert isinstance(archives, list)
        assert archives[0]["ancestor_items"][0]["content"] == "earlier context"
        return "[]"

    async def scenario() -> None:
        item = TraceItem("new", 2, 2, "message", "user", "new", {})
        ancestor = TraceItem("old", 1, 1, "message", "assistant", "earlier context", {})
        archive = SessionTraceArchive(
            "archive", MemoryScope("team", "agent", "user"), "session", "lane", "op", "run", None, "new",
            ("new",), "hash", "conversation-v1", 1, "content", (item,), None, ("old",), False, (ancestor,),
        )
        assert await JsonMemoryExtractor(completion).extract_l1((archive,)) == ()

    asyncio.run(scenario())
