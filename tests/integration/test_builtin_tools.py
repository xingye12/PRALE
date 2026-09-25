import asyncio
from pathlib import Path

from agent_harness.api.harness import Harness
from agent_harness.integrations.local_tools import BashTool, EditTool, ReadTool, WriteTool
from agent_harness.runtime.generation import AssistantResult, GenerationRequest, ToolCall
from agent_harness.storage.memory import MemoryStorage


def test_read_paginates_text_and_exposes_image_data(tmp_path: Path) -> None:
    async def scenario() -> None:
        text = tmp_path / "many.txt"
        text.write_text("one\ntwo\nthree\n", encoding="utf-8")
        result = await ReadTool(tmp_path).execute({"path": "many.txt", "offset": 2, "limit": 1})
        assert result.content == "two\n\n[1 more lines in file. Use offset=3 to continue.]"
        assert result.details == {"path": str(text), "next_offset": 3, "total_lines": 3}

        image = tmp_path / "pixel.png"
        image.write_bytes(b"\x89PNG\r\n\x1a\nrest")
        image_result = await ReadTool(tmp_path).execute({"path": "pixel.png"})
        assert image_result.content == "Read image file [image/png]"
        assert image_result.details is not None
        assert image_result.details["mime_type"] == "image/png"
        assert image_result.details["image_base64"].startswith("iVBOR")

    asyncio.run(scenario())


def test_write_creates_directories_and_edit_preserves_bom_and_crlf(tmp_path: Path) -> None:
    async def scenario() -> None:
        write = WriteTool(tmp_path)
        result = await write.execute({"path": "nested/file.txt", "content": "before"})
        assert result.content == "Successfully wrote to nested/file.txt"
        target = tmp_path / "nested" / "file.txt"
        assert target.read_text() == "before"

        target.write_bytes("\ufefffirst\r\nsecond\r\n".encode())
        edited = await EditTool(tmp_path).execute(
            {"path": "nested/file.txt", "edits": [{"oldText": "second", "newText": "changed"}]}
        )
        assert target.read_bytes() == "\ufefffirst\r\nchanged\r\n".encode()
        assert edited.details is not None
        assert edited.details["first_changed_line"] == 2
        assert "@@" in edited.details["patch"]

    asyncio.run(scenario())


def test_edit_requires_unique_non_overlapping_original_matches(tmp_path: Path) -> None:
    async def scenario() -> None:
        (tmp_path / "a.txt").write_text("repeat repeat", encoding="utf-8")
        result = await EditTool(tmp_path).execute(
            {"path": "a.txt", "edits": [{"oldText": "repeat", "newText": "done"}]}
        )
        assert result.is_error is True
        assert "exactly once" in result.content
        assert (tmp_path / "a.txt").read_text() == "repeat repeat"

    asyncio.run(scenario())


def test_bash_uses_cwd_returns_tail_and_reports_nonzero_exit(tmp_path: Path) -> None:
    async def scenario() -> None:
        result = await BashTool(tmp_path).execute({"command": "pwd"})
        assert result.is_error is False
        assert result.content.strip() == str(tmp_path)

        failed = await BashTool(tmp_path).execute({"command": "echo bad; exit 7"})
        assert failed.is_error is True
        assert "exit code 7" in failed.content
        assert "bad" in failed.content

        timed_out = await BashTool(tmp_path).execute({"command": "sleep 1", "timeout": 0.01})
        assert timed_out.is_error is True
        assert "timed out" in timed_out.content

    asyncio.run(scenario())


def test_builtin_tool_details_are_durably_settled_with_the_tool_result(tmp_path: Path) -> None:
    class Provider:
        def __init__(self) -> None:
            self.requests: list[GenerationRequest] = []

        async def generate(self, request: GenerationRequest) -> AssistantResult:
            self.requests.append(request)
            if len(self.requests) == 1:
                return AssistantResult("", {}, tool_calls=(ToolCall("call-1", "read", {"path": "note.txt"}),))
            return AssistantResult("done", {})

    async def scenario() -> None:
        (tmp_path / "note.txt").write_text("durable", encoding="utf-8")
        storage = MemoryStorage()
        lane = await (await Harness.open("session", storage, tools=(ReadTool(tmp_path),))).acquire_lane("main")
        await lane.prompt("read the note", operation_id="op")
        result = await lane.drive(Provider())
        entries = await storage.scan_branch(result.tip_id)
        tool_payload = next(entry.payload for entry in entries if entry.payload.get("role") == "tool")
        assert tool_payload["details"] == {"path": str(tmp_path / "note.txt"), "total_lines": 1}

    asyncio.run(scenario())
