"""Pure domain objects and validation for the long-term memory subsystem."""
# ruff: noqa

from dataclasses import dataclass, field
from hashlib import sha256
import re
from typing import Literal

MemoryLevel = Literal["l0", "l1", "l2", "l3"]
AtomicMemoryType = Literal["work_fact", "work_task", "work_method", "work_artifact"]
AtomicMemoryStatus = Literal["active", "superseded", "rejected"]
JobStage = Literal["l1", "l2", "l3"]
JobStatus = Literal["scheduled", "queued", "running", "retry_wait", "dead_letter", "completed"]
ConflictDecision = Literal["create", "supersede", "merge", "no_op"]


class PromotionConflict(Exception):
    """An optimistic L2/L3 replacement observed a different current version."""


@dataclass(frozen=True, slots=True)
class MemoryScope:
    team_id: str
    agent_id: str
    user_id: str | None
    task_id: str | None = None

    @property
    def visibility_key(self) -> tuple[str, str, str | None]:
        """The v1 access boundary; task is retrieval context, not authority."""
        return (self.team_id, self.agent_id, self.user_id)


@dataclass(frozen=True, slots=True)
class TraceItem:
    source_entry_id: str
    source_seq: int
    timestamp: int
    type: str
    role: str | None
    content: str | None
    payload: dict[str, object]
    redacted_paths: tuple[str, ...] = ()
    store_seq: int = 0


@dataclass(frozen=True, slots=True)
class SessionTraceArchive:
    archive_id: str
    scope: MemoryScope
    session_id: str
    lane: str
    operation_id: str
    operation_kind: str
    base_tip_id: str | None
    tip_id: str | None
    source_entry_ids: tuple[str, ...]
    source_entry_hash: str
    trace_format_version: str
    created_at: int
    content_hash: str
    items: tuple[TraceItem, ...]
    parent_archive_id: str | None = None
    ancestor_item_ids: tuple[str, ...] = ()
    parent_gap: bool = False
    ancestor_items: tuple[TraceItem, ...] = ()

    @property
    def capture_key(self) -> tuple[str, str, str | None, str]:
        return (self.session_id, self.operation_id, self.tip_id, self.source_entry_hash)


@dataclass(frozen=True, slots=True)
class AtomicMemory:
    memory_id: str
    scope: MemoryScope
    version: int
    status: AtomicMemoryStatus
    type: AtomicMemoryType
    content: str
    background: str
    scene_key: str
    priority: int
    confidence: float
    metadata: dict[str, object]
    source_record_ids: tuple[str, ...]
    source_hash: str
    supersedes_ids: tuple[str, ...]
    created_at: int
    updated_at: int
    last_confirmed_at: int
    content_hash: str


@dataclass(frozen=True, slots=True)
class WorkSceneMemory:
    scene_id: str
    scope: MemoryScope
    scenario_key: str
    version: int
    status: Literal["current", "dormant"]
    content: str
    summary: str
    heat: float
    l1_ids: tuple[str, ...]
    l1_high_watermark: int
    created_at: int
    updated_at: int
    content_hash: str
    persona_update_request: bool = False


@dataclass(frozen=True, slots=True)
class OperatingDoctrine:
    doctrine_id: str
    scope: MemoryScope
    version: int
    content: str
    l2_ids: tuple[str, ...]
    l2_high_watermark: int
    created_at: int
    updated_at: int
    content_hash: str


@dataclass(frozen=True, slots=True)
class PromotionJob:
    job_id: str
    scope: MemoryScope
    stage: JobStage
    input_high_watermark: int
    status: JobStatus
    not_before: int
    attempt: int
    created_at: int
    updated_at: int
    input_ids: tuple[str, ...] = ()
    lease_id: str | None = None
    lease_until: int | None = None
    error_class: str | None = None
    output_hash: str | None = None
    prompt_id: str | None = None
    prompt_version: int | None = None
    prompt_mode: str | None = None
    input_hash: str | None = None


@dataclass(frozen=True, slots=True)
class RecallQuery:
    text: str
    context_summary: str = ""
    task_id: str | None = None


@dataclass(frozen=True, slots=True)
class RecallBudget:
    timeout_ms: int = 5_000
    max_l1_items: int = 5
    min_score: float = 0.3
    max_item_chars: int = 1_200
    max_total_chars: int = 6_000
    include_l3: bool = True
    include_l2: bool = True
    type_quotas: dict[AtomicMemoryType, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.max_total_chars <= 0:
            raise ValueError("max_total_chars must be positive")


@dataclass(frozen=True, slots=True)
class RecallItem:
    id: str
    version: int
    level: MemoryLevel
    content: str
    score: float
    source_ids: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class RecallBundle:
    items: tuple[RecallItem, ...]
    content_hash: str
    total_chars: int
    degraded_reason: str | None = None


@dataclass(frozen=True, slots=True)
class MemoryRetentionPolicy:
    l0_days: int = 90
    l1_superseded_days: int = 180
    l2_dormant_days: int = 365
    audit_days: int = 400


@dataclass(frozen=True, slots=True)
class AtomicCandidate:
    type: AtomicMemoryType
    content: str
    background: str
    scene_key: str
    priority: int
    confidence: float
    metadata: dict[str, object]
    source_record_ids: tuple[str, ...]
    decision: ConflictDecision = "create"
    supersedes_ids: tuple[str, ...] = ()
    decision_reason: str = ""


@dataclass(frozen=True, slots=True)
class SceneCandidate:
    scenario_key: str
    content: str
    summary: str
    l1_ids: tuple[str, ...]
    l1_high_watermark: int
    expected_version: int | None = None
    merge_scene_ids: tuple[str, ...] = ()
    persona_update_request: bool = False


@dataclass(frozen=True, slots=True)
class DoctrineCandidate:
    content: str
    l2_ids: tuple[str, ...]
    l2_high_watermark: int
    expected_version: int | None = None


def content_hash(value: str) -> str:
    return sha256(value.encode()).hexdigest()


def validate_atomic_candidate(candidate: AtomicCandidate) -> None:
    required = {
        "work_task": {"owner", "deadline", "status"},
        "work_method": {"scope", "method_type"},
        "work_artifact": {"artifact_type", "artifact_ref"},
        "work_fact": {"work_object", "status", "activity_start_time", "activity_end_time"},
    }[candidate.type]
    missing = required.difference(candidate.metadata)
    if missing:
        raise ValueError(f"{candidate.type} is missing required metadata: {', '.join(sorted(missing))}")
    if not candidate.content.strip() or len(candidate.content) > 2_000:
        raise ValueError("atomic memory content must be non-empty and bounded")
    lowered = candidate.content.lower()
    if any(marker in lowered for marker in ("private key", "authorization:", "set-cookie:", "password=", "api_key=")):
        raise ValueError("atomic memory contains sensitive material")
    if not 0 <= candidate.confidence <= 1:
        raise ValueError("memory confidence must be between zero and one")
    if candidate.decision not in {"create", "supersede", "merge", "no_op"}:
        raise ValueError("invalid memory conflict decision")
    if candidate.decision in {"supersede", "merge"} and not candidate.supersedes_ids:
        raise ValueError("supersede/merge decisions require replaced memory IDs")
    if candidate.type == "work_method":
        method_lower = candidate.content.lower()
        executable_markers = ("skill.md", "prerequisite", "verification step", "step 1", "1.", "2.")
        if any(marker in method_lower for marker in executable_markers):
            raise ValueError("executable method belongs to SkillStore, not L1 work_method")


def validate_scene_content(content: str) -> None:
    sections = (
        "工作场景",
        "适用条件",
        "核心 SOP",
        "判断逻辑",
        "禁忌与反模式",
        "关键事实依据",
        "相关任务与资产",
        "演化记录",
        "待确认问题",
    )
    if len(content) > 1_500 or any(section not in content for section in sections):
        raise ValueError("invalid work-scene markdown")


def validate_doctrine_content(content: str) -> None:
    sections = (
        "Operating Thesis",
        "Core Principles",
        "Reusable SOPs",
        "Decision Logic",
        "Boundaries & Anti-patterns",
        "Agent Rules",
    )
    forbidden = ("password", "secret", "api key", "TODO", "待办", "blocked", "deadline", "owner")
    if len(content) > 1_200 or any(section not in content for section in sections):
        raise ValueError("invalid operating doctrine markdown")
    if any(token in content.lower() for token in forbidden):
        raise ValueError("operating doctrine contains disallowed transient or sensitive content")
    if re.search(r"\b[A-Za-z0-9_.-]+==\d", content):
        raise ValueError("operating doctrine contains an unstable exact dependency version")
