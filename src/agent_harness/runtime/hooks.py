import inspect
from collections import defaultdict
from collections.abc import Awaitable, Callable

from agent_harness.domain.entries import JsonValue

HookHandler = Callable[[JsonValue], Awaitable[JsonValue | None] | JsonValue | None]


class HookRegistry:
    """Ordered process-local hooks; durable state only records their consumed output."""

    def __init__(self) -> None:
        self._handlers: dict[str, list[HookHandler]] = defaultdict(list)

    def on(self, name: str, handler: HookHandler) -> Callable[[], None]:
        self._handlers[name].append(handler)

        def unsubscribe() -> None:
            if handler in self._handlers[name]:
                self._handlers[name].remove(handler)

        return unsubscribe

    async def run(
        self, name: str, event: JsonValue, *, fail_closed: bool = False, block_on_error: bool = False
    ) -> JsonValue:
        current = event
        for handler in tuple(self._handlers[name]):
            try:
                candidate = handler(current)
                if inspect.isawaitable(candidate):
                    candidate = await candidate
                if candidate is not None:
                    current = candidate
            except Exception:
                if fail_closed:
                    raise
                if block_on_error:
                    if not isinstance(current, dict):
                        raise RuntimeError("a blocking hook requires an object event")
                    return {**current, "block": True, "block_reason": f"{name} hook failed"}
        return current
