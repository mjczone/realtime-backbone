import asyncio
import json
import logging
from collections.abc import AsyncIterable, Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any

from rtb_contract import Channels, new_id
from rtb_publisher import Publisher
from rtb_tokens import TokenSigner
from rtb_tokens.endpoints import Authenticate, TokenUser
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from .sink import SinkResult, publish_agent_run

log = logging.getLogger("rtb.agui")

# An agent is anything that turns a RunAgentInput (camelCase dict) into AG-UI events.
Agent = Callable[[dict[str, Any]], AsyncIterable[Any]]


@dataclass(frozen=True)
class RunInfo:
    input: dict[str, Any]
    """The input the agent runs with, including the client's messages."""
    run_id: str
    thread_id: str
    channel: str
    tenant: str
    user_id: str


@dataclass(frozen=True)
class RunRef:
    """What the run endpoint returns with 202, and what a client needs to join the run."""

    run_id: str
    thread_id: str
    channel: str
    offset: int
    epoch: str

    def to_json(self) -> dict[str, Any]:
        return {
            "runId": self.run_id,
            "threadId": self.thread_id,
            "channel": self.channel,
            "offset": self.offset,
            "epoch": self.epoch,
        }


OnRunCreated = Callable[[RunInfo], Awaitable[None]]
OnRunFinished = Callable[[RunInfo, SinkResult], Awaitable[None]]

_background: set[asyncio.Task[Any]] = set()


async def start_run(
    publisher: Publisher,
    agent: Agent,
    input: dict[str, Any],
    user_id: str,
    notify_user: bool = False,
    on_run_created: OnRunCreated | None = None,
    on_run_finished: OnRunFinished | None = None,
    cancel: asyncio.Event | None = None,
    skip_types: Iterable[str] = (),
) -> tuple[RunRef, "asyncio.Task[None]"]:
    """
    Starts an agent run on its own replay channel. Publishes RUN_STARTED, then drives the agent in the background.
    Returns once RUN_STARTED is published, with a task that ends when the run has ended. Needs a long-running process.
    """
    tenant = publisher.tenant
    if not tenant:
        raise ValueError("start_run needs a publisher with a tenant (publisher.for_tenant(t))")
    run_id = new_id()
    thread_id = input.get("threadId") or new_id()
    channel = Channels.run(tenant, run_id)
    full = {"messages": [], "tools": [], "context": [], "state": {}, "forwardedProps": {}, **input}
    full.update(threadId=thread_id, runId=run_id)
    info = RunInfo(full, run_id, thread_id, channel, tenant, user_id)

    if on_run_created:
        await on_run_created(info)
    started = await publisher.publish(
        channel, "agui.RUN_STARTED", {"type": "RUN_STARTED", "threadId": thread_id, "runId": run_id}, corr=run_id
    )
    ref = RunRef(run_id, thread_id, channel, started.offset or 0, started.epoch or "")
    if notify_user:
        try:
            await publisher.publish(Channels.user(tenant, user_id), "notice.run_started", ref.to_json())
        except Exception:
            log.warning("rtb: notice.run_started failed for %s", run_id, exc_info=True)

    async def drive() -> None:
        result = await publish_agent_run(publisher, channel, run_id, agent(full), cancel, skip_types=skip_types)
        if on_run_finished:
            try:
                await on_run_finished(info, result)
            except Exception:
                log.exception("rtb: on_run_finished failed for %s", run_id)

    task = asyncio.ensure_future(drive())
    _background.add(task)
    task.add_done_callback(_background.discard)
    return ref, task


@dataclass
class RunEndpoints:
    """POST {prefix} starts a run (202 with RunRef and a subscription token); POST {prefix}/{runId}/cancel cancels it."""

    publisher: Publisher
    signer: TokenSigner
    authenticate: Authenticate
    agent: Callable[[dict[str, Any], TokenUser], AsyncIterable[Any]]
    on_run_created: OnRunCreated | None = None
    on_run_finished: OnRunFinished | None = None
    notify_user: bool = False
    """Also publish notice.run_started to the user's live channel, so the user's other tabs can join."""
    skip_types: frozenset[str] = frozenset()
    """AG-UI event types not to publish, for example {"STATE_SNAPSHOT"} when the UI doesn't use shared state."""

    def __post_init__(self) -> None:
        self._active: dict[str, tuple[str, str, asyncio.Event]] = {}

    async def run(self, request: Request) -> Response:
        user = await self.authenticate(request)
        if user is None:
            return JSONResponse({"error": "unauthenticated"}, status_code=401)
        try:
            body = await request.json()
        except json.JSONDecodeError:
            body = None
        if not isinstance(body, dict) or not isinstance(body.get("messages", []), list):
            return JSONResponse({"error": "body must be RunAgentInput JSON"}, status_code=400)
        cancel = asyncio.Event()
        ref, task = await start_run(
            self.publisher.for_tenant(user.tenant),
            lambda full: self.agent(full, user),
            body,
            user.user_id,
            notify_user=self.notify_user,
            on_run_created=self.on_run_created,
            on_run_finished=self.on_run_finished,
            cancel=cancel,
            skip_types=self.skip_types,
        )
        self._active[ref.run_id] = (user.user_id, user.tenant, cancel)
        task.add_done_callback(lambda _: self._active.pop(ref.run_id, None))
        token = self.signer.mint_subscription_token(user.user_id, ref.channel)
        return JSONResponse({**ref.to_json(), "token": token}, status_code=202)

    async def cancel(self, request: Request) -> Response:
        user = await self.authenticate(request)
        if user is None:
            return JSONResponse({"error": "unauthenticated"}, status_code=401)
        run = self._active.get(request.path_params["run_id"])
        if run is None or run[:2] != (user.user_id, user.tenant):
            return JSONResponse({"error": "no such run"}, status_code=404)
        run[2].set()
        return JSONResponse({"cancelled": True})

    def routes(self, prefix: str = "/api/run") -> list[Route]:
        return [
            Route(prefix, self.run, methods=["POST"]),
            Route(f"{prefix}/{{run_id}}/cancel", self.cancel, methods=["POST"]),
        ]
