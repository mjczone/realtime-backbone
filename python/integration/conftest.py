import json
import subprocess
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest
from mjczone_realtime_tokens import TokenSigner, generate_signing_key
from testcontainers.core.container import DockerContainer
from testcontainers.core.network import Network
from testcontainers.core.wait_strategies import LogMessageWaitStrategy

REPO = Path(__file__).parents[2]
API_KEY = "it-api-key"
GRPC_KEY = "it-grpc-key"


@dataclass
class Stack:
    api_url: str
    grpc_address: str
    ws_url: str
    signer: TokenSigner


@pytest.fixture(scope="session")
def stack():
    signer = TokenSigner(generate_signing_key(), "rtb-it", "rtb-it-python")

    class Jwks(BaseHTTPRequestHandler):
        def do_GET(self):
            body = json.dumps(signer.jwks()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("0.0.0.0", 0), Jwks)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    jwks_url = f"http://host.docker.internal:{server.server_port}/.well-known/rtb-jwks.json"

    # The docker CLI honors .dockerignore; Testcontainers' builders can trip on dev data in .data/.
    image = "rtb-backbone:it-python"
    subprocess.run(
        ["docker", "build", "-q", "-f", str(REPO / "images/backbone/Dockerfile"), "-t", image, str(REPO)],
        check=True,
        capture_output=True,
    )
    with Network() as network:
        valkey = (
            DockerContainer("valkey/valkey:8.1.10-alpine")
            .with_network(network)
            .with_network_aliases("valkey")
            .with_command("valkey-server --maxmemory 128mb --maxmemory-policy noeviction --appendonly yes")
            .waiting_for(LogMessageWaitStrategy("Ready to accept connections"))
        )
        backbone = (
            DockerContainer(image)
            .with_network(network)
            .with_exposed_ports(8000, 9000, 10000)
            .with_kwargs(extra_hosts={"host.docker.internal": "host-gateway"})
            .with_envs(
                RTB_DOCTOR="strict",
                CENTRIFUGO_HTTP_API_KEY=API_KEY,
                CENTRIFUGO_GRPC_API_KEY=GRPC_KEY,
                CENTRIFUGO_ENGINE_REDIS_ADDRESS="redis://valkey:6379",
                CENTRIFUGO_CLIENT_ALLOWED_ORIGINS="*",
                CENTRIFUGO_CLIENT_TOKEN_JWKS_PUBLIC_ENDPOINT=jwks_url,
                CENTRIFUGO_CLIENT_TOKEN_AUDIENCE="rtb-it",
                CENTRIFUGO_CLIENT_TOKEN_ISSUER="rtb-it-python",
                CENTRIFUGO_CLIENT_SUBSCRIPTION_TOKEN_JWKS_PUBLIC_ENDPOINT=jwks_url,
                CENTRIFUGO_CLIENT_SUBSCRIPTION_TOKEN_AUDIENCE="rtb-it",
                CENTRIFUGO_CLIENT_SUBSCRIPTION_TOKEN_ISSUER="rtb-it-python",
            )
        )
        with valkey, backbone:
            host = backbone.get_container_host_ip()
            port = lambda p: backbone.get_exposed_port(p)
            api = f"http://{host}:{port(9000)}"
            deadline = time.monotonic() + 60
            while True:
                try:
                    if httpx.get(f"{api}/health", timeout=1).status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                if time.monotonic() > deadline:
                    raise RuntimeError("backbone did not become healthy:\n" + backbone.get_logs()[0].decode())
                time.sleep(0.5)
            yield Stack(f"{api}/api", f"{host}:{port(10000)}", f"ws://{host}:{port(8000)}/connection/websocket", signer)
    server.shutdown()
