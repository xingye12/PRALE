"""Opaque, stable cursor pagination shared by every read-only facade."""

import base64
import binascii
import json
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass

from agent_harness.api.errors import InvalidCursor

MIN_LIMIT = 1
MAX_LIMIT = 200


@dataclass(frozen=True, slots=True)
class Page[T]:
    """One page of an ordered read, with the cursor that continues it."""

    items: tuple[T, ...]
    next_cursor: str | None


def encode_cursor(values: Sequence[object]) -> str:
    payload = json.dumps(list(values), separators=(",", ":"), sort_keys=True)
    return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> list[object] | None:
    """Decode an opaque cursor; clients must not construct one themselves."""

    if cursor is None:
        return None
    try:
        raw = base64.urlsafe_b64decode((cursor + "=" * (-len(cursor) % 4)).encode())
        values = json.loads(raw.decode())
    except (binascii.Error, UnicodeDecodeError, ValueError) as error:
        raise InvalidCursor("cursor is not a valid pagination token") from error
    if not isinstance(values, list) or not all(isinstance(item, (int, str)) for item in values):
        raise InvalidCursor("cursor is not a valid pagination token")
    return values


async def paginate[T, K](
    cursor: str | None,
    limit: int,
    *,
    read: Callable[[K | None, int], Awaitable[tuple[T, ...]]],
    narrow: Callable[[list[object] | None], K | None],
    key: Callable[[T], list[object]],
) -> Page[T]:
    """Run one cursor-paginated read the same way everywhere.

    ``read`` is asked for one row beyond the page so that "is there more" is
    answered by the read itself rather than by a second count query, and the
    cursor is built from the last row actually returned — never from the probe
    row, which would skip an item.

    ``narrow`` translates the decoded cursor onto the read's sort key and is
    where a cursor from another query is rejected: a list of strings must not
    silently become a sort key of strings.
    """

    if limit < MIN_LIMIT or limit > MAX_LIMIT:
        raise ValueError(f"limit must be between {MIN_LIMIT} and {MAX_LIMIT}")
    rows = await read(narrow(decode_cursor(cursor)), limit + 1)
    items = tuple(rows[:limit])
    has_more = len(rows) > limit
    return Page(items, encode_cursor(key(items[-1])) if has_more and items else None)
