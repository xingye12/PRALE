"""Transport-facing helpers built entirely on the public harness API.

HTTP/WebSocket servers may map requests and connections to this module without
introducing framework objects into domain or runtime packages.
"""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import asdict
from typing import Protocol

from agent_harness.api.rpc import HarnessRpc
from agent_harness.runtime.events import HarnessEvent


class AuthenticationError(PermissionError):
    """A remote caller did not present valid service credentials."""


class Authenticator(Protocol):
    async def authenticate(self, credential: str | None) -> str: ...


class StaticTokenAuthenticator:
    """Small constant-time token authenticator for embedding applications."""

    def __init__(self, tokens: dict[str, str]) -> None:
        self._tokens = dict(tokens)

    async def authenticate(self, credential: str | None) -> str:
        if credential is None or credential not in self._tokens:
            raise AuthenticationError("invalid service credential")
        return self._tokens[credential]


class RemoteSubscription:
    """An async event stream with explicit disposal for WebSocket/SSE adapters."""

    def __init__(self, unsubscribe: Callable[[], None]) -> None:
        self._queue: asyncio.Queue[dict[str, object] | None] = asyncio.Queue()
        self._unsubscribe = unsubscribe
        self._closed = False

    async def next(self) -> dict[str, object] | None:
        return await self._queue.get()

    def publish(self, event: HarnessEvent) -> None:
        if not self._closed:
            self._queue.put_nowait({**asdict(event), "data": event.data})

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._unsubscribe()
            self._queue.put_nowait(None)


class AuthenticatedHarnessService:
    """Authentication and remote subscription boundary around ``HarnessRpc``."""

    def __init__(self, rpc: HarnessRpc, authenticate: Authenticator) -> None:
        self._rpc = rpc
        self._authenticate = authenticate

    async def dispatch(self, credential: str | None, method: str, params: dict[str, object]) -> dict[str, object]:
        await self._authenticate.authenticate(credential)
        return await self._rpc.dispatch(method, params)

    async def subscribe(self, credential: str | None, lane: str) -> RemoteSubscription:
        await self._authenticate.authenticate(credential)
        harness = self._rpc.harness
        selected_lane = await harness.acquire_lane(lane)
        subscription: RemoteSubscription | None = None

        def listener(event: HarnessEvent) -> Awaitable[None] | None:
            assert subscription is not None
            subscription.publish(event)
            return None

        _, unsubscribe = await selected_lane.watch(listener)
        subscription = RemoteSubscription(unsubscribe)
        return subscription
