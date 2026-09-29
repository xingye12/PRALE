"""Local implementations of Pi-compatible ``read``, ``write``, ``edit`` and ``bash`` tools.

The tools deliberately live in integrations: they perform filesystem and process
I/O, while the runtime only knows the small :class:`AgentTool` protocol.
"""

import asyncio
import base64
import difflib
import os
import shutil
import signal
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final

from agent_harness.domain.entries import JsonValue
from agent_harness.runtime.tools import AgentTool, ToolExecutionResult

MAX_OUTPUT_LINES: Final = 2_000
MAX_OUTPUT_BYTES: Final = 50 * 1024
_IMAGE_HEADERS: Final = (
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"BM", "image/bmp"),
    (b"RIFF", "image/webp"),
)


def _error(message: str) -> ToolExecutionResult:
    return ToolExecutionResult(content=message, is_error=True)


def _path(cwd: Path, value: object) -> tuple[Path | None, str | None]:
    if not isinstance(value, str) or not value:
        return None, "path must be a non-empty string"
    candidate = Path(value)
    return (candidate if candidate.is_absolute() else cwd / candidate).resolve(), None


def _detect_image(data: bytes) -> str | None:
    for header, mime_type in _IMAGE_HEADERS:
        if data.startswith(header):
            if mime_type == "image/webp" and data[8:12] != b"WEBP":
                continue
            return mime_type
    return None


def _head(text: str) -> tuple[str, dict[str, JsonValue]]:
    """Keep complete leading lines within Pi's shared text-output limits."""
    lines = text.splitlines()
    # ``splitlines`` deliberately omits a terminal empty line, matching the
    # line-counting semantics used by Pi's truncation helper.
    kept: list[str] = []
    used = 0
    truncated_by: str | None = None
    for line in lines[:MAX_OUTPUT_LINES]:
        line_size = len(line.encode("utf-8")) + (1 if kept else 0)
        if used + line_size > MAX_OUTPUT_BYTES:
            truncated_by = "bytes"
            break
        kept.append(line)
        used += line_size
    if truncated_by is None and len(lines) > MAX_OUTPUT_LINES:
        truncated_by = "lines"
    if truncated_by is None:
        return text, {"truncated": False, "total_lines": len(lines), "total_bytes": len(text.encode())}
    return "\n".join(kept), {
        "truncated": True,
        "truncated_by": truncated_by,
        "total_lines": len(lines),
        "total_bytes": len(text.encode()),
        "output_lines": len(kept),
    }


def _tail(text: str) -> tuple[str, dict[str, JsonValue]]:
    lines = text.splitlines()
    kept: list[str] = []
    used = 0
    for line in reversed(lines[-MAX_OUTPUT_LINES:]):
        size = len(line.encode("utf-8")) + (1 if kept else 0)
        if used + size > MAX_OUTPUT_BYTES:
            break
        kept.append(line)
        used += size
    kept.reverse()
    output = "\n".join(kept)
    truncated = len(kept) < len(lines) or len(output.encode()) < len(text.encode())
    return output, {
        "truncated": truncated,
        "total_lines": len(lines),
        "total_bytes": len(text.encode()),
        "output_lines": len(kept),
        "output_bytes": len(output.encode()),
    }


class FileMutationQueue:
    """Per-resolved-file serialization shared by write and edit instances."""

    _locks: dict[Path, asyncio.Lock] = {}

    @classmethod
    def lock_for(cls, path: Path) -> asyncio.Lock:
        lock = cls._locks.get(path)
        if lock is None:
            lock = asyncio.Lock()
            cls._locks[path] = lock
        return lock


@dataclass(frozen=True, slots=True)
class ReadTool:
    cwd: Path | str
    name: str = "read"
    description: str = (
        "Read one text file or JPEG, PNG, GIF, WebP, or BMP image. Text output is limited to 2,000 lines or 50KiB; "
        "use offset and limit to paginate."
    )
    input_schema: JsonValue = field(
        default_factory=lambda: {
            "type": "object",
            "properties": {"path": {"type": "string"}, "offset": {"type": "number"}, "limit": {"type": "number"}},
            "required": ["path"],
        }
    )
    replay_policy: str = "safe"

    async def execute(self, arguments: JsonValue) -> ToolExecutionResult:
        if not isinstance(arguments, dict):
            return _error("read arguments must be an object")
        target, error = _path(Path(self.cwd).resolve(), arguments.get("path"))
        if error:
            return _error(error)
        offset, limit = arguments.get("offset", 1), arguments.get("limit")
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 1:
            return _error("offset must be a positive 1-indexed integer")
        if limit is not None and (not isinstance(limit, int) or isinstance(limit, bool) or limit < 1):
            return _error("limit must be a positive integer")
        assert target is not None
        try:
            data = await asyncio.to_thread(target.read_bytes)
        except OSError as exc:
            return _error(f"could not read {arguments['path']}: {exc}")
        mime_type = _detect_image(data)
        if mime_type is not None:
            return ToolExecutionResult(
                content=f"Read image file [{mime_type}]",
                details={
                    "path": str(target),
                    "mime_type": mime_type,
                    "image_base64": base64.b64encode(data).decode("ascii"),
                },
            )
        text = data.decode("utf-8", errors="replace")
        lines = text.split("\n")
        if text.endswith("\n"):
            lines.pop()
        if offset > len(lines) and not (offset == 1 and not lines):
            return _error(f"offset {offset} is beyond end of file ({len(lines)} lines total)")
        end_index = min(len(lines), offset - 1 + limit) if limit is not None else len(lines)
        selected = lines[offset - 1 : end_index]
        selected_text = "\n".join(selected)
        if text.endswith("\n") and end_index == len(lines):
            selected_text += "\n"
        output, truncation = _head(selected_text)
        shown = int(truncation.get("output_lines", len(selected)))
        if truncation.get("truncated") and shown == 0:
            return ToolExecutionResult(
                content=(
                    f"[Line {offset} exceeds the {MAX_OUTPUT_BYTES // 1024}KiB read limit. "
                    "Use bash to inspect a bounded byte range.]"
                ),
                details={"path": str(target), "total_lines": len(lines), "truncation": truncation},
            )
        next_offset = offset + shown
        more = next_offset <= len(lines)
        details: dict[str, JsonValue] = {"path": str(target), "total_lines": len(lines)}
        if more:
            details["next_offset"] = next_offset
            if output:
                output += "\n\n"
            if truncation["truncated"]:
                output += (
                    f"[Showing lines {offset}-{next_offset - 1} of {len(lines)}. Use offset={next_offset} to continue.]"
                )
            else:
                output += f"[{len(lines) - next_offset + 1} more lines in file. Use offset={next_offset} to continue.]"
        if truncation["truncated"]:
            details["truncation"] = truncation
        return ToolExecutionResult(content=output, details=details)


@dataclass(frozen=True, slots=True)
class WriteTool:
    cwd: Path | str
    name: str = "write"
    description: str = (
        "Create a UTF-8 file or completely overwrite an existing file, creating missing parent directories."
    )
    input_schema: JsonValue = field(
        default_factory=lambda: {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
        }
    )
    replay_policy: str = "never"

    async def execute(self, arguments: JsonValue) -> ToolExecutionResult:
        if not isinstance(arguments, dict):
            return _error("write arguments must be an object")
        target, error = _path(Path(self.cwd).resolve(), arguments.get("path"))
        content = arguments.get("content")
        if error:
            return _error(error)
        if not isinstance(content, str):
            return _error("content must be a string")
        assert target is not None
        async with FileMutationQueue.lock_for(target):
            try:
                await asyncio.to_thread(target.parent.mkdir, parents=True, exist_ok=True)
                await asyncio.to_thread(target.write_text, content, encoding="utf-8")
            except OSError as exc:
                return _error(f"could not write {arguments['path']}: {exc}")
        return ToolExecutionResult(content=f"Successfully wrote to {arguments['path']}", details={"path": str(target)})


@dataclass(frozen=True, slots=True)
class EditTool:
    cwd: Path | str
    name: str = "edit"
    description: str = "Make one or more exact, unique, non-overlapping replacements in an existing file."
    input_schema: JsonValue = field(
        default_factory=lambda: {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "edits": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"oldText": {"type": "string"}, "newText": {"type": "string"}},
                        "required": ["oldText", "newText"],
                    },
                },
            },
            "required": ["path", "edits"],
        }
    )
    replay_policy: str = "never"

    async def execute(self, arguments: JsonValue) -> ToolExecutionResult:
        if not isinstance(arguments, dict):
            return _error("edit arguments must be an object")
        target, error = _path(Path(self.cwd).resolve(), arguments.get("path"))
        edits_value = arguments.get("edits")
        if isinstance(edits_value, str):
            import json

            try:
                edits_value = json.loads(edits_value)
            except json.JSONDecodeError:
                pass
        if isinstance(edits_value, dict):
            edits_value = [edits_value]
        if error:
            return _error(error)
        if not isinstance(edits_value, list) or not edits_value:
            return _error("edits must contain at least one replacement")
        edits: list[tuple[str, str]] = []
        for edit in edits_value:
            if (
                not isinstance(edit, dict)
                or not isinstance(edit.get("oldText"), str)
                or not isinstance(edit.get("newText"), str)
            ):
                return _error("each edit must contain string oldText and newText")
            if not edit["oldText"]:
                return _error("oldText must not be empty")
            edits.append((edit["oldText"], edit["newText"]))
        assert target is not None
        async with FileMutationQueue.lock_for(target):
            try:
                raw = (await asyncio.to_thread(target.read_bytes)).decode("utf-8")
            except OSError as exc:
                return _error(f"could not edit {arguments['path']}: {exc}")
            bom, content = ("\ufeff", raw[1:]) if raw.startswith("\ufeff") else ("", raw)
            ending = "\r\n" if "\r\n" in content else "\r" if "\r" in content else "\n"
            normalized = content.replace("\r\n", "\n").replace("\r", "\n")
            locations: list[tuple[int, int, str]] = []
            for old, new in edits:
                start = normalized.find(old)
                if start < 0 or normalized.find(old, start + 1) >= 0:
                    return _error(f"oldText must match exactly once in the original file: {old!r}")
                locations.append((start, start + len(old), new))
            locations.sort()
            if any(end > next_start for (_, end, _), (next_start, _, _) in zip(locations, locations[1:])):
                return _error("edits must not overlap in the original file")
            pieces: list[str] = []
            cursor = 0
            for start, end, new in locations:
                pieces.extend((normalized[cursor:start], new))
                cursor = end
            changed = "".join([*pieces, normalized[cursor:]])
            final = bom + (changed.replace("\n", ending) if ending != "\n" else changed)
            try:
                await asyncio.to_thread(target.write_text, final, encoding="utf-8")
            except OSError as exc:
                return _error(f"could not edit {arguments['path']}: {exc}")
        patch = "".join(
            difflib.unified_diff(
                normalized.splitlines(True),
                changed.splitlines(True),
                fromfile=str(arguments["path"]),
                tofile=str(arguments["path"]),
            )
        )
        first_changed_line = normalized[: locations[0][0]].count("\n") + 1
        diff = "".join(difflib.ndiff(normalized.splitlines(True), changed.splitlines(True)))
        return ToolExecutionResult(
            content=f"Successfully replaced {len(edits)} block(s) in {arguments['path']}.",
            details={"path": str(target), "diff": diff, "patch": patch, "first_changed_line": first_changed_line},
        )


@dataclass(frozen=True, slots=True)
class BashTool:
    cwd: Path | str
    command_prefix: tuple[str, ...] = ()
    environment: Mapping[str, str] | None = None
    name: str = "bash"
    description: str = "Run an arbitrary shell command in the session working directory."
    input_schema: JsonValue = field(
        default_factory=lambda: {
            "type": "object",
            "properties": {"command": {"type": "string"}, "timeout": {"type": "number"}},
            "required": ["command"],
        }
    )
    replay_policy: str = "never"

    async def execute(self, arguments: JsonValue) -> ToolExecutionResult:
        if not isinstance(arguments, dict) or not isinstance(arguments.get("command"), str):
            return _error("command must be a string")
        timeout = arguments.get("timeout")
        if timeout is not None and (not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or timeout <= 0):
            return _error("timeout must be a positive number of seconds")
        shell = shutil.which("bash") or shutil.which("sh")
        if shell is None:
            return _error("no supported shell was found (looked for bash and sh)")
        command = " ".join((*self.command_prefix, arguments["command"]))
        env = os.environ.copy()
        if self.environment is not None:
            env.update(self.environment)
        process = await asyncio.create_subprocess_exec(
            shell,
            "-lc",
            command,
            cwd=str(Path(self.cwd).resolve()),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=os.name != "nt",
        )
        chunks: list[str] = []

        async def consume(stream: asyncio.StreamReader | None) -> None:
            if stream is None:
                return
            while data := await stream.read(4096):
                chunks.append(data.decode("utf-8", errors="replace"))

        readers = [asyncio.create_task(consume(process.stdout)), asyncio.create_task(consume(process.stderr))]
        try:
            await asyncio.wait_for(process.wait(), timeout=timeout)
        except asyncio.CancelledError:
            await self._kill_tree(process)
            await asyncio.gather(*readers, return_exceptions=True)
            raise
        except TimeoutError:
            await self._kill_tree(process)
            await asyncio.gather(*readers, return_exceptions=True)
            output, details = _tail("".join(chunks))
            return ToolExecutionResult(
                content=f"command timed out after {timeout} seconds\n{output}", is_error=True, details=details
            )
        await asyncio.gather(*readers)
        output, details = _tail("".join(chunks))
        if details["truncated"]:
            fd, log_path = tempfile.mkstemp(prefix="prale-bash-", suffix=".log")
            with os.fdopen(fd, "w", encoding="utf-8") as log:
                log.write("".join(chunks))
            details["full_output_path"] = log_path
        if process.returncode == 0:
            return ToolExecutionResult(content=output, details=details)
        return ToolExecutionResult(
            content=f"command exited with exit code {process.returncode}\n{output}", is_error=True, details=details
        )

    async def _kill_tree(self, process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
        if os.name != "nt":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:  # pragma: no cover - exercised on Windows
            process.kill()
        await process.wait()


def create_builtin_tools(
    cwd: Path | str,
    *,
    bash_environment: Mapping[str, str] | None = None,
    repository_explorer: AgentTool | None = None,
) -> tuple[AgentTool, ...]:
    """Return the Pi-compatible local tool set for a session working directory."""
    tools: tuple[AgentTool, ...] = (
        ReadTool(cwd),
        WriteTool(cwd),
        EditTool(cwd),
        BashTool(cwd, environment=bash_environment),
    )
    return (*tools, repository_explorer) if repository_explorer is not None else tools
