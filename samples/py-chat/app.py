"""A weather agent behind rtb-agui's run endpoints. Same API and page as mastra-chat and maf-chat.

AGENT=pydantic-ai (default) runs it on Pydantic AI, AGENT=langgraph on LangGraph.
"""

import importlib
import logging
import os
import re
import uuid
from pathlib import Path
from typing import Any

from rtb_agui import RunEndpoints, RunInfo, SinkResult, start_run
from rtb_publisher import GrpcTransport, HttpTransport, Publisher
from rtb_tokens import TokenSigner
from rtb_tokens.endpoints import TokenEndpoints, TokenUser
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, PlainTextResponse
from starlette.routing import Route

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")

TENANT = "demo"
WEB = Path(os.environ.get("RTB_WEB_DIR", Path(__file__).parents[1] / "chat-web" / "public"))
agent = importlib.import_module(
    {"pydantic-ai": "agent_pydantic_ai", "langgraph": "agent_langgraph"}[os.environ.get("AGENT", "pydantic-ai")]
)


def env(key: str, default: str) -> str:
    return os.environ.get(key) or default


# Dev only: the samples sign with the demo's dev key, so the dev stack's JWKS already covers them.
signer = TokenSigner(
    Path(env("RTB_DEV_KEY_FILE", str(Path(__file__).parents[2] / ".data/keys/signing.jwk"))).read_text(),
    env("RTB_TOKEN_AUDIENCE", "realtime-backbone-dev"),
    env("RTB_TOKEN_ISSUER", "rtb-demo"),
)
transport = (
    GrpcTransport(os.environ["RTB_GRPC_ADDRESS"], env("RTB_GRPC_KEY", "dev-grpc-key"))
    if os.environ.get("RTB_GRPC_ADDRESS")
    else HttpTransport(env("RTB_API_URL", "http://backbone:9000/api"), env("RTB_API_KEY", "dev-api-key"))
)
publisher = Publisher(source=f"py-chat-{os.environ.get('AGENT', 'pydantic-ai')}", transport=transport)


async def authenticate(request: Request) -> TokenUser | None:
    """Dev only: the caller says who they are. A real app uses its own auth."""
    user_id = request.headers.get("x-demo-user", "")
    return TokenUser(user_id, TENANT, {"name": user_id}) if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", user_id) else None


# The app's own stores. A real app keeps these in its database.
threads: dict[str, tuple[str, list[dict[str, Any]]]] = {}
run_owners: dict[str, str] = {}


def messages_from_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    by_id: dict[str, dict[str, Any]] = {}
    for e in events:
        t = e.get("type")
        if t == "TEXT_MESSAGE_START":
            m = {"id": e["messageId"], "role": "assistant", "content": ""}
            by_id[e["messageId"]] = m
            out.append(m)
        elif t == "TEXT_MESSAGE_CONTENT":
            by_id[e["messageId"]]["content"] += e["delta"]
        elif t == "TOOL_CALL_START":
            parent_id = e.get("parentMessageId") or e["toolCallId"]
            parent = by_id.get(parent_id)
            if parent is None:
                parent = by_id[parent_id] = {"id": parent_id, "role": "assistant"}
                out.append(parent)
            call = {"id": e["toolCallId"], "type": "function", "function": {"name": e["toolCallName"], "arguments": ""}}
            parent.setdefault("toolCalls", []).append(call)
            by_id[f"call:{e['toolCallId']}"] = call
        elif t == "TOOL_CALL_ARGS":
            by_id[f"call:{e['toolCallId']}"]["function"]["arguments"] += e["delta"]
        elif t == "TOOL_CALL_RESULT":
            out.append({"id": e["messageId"], "role": "tool", "toolCallId": e["toolCallId"], "content": e["content"]})
    return out


async def on_run_created(run: RunInfo) -> None:
    run_owners[run.run_id] = run.user_id
    owner = threads.get(run.thread_id, (run.user_id, []))[0]
    if owner != run.user_id:
        raise PermissionError("not your thread")
    threads[run.thread_id] = (run.user_id, list(run.input["messages"]))


async def on_run_finished(run: RunInfo, result: SinkResult) -> None:
    if run.thread_id in threads:
        threads[run.thread_id][1].extend(messages_from_events(result.events))


async def authorize(user: TokenUser, channel: str, parsed) -> bool:
    return parsed.topic != "run" or run_owners.get(parsed.id) == user.user_id


tokens = TokenEndpoints(signer, authenticate, authorize, cache_ttl=0)
runs = RunEndpoints(
    publisher,
    signer,
    authenticate,
    lambda inp, user: agent.events(inp),
    on_run_created=on_run_created,
    on_run_finished=on_run_finished,
    notify_user=True,
    skip_types=agent.SKIP_TYPES,
)


async def config(request: Request) -> JSONResponse:
    backbone = env("RTB_PUBLIC_BACKBONE_URL", "http://localhost:8000")
    return JSONResponse({"backboneUrl": backbone, "tenant": TENANT, "agentName": agent.NAME})


async def thread(request: Request) -> JSONResponse:
    user = await authenticate(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    owner, messages = threads.get(request.path_params["thread_id"], ("", []))
    return JSONResponse({"messages": messages if owner == user.user_id else []})


async def background_run(request: Request) -> JSONResponse:
    """A run nobody started from this page: the user hears about it on their own channel."""
    user = await authenticate(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    body = await request.json()
    owner, messages = threads.get(body["threadId"], ("", []))
    history = messages if owner == user.user_id else []
    prompt = {"id": str(uuid.uuid4()), "role": "user", "content": body["prompt"]}
    ref, _ = await start_run(
        publisher.for_tenant(TENANT),
        agent.events,
        {"threadId": body["threadId"], "messages": [*history, prompt]},
        user.user_id,
        notify_user=True,
        on_run_created=on_run_created,
        on_run_finished=on_run_finished,
        skip_types=agent.SKIP_TYPES,
    )
    return JSONResponse(ref.to_json(), status_code=202)


app = Starlette(
    routes=[
        Route("/healthz", lambda r: PlainTextResponse("ok")),
        Route("/", lambda r: FileResponse(WEB / "index.html")),
        Route("/app.js", lambda r: FileResponse(WEB / "app.js", media_type="text/javascript")),
        Route("/api/config", config),
        Route("/api/threads/{thread_id}", thread),
        Route("/api/background-run", background_run, methods=["POST"]),
        *tokens.routes(),
        *runs.routes(),
    ]
)
