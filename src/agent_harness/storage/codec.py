import json
from dataclasses import asdict
from typing import Any

from agent_harness.api.models import OperationResult
from agent_harness.domain.operations import OperationMeta, OperationState


def dumps(value: object) -> str:
    return json.dumps(_encode(value), separators=(",", ":"), sort_keys=True)


def loads(value: str) -> object:
    return _decode(json.loads(value))


def _encode(value: object) -> object:
    if isinstance(value, OperationMeta):
        return {"$type": "operation_meta", **asdict(value)}
    if isinstance(value, OperationState):
        return {"$type": "operation_state", **asdict(value)}
    if isinstance(value, OperationResult):
        return {"$type": "operation_result", **asdict(value)}
    if isinstance(value, dict):
        return {key: _encode(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_encode(item) for item in value]
    return value


def _decode(value: Any) -> object:
    if isinstance(value, list):
        return [_decode(item) for item in value]
    if not isinstance(value, dict):
        return value
    value = {key: _decode(item) for key, item in value.items()}
    value_type = value.pop("$type", None)
    if value_type == "operation_meta":
        return OperationMeta(**value)
    if value_type == "operation_state":
        return OperationState(**value)
    if value_type == "operation_result":
        return OperationResult(**value)
    if value_type is not None:
        raise ValueError(f"unknown storage type {value_type!r}")
    return value
