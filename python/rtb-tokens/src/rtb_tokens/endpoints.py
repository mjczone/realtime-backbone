"""Token endpoints for Starlette and FastAPI. Needs rtb-tokens[starlette]."""

import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from rtb_contract import ParsedChannel, try_parse_channel
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from .signer import TokenSigner

JWKS_PATH = "/.well-known/rtb-jwks.json"


@dataclass(frozen=True)
class TokenUser:
    """The caller, as the app's own auth sees them."""

    user_id: str
    tenant: str
    info: dict[str, Any] | None = None


Authenticate = Callable[[Request], Awaitable[TokenUser | None]]
Authorize = Callable[[TokenUser, str, ParsedChannel], Awaitable[bool]]


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


@dataclass
class TokenEndpoints:
    """
    `authenticate` is the app's own session or auth check (None means 401). `authorize` decides whether the user may
    subscribe to a channel; it runs after the built-in checks: the channel parses, its tenant is the user's tenant
    (or it is global), and it is not a user (#) channel.
    """

    signer: TokenSigner
    authenticate: Authenticate
    authorize: Authorize
    cache_ttl: float = 30.0
    """How long an allowed authorize answer is cached, in seconds. 0 turns it off."""
    _allowed: dict[str, float] = field(default_factory=dict)

    async def connection(self, request: Request) -> Response:
        user = await self.authenticate(request)
        if user is None:
            return _error(401, "unauthenticated")
        return JSONResponse({"token": self.signer.mint_connection_token(user.user_id, info=user.info)})

    async def subscription(self, request: Request) -> Response:
        user = await self.authenticate(request)
        if user is None:
            return _error(401, "unauthenticated")
        try:
            body = await request.json()
        except ValueError:
            return _error(400, "body must be JSON with a channel")
        channel = body.get("channel") if isinstance(body, dict) else None
        parsed = try_parse_channel(channel) if isinstance(channel, str) else None
        if parsed is None:
            return _error(400, "invalid channel")
        if parsed.user_id is not None:
            return _error(400, "user channels use the connection token")
        if not parsed.is_global and parsed.tenant != user.tenant:
            return _error(403, "forbidden")
        key = f"{user.user_id}\0{user.tenant}\0{channel}"
        if self._allowed.get(key, 0) <= time.monotonic():
            if not await self.authorize(user, channel, parsed):
                return _error(403, "forbidden")
            if self.cache_ttl > 0:
                if len(self._allowed) > 10000:
                    self._allowed.clear()
                self._allowed[key] = time.monotonic() + self.cache_ttl
        return JSONResponse({"token": self.signer.mint_subscription_token(user.user_id, channel)})

    async def jwks(self, request: Request) -> Response:
        return JSONResponse(self.signer.jwks(), headers={"Cache-Control": "public, max-age=300"})

    def routes(self, prefix: str = "/api/token") -> list[Route]:
        """POST {prefix}/connection, POST {prefix}/subscription and GET /.well-known/rtb-jwks.json."""
        return [
            Route(f"{prefix}/connection", self.connection, methods=["POST"]),
            Route(f"{prefix}/subscription", self.subscription, methods=["POST"]),
            Route(JWKS_PATH, self.jwks, methods=["GET"]),
        ]
