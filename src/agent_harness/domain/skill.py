"""Pure domain contract for versioned, owner-private Skill assets."""
# ruff: noqa

from dataclasses import dataclass, field
from hashlib import sha256
import re
from typing import Literal

from agent_harness.domain.memory import MemoryScope, SessionTraceArchive

SkillState = Literal["active", "disabled", "archived"]
SkillVisibility = Literal["private"]
SkillAction = Literal["no_op", "create", "update", "patch"]
SkillJobStatus = Literal["scheduled", "queued", "running", "retry_wait", "dead_letter", "completed"]
ArchiveReason = Literal["tool_calls", "bytes", "session_closed", "forced", "oversize"]
SkillSearchMode = Literal["keyword", "embedding", "hybrid"]


class VersionConflict(Exception):
    def __init__(self, current_version: int) -> None:
        super().__init__(f"skill version conflict; current version is {current_version}")
        self.current_version = current_version


@dataclass(frozen=True, slots=True)
class SkillScope:
    """Skill ownership exactly follows the archive's immutable memory scope."""

    repository_id: str

    @classmethod
    def from_memory_scope(cls, scope: MemoryScope) -> "SkillScope":
        return cls(scope.repository_id)

    @property
    def storage_key(self) -> str:
        return self.repository_id


@dataclass(frozen=True, slots=True)
class SkillFile:
    path: str
    content: bytes
    mime_type: str = "text/plain"

    @property
    def content_hash(self) -> str:
        return sha256(self.content).hexdigest()


@dataclass(frozen=True, slots=True)
class SkillVersion:
    skill_id: str
    version: int
    markdown: str
    manifest: str
    files: tuple[SkillFile, ...]
    content_hash: str
    created_at: int


@dataclass(frozen=True, slots=True)
class SkillAsset:
    skill_id: str
    scope: SkillScope
    name: str
    description: str
    triggers: tuple[str, ...]
    tags: tuple[str, ...]
    visibility: SkillVisibility
    state: SkillState
    current_version: int
    created_at: int
    updated_at: int


@dataclass(frozen=True, slots=True)
class SkillListing:
    skill_id: str
    name: str
    description: str
    triggers: tuple[str, ...]
    version: int
    state: SkillState


@dataclass(frozen=True, slots=True)
class SkillLoadout:
    skill_id: str
    version: int
    markdown: str
    manifest: str
    files: tuple[SkillFile, ...]
    content_hash: str
    resource_hashes: tuple[tuple[str, str], ...]


@dataclass(frozen=True, slots=True)
class SkillArchive:
    archive_id: str
    scope: SkillScope
    session_id: str
    source_archive_id: str
    payload_hash: str
    reason: ArchiveReason
    trace_format_version: str
    archives: tuple[SessionTraceArchive, ...]
    bytes_count: int
    successful_tool_calls: int
    turn_count: int
    created_at: int


@dataclass(frozen=True, slots=True)
class SkillExtractionJob:
    job_id: str
    scope: SkillScope
    archive_id: str
    status: SkillJobStatus
    not_before: int
    attempt: int
    created_at: int
    updated_at: int
    lease_id: str | None = None
    lease_until: int | None = None
    prompt_id: str | None = None
    prompt_version: int | None = None
    candidate_skill_ids: tuple[str, ...] = ()
    output_hash: str | None = None
    error_class: str | None = None


@dataclass(frozen=True, slots=True)
class SkillProposal:
    action: SkillAction
    evidence_entry_ids: tuple[str, ...] = ()
    skill_id: str | None = None
    expected_version: int | None = None
    markdown: str | None = None
    files: tuple[SkillFile, ...] = ()
    tags: tuple[str, ...] = ()
    patch_old: str | None = None
    patch_new: str | None = None
    reason: str = ""


@dataclass(frozen=True, slots=True)
class SkillConfig:
    tool_call_threshold: int = 5
    byte_threshold: int = 40 * 1024
    archive_max_bytes: int = 256 * 1024
    max_job_attempts: int = 3
    review_timeout_ms: int = 30_000
    max_candidates: int = 5
    listing_budget: int = 2_000
    loadout_budget: int = 16_000
    max_file_bytes: int = 64 * 1024
    allowed_mime_types: tuple[str, ...] = ("text/plain", "text/markdown", "application/json")
    auto_create: bool = True
    auto_update_active: bool = False
    allow_embedding: bool = False
    poll_ms: int = 100

    def __post_init__(self) -> None:
        if self.tool_call_threshold <= 0 or self.byte_threshold <= 0 or self.archive_max_bytes <= 0:
            raise ValueError("skill archive thresholds must be positive")
        if self.max_job_attempts <= 0 or self.review_timeout_ms <= 0 or self.poll_ms <= 0:
            raise ValueError("skill runtime timings must be positive")


_FRONTMATTER = re.compile(r"\A---\n(?P<meta>.*?)\n---\n(?P<body>.*)\Z", re.DOTALL)
_SECRET = re.compile(r"(?i)(?:api[_-]?key|secret|password|token)\s*[:=]\s*[^\s,;]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp)_[A-Za-z0-9_-]{16,}\b")
_INJECTION = re.compile(r"(?i)(ignore (?:all |previous )?instructions|system prompt|you are chatgpt|<\s*/?available_skills)")
_PII = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?<!\d)(?:\+?\d[ -]?){9,14}\d(?!\d)", re.I)
_HIGH_RISK_COMMAND = re.compile(r"(?im)^\s*(?:sudo\s+)?(?:rm\s+-[a-z]*r[a-z]*f|mkfs\b|dd\s+if=|curl\b[^\n|]*\|\s*(?:ba)?sh\b)")


def skill_content_hash(markdown: str, files: tuple[SkillFile, ...]) -> str:
    digest = sha256(markdown.encode())
    for item in sorted(files, key=lambda item: item.path):
        digest.update(item.path.encode())
        digest.update(item.content)
    return digest.hexdigest()


def validate_skill_proposal(proposal: SkillProposal, *, config: SkillConfig) -> tuple[str, str, tuple[str, ...]]:
    """Validate the local quality/security gate before any asset write."""
    if proposal.action not in {"create", "update", "patch"} or not proposal.markdown:
        raise ValueError("proposal has no complete skill content")
    if not proposal.evidence_entry_ids:
        raise ValueError("skill proposal needs successful source evidence")
    if proposal.action != "create" and (not proposal.skill_id or proposal.expected_version is None):
        raise ValueError("skill update needs id and expected version")
    match = _FRONTMATTER.match(proposal.markdown)
    if not match:
        raise ValueError("SKILL.md needs YAML frontmatter")
    fields: dict[str, str] = {}
    for line in match.group("meta").splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            fields[key.strip()] = value.strip().strip("[]").strip()
    missing = {"name", "description", "triggers", "version", "status"}.difference(fields)
    if missing:
        raise ValueError(f"SKILL.md missing frontmatter: {', '.join(sorted(missing))}")
    if fields["status"] != "active":
        raise ValueError("automatic skills must be active")
    body = match.group("body")
    headings = ("适用范围", "前置条件", "步骤", "验证：", "失败", "资源使用")
    if not all(word in body for word in headings):
        raise ValueError("SKILL.md must cover scope, prerequisites, steps, verification, failure and resources")
    entire = proposal.markdown + "\n" + "\n".join(file.content.decode("utf-8", "replace") for file in proposal.files)
    if _SECRET.search(entire):
        raise ValueError("skill contains secret material")
    if _PII.search(entire):
        raise ValueError("skill contains PII")
    if _INJECTION.search(entire):
        raise ValueError("skill contains prompt injection")
    if _HIGH_RISK_COMMAND.search(entire):
        raise ValueError("skill contains unverified high-risk command")
    paths: set[str] = set()
    for file in proposal.files:
        if not file.path or file.path.startswith("/") or ".." in file.path.split("/"):
            raise ValueError("invalid resource path")
        if file.path in paths or len(file.content) > config.max_file_bytes or file.mime_type not in config.allowed_mime_types:
            raise ValueError("invalid skill resource")
        paths.add(file.path)
    triggers = tuple(item.strip() for item in fields["triggers"].split(",") if item.strip())
    if not triggers or len(fields["description"]) > 500:
        raise ValueError("skill needs bounded description and triggers")
    return fields["name"], fields["description"], triggers


def patch_markdown(markdown: str, old: str, new: str) -> str:
    """Apply a reviewer patch only when its target has exactly one occurrence."""
    if not old:
        raise ValueError("skill patch requires a non-empty target")
    matches = markdown.count(old)
    if matches != 1:
        raise ValueError("skill patch target must match exactly once")
    return markdown.replace(old, new, 1)
