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


def operation_meta(operation_id: str) -> ValueAddress[object]:
    return ValueAddress(f"operation/{operation_id}/meta")


def operation_state(operation_id: str) -> ValueAddress[object]:
    return ValueAddress(f"operation/{operation_id}/state")


def operation_result(operation_id: str) -> ValueAddress[object]:
    return ValueAddress(f"operation/{operation_id}/result")


def operation_lease(operation_id: str) -> ValueAddress[dict[str, str]]:
    return ValueAddress(f"operation/{operation_id}/drive_lease")
