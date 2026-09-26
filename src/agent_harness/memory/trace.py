"""Optional durable execution trace recorder for L0 audit enrichment."""

import hashlib
import json
from collections.abc import Callable
from typing import cast

from agent_harness.domain.entries import JsonValue, NewEntry
from agent_harness.domain.session import Session, SessionMutator
from agent_harness.domain.values import ListAddress
from agent_harness.storage.protocol import AppendList, InsertEntry


class TraceRecorder:
    def __init__(self, id_factory: Callable[[], str]) -> None:
        self._ids = id_factory

    async def append(self, session: Session, operation_id: str, event: dict[str, object]) -> str:
        """Append a redacted immutable trace event and its stable operation index together."""
        entry_id = self._ids()
        payload = _redact(event)

        async def write(mutator: SessionMutator) -> str:
            await mutator.commit(
                [
                    InsertEntry(
                        NewEntry(entry_id, None, "custom", cast(JsonValue, payload), custom_type="trace_record")
                    ),
                    AppendList(ListAddress(f"operation/{operation_id}/trace"), entry_id),
                ]
            )
            return entry_id

        return await session.mutate(write)


def _redact(event: dict[str, object]) -> dict[str, object]:
    secret_keys = {"authorization", "cookie", "password", "secret", "token", "api_key", "private_key"}
    result: dict[str, object] = {}
    for key, value in event.items():
        result[key] = "[REDACTED]" if key.lower() in secret_keys else value
    result["event_hash"] = hashlib.sha256(json.dumps(result, sort_keys=True, default=str).encode()).hexdigest()
    return result
