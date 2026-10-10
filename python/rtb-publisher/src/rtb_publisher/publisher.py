import asyncio
import json
import logging
import os
import random
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any

from rtb_contract import (
    MAX_ENVELOPE_BYTES,
    InvalidEnvelopeError,
    TenantContext,
    TenantGuardError,
    check_tenant,
    create_envelope,
    envelope_json,
    try_parse_channel,
)

from .transport import HttpTransport, PublishError, Transport

AuditLogger = Callable[[dict[str, Any]], None]

_audit_log = logging.getLogger("rtb.audit")


def default_audit(entry: dict[str, Any]) -> None:
    level = logging.INFO if entry["outcome"] == "ok" else logging.WARNING
    _audit_log.log(level, json.dumps({"msg": "rtb.audit", **entry}))


class EnvelopeTooLargeError(Exception):
    def __init__(self, size: int, channel: str):
        super().__init__(f"Envelope of {size} bytes for {channel} is over the {MAX_ENVELOPE_BYTES} byte cap")
        self.size = size
        self.channel = channel


@dataclass(frozen=True)
class RetryOptions:
    attempts: int = 8
    base_delay: float = 0.1
    max_delay: float = 5.0
    total: float = 30.0
    """Stop retrying after this many seconds, well inside Centrifugo's 5 minute idempotency window."""


@dataclass(frozen=True)
class PublishResult:
    envelope: dict[str, Any]
    offset: int | None = None
    """Stream position, for channels with history."""
    epoch: str | None = None


@dataclass
class _Core:
    source: str
    transport: Transport
    audit: AuditLogger
    retry: RetryOptions
    tails: dict[str, asyncio.Task[Any]] = field(default_factory=dict)


class Publisher:
    """
    Publishes envelopes. Publishes to the same channel are sent one at a time, in call order, so retries
    never reorder messages. Different channels publish concurrently.
    """

    def __init__(
        self,
        *,
        source: str,
        api_url: str | None = None,
        api_key: str = "",
        tenant: str | None = None,
        allow_global: bool | None = None,
        transport: Transport | None = None,
        audit: AuditLogger | None = None,
        retry: RetryOptions | None = None,
        timeout: float = 10.0,
    ):
        if transport is None:
            if not api_url:
                raise ValueError("pass api_url (HTTP) or a transport, such as GrpcTransport")
            transport = HttpTransport(api_url, api_key, timeout)
        if allow_global is None:
            allow_global = os.environ.get("RTB_ALLOW_GLOBAL") == "true"
        self._core = _Core(source, transport, audit or default_audit, retry or RetryOptions())
        self._context = TenantContext(tenant, allow_global)

    @property
    def tenant(self) -> str | None:
        return self._context.tenant

    def for_tenant(self, tenant: str) -> "Publisher":
        """A view of this publisher for another tenant. It shares the per-channel queues."""
        view = object.__new__(Publisher)
        view._core = self._core
        view._context = replace(self._context, tenant=tenant)
        return view

    def publish(
        self, channel: str, type: str, data: dict[str, Any], corr: str | None = None
    ) -> "asyncio.Future[PublishResult]":
        """
        Checks, builds and queues the envelope right away, then returns a future for the result. Calls made in
        order are queued in order, even when the caller doesn't await each one. Needs a running event loop.
        """
        loop = asyncio.get_running_loop()
        core = self._core
        parsed = try_parse_channel(channel)
        tenant = "global" if parsed and parsed.is_global else (self._context.tenant or "")
        base = {"component": core.source, "tenant": tenant, "channel": channel, "type": type, "ts": _now()}

        def failed(e: Exception) -> "asyncio.Future[PublishResult]":
            f: asyncio.Future[PublishResult] = loop.create_future()
            f.set_exception(e)
            return f

        guard = check_tenant(self._context, channel, tenant)
        if not guard.allow:
            core.audit({**base, "outcome": "denied", "reason": guard.reason})
            return failed(TenantGuardError(guard.reason or "", channel))
        try:
            envelope = create_envelope(type, tenant, core.source, data, corr)
        except InvalidEnvelopeError as e:
            core.audit({**base, "outcome": "denied", "reason": str(e)})
            return failed(e)
        body = envelope_json(envelope)
        if len(body) > MAX_ENVELOPE_BYTES:
            core.audit({**base, "id": envelope["id"], "outcome": "too_large", "reason": f"{len(body)} bytes"})
            return failed(EnvelopeTooLargeError(len(body), channel))

        async def send() -> PublishResult:
            attempts = 0

            def count() -> None:
                nonlocal attempts
                attempts += 1

            try:
                offset, epoch = await self._send_with_retry(channel, body, envelope["id"], count)
            except Exception as e:
                core.audit({**base, "id": envelope["id"], "outcome": "failed", "reason": str(e), "attempts": attempts})
                raise
            core.audit({**base, "id": envelope["id"], "outcome": "ok", "attempts": attempts})
            return PublishResult(envelope, offset, epoch)

        return self._enqueue(channel, send)

    async def idle(self) -> None:
        """Returns when every publish queued so far has finished."""
        while self._core.tails:
            await asyncio.wait(list(self._core.tails.values()))

    async def aclose(self) -> None:
        await self.idle()
        await self._core.transport.aclose()

    def _enqueue(self, channel: str, work: Callable[[], Awaitable[PublishResult]]) -> "asyncio.Task[PublishResult]":
        tails = self._core.tails
        prev = tails.get(channel)

        async def after() -> PublishResult:
            if prev is not None:
                await asyncio.wait([prev])
            return await work()

        task = asyncio.ensure_future(after())
        tails[channel] = task

        def done(t: asyncio.Task[Any]) -> None:
            if tails.get(channel) is t:
                del tails[channel]

        task.add_done_callback(done)
        return task

    async def _send_with_retry(
        self, channel: str, body: bytes, key: str, count: Callable[[], None]
    ) -> tuple[int | None, str | None]:
        r = self._core.retry
        started = time.monotonic()
        i = 0
        while True:
            count()
            try:
                return await self._core.transport.publish(channel, body, key)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                transient = not isinstance(e, PublishError) or e.transient
                delay = random.random() * min(r.max_delay, r.base_delay * 2**i)
                if not transient or i + 1 >= r.attempts or time.monotonic() - started + delay > r.total:
                    raise
                await asyncio.sleep(delay)
                i += 1


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
