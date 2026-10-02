from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ValueAddress[T]:
    key: str


@dataclass(frozen=True, slots=True)
class ListAddress[T]:
    key: str


def lane_state(lane: str) -> ValueAddress[dict[str, object]]:
    return ValueAddress(f"lane/{lane}/state")


def lane_tip(lane: str) -> ValueAddress[str | None]:
    return ValueAddress(f"lane/{lane}/tip")


def lane_inbox(lane: str) -> ListAddress[dict[str, object]]:
    return ListAddress(f"lane/{lane}/inbox")


def lane_operations(lane: str) -> ListAddress[dict[str, object]]:
    """Append-only admission index; a lane's turns in the order they were admitted."""

    return ListAddress(f"lane/{lane}/operations")


def session_lanes() -> ListAddress[str]:
    """Append-only lane index, so a reader can enumerate a session's lanes."""

    return ListAddress("session/lanes")


def operation_meta(operation_id: str) -> ValueAddress[object]:
    return ValueAddress(f"operation/{operation_id}/meta")


def operation_state(operation_id: str) -> ValueAddress[object]:
    return ValueAddress(f"operation/{operation_id}/state")


def operation_result(operation_id: str) -> ValueAddress[object]:
    return ValueAddress(f"operation/{operation_id}/result")


def operation_lease(operation_id: str) -> ValueAddress[dict[str, str]]:
    return ValueAddress(f"operation/{operation_id}/drive_lease")


def operation_context_reductions(operation_id: str) -> ListAddress[dict[str, object]]:
    """Append-only audit of request-only reductions frozen into an intent."""

    return ListAddress(f"operation/{operation_id}/context_reductions")
