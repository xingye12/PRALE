"""Provider-neutral adapters for structured long-term-memory extraction."""

import json
import re
from collections.abc import Awaitable, Callable

from agent_harness.api.errors import UnsupportedPromptMode
from agent_harness.domain.memory import (
    AtomicCandidate,
    DoctrineCandidate,
    OperatingDoctrine,
    SceneCandidate,
    SessionTraceArchive,
    WorkSceneMemory,
    validate_atomic_candidate,
    validate_doctrine_content,
    validate_scene_content,
)

JsonCompletion = Callable[[str, dict[str, object]], Awaitable[str]]


class JsonMemoryExtractor:
    """Turns a JSON-only completion function into the neutral extractor protocol.

    The caller owns model selection and transport. Invalid content is deliberately
    a `ValueError`, which the runtime treats as a non-retryable schema failure.
    """

    def __init__(
        self,
        complete: JsonCompletion,
        *,
        prompt_id: str = "memory-code-v1",
        prompt_version: int = 1,
        mode: str = "code",
    ) -> None:
        if mode != "code":
            raise UnsupportedPromptMode(f"memory prompt mode {mode!r} is not supported")
        self._complete = complete
        self.prompt_id = prompt_id
        self.prompt_version = prompt_version
        self.mode = mode

    async def extract_l1(self, archives: tuple[SessionTraceArchive, ...]) -> tuple[AtomicCandidate, ...]:
        raw = await self._complete("l1", {"archives": [_archive_payload(archive) for archive in archives]})
        value = _load_list(raw)
        candidates = tuple(
            AtomicCandidate(
                item["type"],
                item["content"],
                item.get("background", ""),
                item.get("scene_key", ""),
                item.get("priority", 0),
                item.get("confidence", 0.0),
                item["metadata"],
                tuple(item["source_record_ids"]),
                item.get("decision", "create"),
                tuple(item.get("supersedes_ids", [])),
                item.get("decision_reason", ""),
            )
            for item in value
        )
        for candidate in candidates:
            validate_atomic_candidate(candidate)
        return candidates

    async def extract_l2(
        self, l1: tuple[object, ...], scenes: tuple[WorkSceneMemory, ...]
    ) -> tuple[SceneCandidate, ...]:
        payload = {"l1": [_jsonable(item) for item in l1], "scenes": [_jsonable(scene) for scene in scenes]}
        created = await self._extract_l2_operation("l2_create", payload)
        updated = await self._extract_l2_operation("l2_update", payload)
        merged = await self._extract_l2_operation("l2_merge", payload)
        if any(candidate.expected_version is not None or candidate.merge_scene_ids for candidate in created):
            raise ValueError("l2_create response contains an update or merge")
        if any(candidate.expected_version is None or candidate.merge_scene_ids for candidate in updated):
            raise ValueError("l2_update response contains a create or merge")
        if any(not candidate.merge_scene_ids for candidate in merged):
            raise ValueError("l2_merge response lacks merged scene IDs")
        return (*created, *updated, *merged)

    async def _extract_l2_operation(self, operation: str, payload: dict[str, object]) -> tuple[SceneCandidate, ...]:
        value = _load_list(await self._complete(operation, payload))
        candidates = tuple(
            SceneCandidate(
                item["scenario_key"],
                item["content"],
                item.get("summary", ""),
                tuple(item["l1_ids"]),
                item["l1_high_watermark"],
                item.get("expected_version"),
                tuple(item.get("merge_scene_ids", [])),
                bool(item.get("persona_update_request", False)),
            )
            for item in value
        )
        for candidate in candidates:
            validate_scene_content(candidate.content)
        return candidates

    async def extract_l3(
        self, scenes: tuple[WorkSceneMemory, ...], current: OperatingDoctrine | None
    ) -> DoctrineCandidate | None:
        raw = await self._complete(
            "l3", {"scenes": [_jsonable(scene) for scene in scenes], "current": _jsonable(current)}
        )
        value = json.loads(raw)
        if value is None:
            return None
        if not isinstance(value, dict):
            raise ValueError("L3 response must be an object or null")
        candidate = DoctrineCandidate(
            value["content"], tuple(value["l2_ids"]), value["l2_high_watermark"], value.get("expected_version")
        )
        validate_doctrine_content(candidate.content)
        return candidate


def _load_list(raw: str) -> list[dict[str, object]]:
    value = json.loads(raw)
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise ValueError("memory extraction response must be a JSON array")
    return value


def _archive_payload(archive: SessionTraceArchive) -> dict[str, object]:
    return {
        "archive_id": archive.archive_id,
        "repository_id": archive.scope.repository_id,
        "operation_kind": archive.operation_kind,
        "trace_format_version": archive.trace_format_version,
        "items": [_jsonable(item) for item in archive.items],
        "ancestor_items": [_jsonable(item) for item in archive.ancestor_items],
        "coding_evidence": _coding_evidence(archive),
        "coding_memory_policy": {
            "retain": [
                "verified repository architecture, interfaces, invariants, and dependency boundaries",
                "accepted decisions with their rationale and constraints",
                "tool-verified test, build, migration, and failure outcomes",
                "reusable debugging methods, anti-patterns, and repository-relative artifacts",
            ],
            "reject": [
                "unverified assistant plans or speculative diagnoses",
                "raw source dumps, transient command chatter, and credentials",
                "a file path or symbol without its role, constraint, or outcome",
            ],
            "rules": [
                "Use tool outcomes as evidence, but record an outcome as fact only when it is explicit.",
                "Keep code references repository-relative and include the module, symbol, or test meaning.",
                "Do not convert a one-off patch recipe into work_method; executable workflows belong to SkillStore.",
            ],
        },
    }


_REPOSITORY_PATH = re.compile(r"(?<!\w)(?:[\w.-]+/)+[\w.-]+")


def _coding_evidence(archive: SessionTraceArchive) -> dict[str, object]:
    """Project a compact, source-addressable coding view from frozen L0.

    The raw trace remains authoritative. This projection prevents an extractor
    from treating a long tool transcript as a fact while preserving the files
    and verified outcomes that make coding memory useful.
    """
    files: set[str] = set()
    tool_outcomes: list[dict[str, object]] = []
    for item in archive.items:
        text = "\n".join(part for part in (item.content, json.dumps(item.payload, default=str)) if part)
        files.update(_REPOSITORY_PATH.findall(text))
        if item.role == "tool":
            tool_outcomes.append(
                {
                    "source_entry_id": item.source_entry_id,
                    "is_error": bool(item.payload.get("is_error", False)),
                    "excerpt": (item.content or "")[:800],
                }
            )
    return {
        "repository_id": archive.scope.repository_id,
        "files": sorted(files)[:30],
        "tool_outcomes": tool_outcomes[:20],
    }


def _jsonable(value: object) -> object:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, tuple):
        return [_jsonable(item) for item in value]
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    slots = getattr(value, "__slots__", ())
    return {name: _jsonable(getattr(value, name)) for name in slots}
