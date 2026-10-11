import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from mjczone_realtime_tokens import TokenSigner, generate_signing_key
from mjczone_realtime_tokens.endpoints import JWKS_PATH, TokenEndpoints, TokenUser
from starlette.applications import Starlette
from starlette.testclient import TestClient

# A throwaway key; its kid was computed with jose's calculateJwkThumbprint in the TS SDK.
FIXED_JWK = {
    "kty": "EC",
    "x": "ovWaZluTB6WYLohUHcmnbudNEy8jh46NIOOCQiY3S1U",
    "y": "ACZ1UWFUy8fVH_5KwwYS6sXRkUNYZUcnvQRjycy2EoA",
    "crv": "P-256",
    "d": "0h8LR1S7xSIGbVkWvDyEH2TCDky6gIi5GSHVLUH1rU8",
}


def make(key=None, extra=None) -> TokenSigner:
    return TokenSigner(key or generate_signing_key(), "rtb", "test-app", additional_public_keys=extra)


def verify(token: str, jwks: dict) -> dict:
    kid = jwt.get_unverified_header(token)["kid"]
    jwk = next(k for k in jwks["keys"] if k["kid"] == kid)
    return jwt.decode(token, jwt.PyJWK(jwk).key, algorithms=["ES256"], audience="rtb", issuer="test-app")


def test_kid_matches_the_other_sdks():
    assert make(FIXED_JWK).kid == "N_nsSsT9RsDYSt1iPHaEeVT53AveIoPiDBVxzRuVxuM"


def test_connection_token_verifies():
    s = make()
    token = s.mint_connection_token("u1", info={"name": "Ann"})
    claims = verify(token, s.jwks())
    assert claims["sub"] == "u1" and claims["info"] == {"name": "Ann"} and claims["exp"] - claims["iat"] == 600
    assert jwt.get_unverified_header(token) == {"alg": "ES256", "kid": s.kid, "typ": "JWT"}


def test_subscription_token_verifies():
    s = make()
    claims = verify(s.mint_subscription_token("u1", "live:t-acme.x", ttl=60), s.jwks())
    assert claims["channel"] == "live:t-acme.x" and claims["exp"] - claims["iat"] == 60


def test_rotation_publishes_the_old_key():
    old = generate_signing_key()
    new = make(extra=[old])
    jwks = new.jwks()
    assert len(jwks["keys"]) == 2 and all("d" not in k for k in jwks["keys"])
    verify(make(old).mint_connection_token("u1"), jwks)


def test_accepts_pem():
    pem = (
        ec.generate_private_key(ec.SECP256R1())
        .private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        .decode()
    )
    assert len(make(pem).kid) == 43


def test_rejects_other_keys():
    with pytest.raises(ValueError):
        make({"kty": "RSA", "n": "x", "e": "AQAB", "d": "x"})


@pytest.fixture
def app():
    calls = {"n": 0}

    async def authenticate(request):
        u = request.headers.get("x-user")
        return TokenUser(u, "acme") if u else None

    async def authorize(user, channel, parsed):
        calls["n"] += 1
        return "secret" not in channel

    signer = make()
    endpoints = TokenEndpoints(signer, authenticate, authorize)
    client = TestClient(Starlette(routes=endpoints.routes()), headers={"x-user": "u1"})
    return client, signer, calls


def test_endpoints_mint_and_cache(app):
    client, _, calls = app
    token = client.post("/api/token/connection").json()["token"]
    assert verify(token, client.get(JWKS_PATH).json())["sub"] == "u1"
    for _ in range(3):
        r = client.post("/api/token/subscription", json={"channel": "replay:t-acme.run.r1"})
        assert r.status_code == 200
    assert calls["n"] == 1


def test_endpoints_check_before_the_authorizer(app):
    client, _, calls = app
    sub = lambda c: client.post("/api/token/subscription", json={"channel": c}).status_code
    assert sub("live:t-acme.a.b.c") == 400
    assert sub(42) == 400
    assert sub("live:t-acme.user#u1") == 400
    assert sub("live:t-globex.x") == 403
    assert calls["n"] == 0
    assert sub("live:t-acme.secret") == 403
    assert sub("live:global.maintenance") == 200
    assert calls["n"] == 2


def test_endpoints_need_a_user(app):
    client, _, _ = app
    assert client.post("/api/token/connection", headers={"x-user": ""}).status_code == 401
