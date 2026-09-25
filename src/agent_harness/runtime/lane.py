import time
import uuid
from collections.abc import Callable

from agent_harness.api.errors import LaneBusy
from agent_harness.api.models import LaneSnapshot, OperationAdmission, OperationResult
from agent_harness.domain.operations import OperationMeta, OperationState
from agent_harness.domain.session import Session, SessionMutator
from agent_harness.domain.values import lane_state, lane_tip, operation_meta, operation_result, operation_state
from agent_harness.storage.protocol import SetValue


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


class Lane:
    """One serial operation lane. Admission is durable; Drive execution comes later."""

    def __init__(
        self,
        name: str,
        session: Session,
        id_factory: Callable[[], str] | None = None,
        now_ms: Callable[[], int] | None = None,
    ) -> None:
        self.name = name
        self._session = session
        self._id_factory = id_factory or (lambda: str(uuid.uuid4()))
        self._now_ms = now_ms or _now_ms

    async def attach(self) -> None:
        """Durably create the lane's idle projection if this is its first attachment."""

        async def create_if_absent(mutator: SessionMutator) -> None:
            if await mutator.get_value(lane_state(self.name)) is not None:
                return
            await mutator.commit(
                [
                    SetValue(lane_tip(self.name), None),
                    SetValue(lane_state(self.name), {"current_operation_id": None, "last_operation_id": None}),
                ]
            )

        await self._session.mutate(create_if_absent)

    async def snapshot(self) -> LaneSnapshot:
        state = await self._load_lane_state()
        return LaneSnapshot(
            name=self.name,
            tip_id=await self._session.get_value(lane_tip(self.name)),
            operation_id=state["current_operation_id"],
            last_operation_id=state["last_operation_id"],
        )

    async def prompt(self, prompt: str, operation_id: str | None = None) -> OperationAdmission:
        return await self._admit("run", {"prompt": prompt}, operation_id)

    async def compact(self, operation_id: str | None = None) -> OperationAdmission:
        return await self._admit("compaction", {}, operation_id)

    async def navigate(self, target_id: str | None, operation_id: str | None = None) -> OperationAdmission:
        return await self._admit("navigation", {"target_id": target_id}, operation_id)

    async def get_result(self, operation_id: str) -> OperationResult | None:
        value = await self._session.get_value(operation_result(operation_id))
        return value if isinstance(value, OperationResult) else None

    async def _load_lane_state(self) -> dict[str, str | None]:
        value = await self._session.get_value(lane_state(self.name))
        if value is None:
            return {"current_operation_id": None, "last_operation_id": None}
        if not isinstance(value, dict):
            raise RuntimeError(f"invalid durable lane state for {self.name!r}")
        return {
            "current_operation_id": value.get("current_operation_id"),
            "last_operation_id": value.get("last_operation_id"),
        }

    async def _admit(self, kind: str, request: dict[str, object], supplied_id: str | None) -> OperationAdmission:
        operation_id = supplied_id or self._id_factory()
        started_at = self._now_ms()

        async def admit(mutator: SessionMutator) -> OperationAdmission:
            state_value = await mutator.get_value(lane_state(self.name))
            state = state_value or {"current_operation_id": None, "last_operation_id": None}
            current = state.get("current_operation_id")
            if current is not None:
                raise LaneBusy(self.name, current)
            tip = await mutator.get_value(lane_tip(self.name))
            meta = OperationMeta(operation_id, self.name, tip, started_at, kind, request)
            durable_state = OperationState(at="starting", control="running", data={})
            await mutator.commit(
                [
                    SetValue(operation_meta(operation_id), meta),
                    SetValue(operation_state(operation_id), durable_state),
                    SetValue(
                        lane_state(self.name),
                        {"current_operation_id": operation_id, "last_operation_id": state.get("last_operation_id")},
                    ),
                ]
            )
            return OperationAdmission(operation_id=operation_id, kind=kind, started_at=started_at)

        return await self._session.mutate(admit)
