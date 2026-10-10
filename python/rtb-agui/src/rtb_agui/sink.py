import asyncio
import json
from collections.abc import AsyncIterable, Iterable, Iterator
from dataclasses import dataclass, field
from typing import Any

from rtb_contract import MAX_ENVELOPE_BYTES
from rtb_publisher import DeltaBatcher, Publisher

Event = dict[str, Any]

# Room for the envelope fields around the AG-UI event.
_ENVELOPE_OVERHEAD = 1024


@dataclass
class SinkResult:
    events: list[Event] = field(default_factory=list)
    """Every event that was published, in order, after batching."""
    error: BaseException | None = None


def to_event(e: Any) -> Event:
    """An AG-UI event as a camelCase dict. Accepts dicts and ag_ui.core (pydantic) events."""
    if isinstance(e, dict):
        return e
    return e.model_dump(mode="json", by_alias=True, exclude_none=True)


class _Chunks:
    """Turns TEXT_MESSAGE_CHUNK events into TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT and TEXT_MESSAGE_END."""

    def __init__(self) -> None:
        self.open: str | None = None

    def feed(self, e: Event) -> Iterator[Event]:
        if e.get("type") == "TEXT_MESSAGE_CHUNK":
            message_id = e.get("messageId") or self.open
            if message_id != self.open:
                yield from self.close()
                yield {"type": "TEXT_MESSAGE_START", "messageId": message_id, "role": e.get("role") or "assistant"}
                self.open = message_id
            if e.get("delta"):
                yield {"type": "TEXT_MESSAGE_CONTENT", "messageId": message_id, "delta": e["delta"]}
            return
        yield from self.close()
        yield e

    def close(self) -> Iterator[Event]:
        if self.open is not None:
            yield {"type": "TEXT_MESSAGE_END", "messageId": self.open}
            self.open = None


async def publish_agent_run(
    publisher: Publisher,
    channel: str,
    run_id: str,
    events: AsyncIterable[Any],
    cancel: asyncio.Event | None = None,
    batch_interval: float = 0.075,
    skip_types: Iterable[str] = (),
) -> SinkResult:
    """
    Publishes an agent's AG-UI events to a run channel. It drops the agent's own RUN_STARTED (the run endpoint
    already published one), normalizes TEXT_MESSAGE_CHUNK, batches deltas, replaces events over the envelope cap
    with an rtb.oversize marker, and publishes RUN_ERROR if the agent fails or is cancelled without one. Event types in
    `skip_types` are not published, for example STATE_SNAPSHOT when the UI doesn't use shared state.
    Returns when everything is published; it never raises.
    """
    result = SinkResult()
    pending: list[asyncio.Future[Any]] = []
    ended = False

    def send(e: Event) -> None:
        nonlocal ended
        size = len(json.dumps(e, separators=(",", ":"), ensure_ascii=False).encode())
        if size + _ENVELOPE_OVERHEAD > MAX_ENVELOPE_BYTES:
            e = {"type": "CUSTOM", "name": "rtb.oversize", "value": {"type": e.get("type"), "bytes": size}}
        if e.get("type") in ("RUN_FINISHED", "RUN_ERROR"):
            ended = True
        result.events.append(e)
        pending.append(publisher.publish(channel, f"agui.{e.get('type')}", e, corr=run_id))

    skip = frozenset(skip_types)
    batcher = DeltaBatcher(send, batch_interval)
    chunks = _Chunks()

    async def consume() -> None:
        async for raw in events:
            e = to_event(raw)
            if e.get("type") == "RUN_STARTED" or e.get("type") in skip:
                continue
            for out in chunks.feed(e):
                batcher.push(out)
        for out in chunks.close():
            batcher.push(out)

    consumer = asyncio.ensure_future(consume())
    cancelled = asyncio.ensure_future(cancel.wait()) if cancel else None
    await asyncio.wait([f for f in (consumer, cancelled) if f], return_when=asyncio.FIRST_COMPLETED)
    code = "rtb.agent_error"
    if not consumer.done():
        consumer.cancel()
        await asyncio.wait([consumer])
        result.error, code = asyncio.CancelledError("Run cancelled"), "rtb.cancelled"
    elif consumer.exception() is not None:
        result.error = consumer.exception()
    if cancelled:
        cancelled.cancel()

    batcher.flush()
    if result.error is not None and not ended:
        send({"type": "RUN_ERROR", "message": str(result.error) or type(result.error).__name__, "code": code})
    await asyncio.gather(*pending, return_exceptions=True)
    return result
