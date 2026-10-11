import asyncio
from collections.abc import Callable
from typing import Any

Event = dict[str, Any]


def _key(e: Event) -> str | None:
    if e.get("type") == "TEXT_MESSAGE_CONTENT" and e.get("messageId"):
        return f"text:{e['messageId']}"
    if e.get("type") == "TOOL_CALL_ARGS" and e.get("toolCallId"):
        return f"args:{e['toolCallId']}"
    return None


class DeltaBatcher:
    """
    Joins consecutive TEXT_MESSAGE_CONTENT deltas for one messageId, and TOOL_CALL_ARGS deltas for one toolCallId,
    into one event. Any other event flushes the buffer first, so order is kept. `emit` is called synchronously,
    in order. Events are AG-UI events as dicts with camelCase keys.
    """

    def __init__(self, emit: Callable[[Event], None], interval: float = 0.075, max_bytes: int = 32768):
        self._emit = emit
        self._interval = interval
        self._max_bytes = max_bytes
        self._key: str | None = None
        self._first: Event | None = None
        self._parts: list[str] = []
        self._bytes = 0
        self._timer: asyncio.TimerHandle | None = None

    def push(self, e: Event) -> None:
        key = _key(e)
        if key is None:
            self.flush()
            self._emit(e)
            return
        if self._key is not None and self._key != key:
            self.flush()
        delta = e.get("delta") or ""
        if self._key is None:
            self._key, self._first = key, e
            self._timer = asyncio.get_running_loop().call_later(self._interval, self.flush)
        self._parts.append(delta)
        self._bytes += len(delta.encode())
        if self._bytes >= self._max_bytes:
            self.flush()

    def flush(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        if self._key is None or self._first is None:
            return
        e = {**self._first, "delta": "".join(self._parts)}
        self._key, self._first, self._parts, self._bytes = None, None, [], 0
        self._emit(e)
