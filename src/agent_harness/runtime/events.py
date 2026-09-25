import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from agent_harness.domain.entries import JsonValue


@dataclass(frozen=True, slots=True)
class HarnessEvent:
    type: str
    lane: str | None
    operation_id: str | None
    data: JsonValue


EventListener = Callable[[HarnessEvent], Awaitable[None] | None]


class EventBus:
    """Best-effort observation: listener failures never affect the Agent loop."""

    def __init__(self) -> None:
        self._listeners: list[EventListener] = []
        self._reporting_listener_error = False

    def subscribe(self, listener: EventListener) -> Callable[[], None]:
        self._listeners.append(listener)

        def unsubscribe() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return unsubscribe

    async def emit(self, event: HarnessEvent) -> None:
        for listener in tuple(self._listeners):
            try:
                result = listener(event)
                if inspect.isawaitable(result):
                    await result
            except Exception as error:
                if self._reporting_listener_error:
                    continue
                self._reporting_listener_error = True
                try:
                    report = HarnessEvent(
                        "handler_error",
                        event.lane,
                        event.operation_id,
                        {"event_type": event.type, "error": str(error)},
                    )
                    for observer in tuple(self._listeners):
                        if observer is listener:
                            continue
                        try:
                            result = observer(report)
                            if inspect.isawaitable(result):
                                await result
                        except Exception:
                            continue
                finally:
                    self._reporting_listener_error = False
