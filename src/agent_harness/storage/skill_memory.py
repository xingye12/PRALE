from collections.abc import Callable

from agent_harness.storage.skill_sqlite import SQLiteSkillStore


class InMemorySkillStore(SQLiteSkillStore):
    def __init__(self, *, id_factory: Callable[[], str] | None = None, now_ms: Callable[[], int] | None = None) -> None:
        super().__init__(":memory:", id_factory=id_factory, now_ms=now_ms)
