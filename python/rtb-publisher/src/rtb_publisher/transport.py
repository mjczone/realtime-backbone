import json
from typing import Protocol

import httpx

# Centrifugo codes worth retrying: internal (100), not available (108), too many requests (111).
TRANSIENT_CODES = frozenset({100, 108, 111})


class PublishError(Exception):
    def __init__(self, message: str, transient: bool, code: int | None = None):
        super().__init__(message)
        self.transient = transient
        self.code = code


class Transport(Protocol):
    """Sends one publication and returns its stream position (None, None for channels without history)."""

    async def publish(self, channel: str, data: bytes, idempotency_key: str) -> tuple[int | None, str | None]: ...

    async def aclose(self) -> None: ...


class HttpTransport:
    """POST {api_url}/publish with the X-API-Key header."""

    def __init__(self, api_url: str, api_key: str, timeout: float = 10.0, client: httpx.AsyncClient | None = None):
        self._url = api_url.rstrip("/") + "/publish"
        self._headers = {"X-API-Key": api_key, "Content-Type": "application/json"}
        self._client = client or httpx.AsyncClient(timeout=timeout)

    async def publish(self, channel: str, data: bytes, idempotency_key: str) -> tuple[int | None, str | None]:
        body = b'{"channel":%s,"data":%s,"idempotency_key":%s}' % (
            json.dumps(channel).encode(), data, json.dumps(idempotency_key).encode()
        )
        res = await self._client.post(self._url, content=body, headers=self._headers)
        if res.status_code >= 400:
            transient = res.status_code >= 500 or res.status_code == 429
            raise PublishError(f"HTTP {res.status_code} from Centrifugo API", transient)
        payload = res.json()
        if err := payload.get("error"):
            code = err.get("code")
            raise PublishError(f"Centrifugo error {code}: {err.get('message')}", code in TRANSIENT_CODES, code)
        result = payload.get("result") or {}
        return result.get("offset"), result.get("epoch")

    async def aclose(self) -> None:
        await self._client.aclose()


class GrpcTransport:
    """Centrifugo's gRPC API with `authorization: apikey <key>` metadata and optional mTLS. Needs rtb-publisher[grpc]."""

    def __init__(
        self,
        address: str,
        api_key: str,
        timeout: float = 10.0,
        client_cert_path: str | None = None,
        client_key_path: str | None = None,
        server_ca_path: str | None = None,
        secure: bool | None = None,
    ):
        import grpc

        from ._proto import api_pb2, api_pb2_grpc

        self._grpc = grpc
        self._pb = api_pb2
        target = address.removeprefix("http://").removeprefix("https://")
        use_tls = secure if secure is not None else (address.startswith("https://") or client_cert_path is not None)
        if use_tls:
            read = lambda p: open(p, "rb").read() if p else None  # noqa: E731
            creds = grpc.ssl_channel_credentials(read(server_ca_path), read(client_key_path), read(client_cert_path))
            self._channel = grpc.aio.secure_channel(target, creds)
        else:
            self._channel = grpc.aio.insecure_channel(target)
        self._stub = api_pb2_grpc.CentrifugoApiStub(self._channel)
        self._metadata = (("authorization", f"apikey {api_key}"),)
        self._timeout = timeout

    _TRANSIENT_STATUS = ("UNAVAILABLE", "DEADLINE_EXCEEDED", "RESOURCE_EXHAUSTED", "INTERNAL", "ABORTED")

    async def publish(self, channel: str, data: bytes, idempotency_key: str) -> tuple[int | None, str | None]:
        req = self._pb.PublishRequest(channel=channel, data=data, idempotency_key=idempotency_key)
        try:
            res = await self._stub.Publish(req, metadata=self._metadata, timeout=self._timeout)
        except self._grpc.aio.AioRpcError as e:
            name = e.code().name
            raise PublishError(f"gRPC {name}: {e.details()}", name in self._TRANSIENT_STATUS) from e
        if res.HasField("error"):
            code = res.error.code
            raise PublishError(f"Centrifugo error {code}: {res.error.message}", code in TRANSIENT_CODES, code)
        r = res.result
        if r.offset == 0 and r.epoch == "":
            return None, None
        return r.offset, r.epoch

    async def aclose(self) -> None:
        await self._channel.close()

