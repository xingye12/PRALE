# ruff: noqa
from typing import Protocol

from agent_harness.domain.memory import (
    AtomicCandidate,
    AtomicMemory,
    DoctrineCandidate,
    MemoryScope,
    OperatingDoctrine,
    PromotionJob,
    RecallBudget,
    RecallBundle,
    RecallQuery,
    SessionTraceArchive,
    SceneCandidate,
    WorkSceneMemory,
    WorkSceneMemory,
)


class MemoryStore(Protocol):
    async def capture_archive(self, archive: SessionTraceArchive) -> tuple[SessionTraceArchive, bool]: ...

    async def find_archive(
        self, scope: MemoryScope, session_id: str, operation_id: str, tip_id: str | None, source_hash: str
    ) -> SessionTraceArchive | None: ...

    async def create_or_wake_job(
        self,
        scope: MemoryScope,
        stage: str,
        watermark: int,
        not_before: int,
        prompt_id: str | None = None,
        prompt_version: int | None = None,
        prompt_mode: str | None = None,
        input_ids: tuple[str, ...] = (),
    ) -> PromotionJob: ...

    async def claim_job(self, now: int, lease_id: str, lease_ms: int) -> PromotionJob | None: ...

    async def complete_job(self, job_id: str, lease_id: str, output_hash: str | None = None) -> None: ...

    async def fail_job(self, job_id: str, lease_id: str, error_class: str, retry_at: int | None) -> None: ...

    async def unconsumed_items(self, scope: MemoryScope, after_store_seq: int) -> tuple[SessionTraceArchive, ...]: ...

    async def current_l1_watermark(self, scope: MemoryScope) -> int: ...

    async def stage_watermark(self, scope: MemoryScope, stage: str) -> int: ...

    async def last_completed_at(self, scope: MemoryScope, stage: str) -> int | None: ...

    async def advance_watermark(self, scope: MemoryScope, stage: str, watermark: int) -> None: ...

    async def register_prompt(self, mode: str, prompt_id: str, version: int) -> None: ...

    async def read_l1_since(self, scope: MemoryScope, watermark: int) -> tuple[AtomicMemory, ...]: ...

    async def apply_candidates(
        self, scope: MemoryScope, candidates: tuple[AtomicCandidate, ...], input_watermark: int
    ) -> None: ...

    async def search(self, scope: MemoryScope, query: RecallQuery, budget: RecallBudget) -> RecallBundle: ...

    async def read_l2(self, scope: MemoryScope) -> tuple[WorkSceneMemory, ...]: ...

    async def read_all_l2(self) -> tuple[WorkSceneMemory, ...]: ...

    async def read_l3(self, scope: MemoryScope) -> OperatingDoctrine | None: ...

    async def audit(self, scope: MemoryScope, event: str, data: dict[str, object]) -> None: ...

    async def write_scene(self, scope: MemoryScope, candidate: SceneCandidate, max_scenes: int = 20) -> None: ...

    async def write_doctrine(self, scope: MemoryScope, candidate: DoctrineCandidate) -> None: ...

    async def replay_dead_letter(self, scope: MemoryScope, job_id: str) -> None: ...

    async def delete_scope(self, scope: MemoryScope) -> None: ...

    async def gc(
        self, scope: MemoryScope, *, l0_before: int, l1_before: int, l2_before: int, audit_before: int
    ) -> dict[str, object]: ...

    async def rebuild_indexes(self, scope: MemoryScope) -> None: ...


class MemoryExtractor(Protocol):
    async def extract_l1(self, archives: tuple[SessionTraceArchive, ...]) -> tuple[AtomicCandidate, ...]: ...

    async def extract_l2(
        self, l1: tuple[object, ...], scenes: tuple[WorkSceneMemory, ...]
    ) -> tuple[SceneCandidate, ...]: ...

    async def extract_l3(
        self, scenes: tuple[WorkSceneMemory, ...], current: OperatingDoctrine | None
    ) -> DoctrineCandidate | None: ...


class EmbeddingProvider(Protocol):
    """Optional side-index provider; its failure must never block keyword recall."""

    @property
    def model_id(self) -> str: ...

    async def embed(self, texts: tuple[str, ...]) -> tuple[tuple[float, ...], ...]: ...
