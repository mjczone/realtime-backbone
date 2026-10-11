import base64
import hashlib
import json
import time
from typing import Any

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

Jwk = dict[str, Any]


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _compact(obj: Any) -> str:
    return _b64(json.dumps(obj, separators=(",", ":")).encode())


def _thumbprint(x: str, y: str) -> str:
    canonical = json.dumps({"crv": "P-256", "kty": "EC", "x": x, "y": y}, separators=(",", ":"))
    return _b64(hashlib.sha256(canonical.encode()).digest())


def _public_jwk(x: str, y: str, kid: str) -> Jwk:
    return {"kty": "EC", "crv": "P-256", "x": x, "y": y, "kid": kid, "alg": "ES256", "use": "sig"}


def _xy(key: ec.EllipticCurvePrivateKey) -> tuple[str, str]:
    n = key.public_key().public_numbers()
    return _b64(n.x.to_bytes(32, "big")), _b64(n.y.to_bytes(32, "big"))


def _load(private_key: Jwk | str) -> tuple[ec.EllipticCurvePrivateKey, str | None]:
    if isinstance(private_key, str) and private_key.lstrip().startswith("-----BEGIN"):
        key = serialization.load_pem_private_key(private_key.encode(), password=None)
        if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
            raise ValueError("private_key must be an EC P-256 key")
        return key, None
    jwk = json.loads(private_key) if isinstance(private_key, str) else private_key
    if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256" or "d" not in jwk:
        raise ValueError("private_key must be an EC P-256 private JWK")
    numbers = ec.EllipticCurvePrivateNumbers(
        int.from_bytes(_unb64(jwk["d"]), "big"),
        ec.EllipticCurvePublicNumbers(
            int.from_bytes(_unb64(jwk["x"]), "big"), int.from_bytes(_unb64(jwk["y"]), "big"), ec.SECP256R1()
        ),
    )
    return numbers.private_key(), jwk.get("kid")


def generate_signing_key() -> Jwk:
    """A new ES256 key as a JWK with a thumbprint kid. For dev and rotation scripts."""
    key = ec.generate_private_key(ec.SECP256R1())
    x, y = _xy(key)
    d = _b64(key.private_numbers().private_value.to_bytes(32, "big"))
    return {"kty": "EC", "crv": "P-256", "x": x, "y": y, "d": d, "kid": _thumbprint(x, y), "alg": "ES256"}


class TokenSigner:
    """Signs ES256 JWTs for Centrifugo and exposes the public half as a JWKS."""

    def __init__(
        self,
        private_key: Jwk | str,
        audience: str,
        issuer: str,
        kid: str | None = None,
        additional_public_keys: list[Jwk] | None = None,
        connection_ttl: int = 600,
        subscription_ttl: int = 600,
    ):
        self._key, jwk_kid = _load(private_key)
        x, y = _xy(self._key)
        self.kid = kid or jwk_kid or _thumbprint(x, y)
        self._audience = audience
        self._issuer = issuer
        self._connection_ttl = connection_ttl
        self._subscription_ttl = subscription_ttl
        keys = [_public_jwk(x, y, self.kid)]
        for k in additional_public_keys or []:
            if not k.get("kid"):
                raise ValueError("every additional public key needs a kid")
            keys.append(_public_jwk(k["x"], k["y"], k["kid"]))
        self._jwks = {"keys": keys}

    def mint_connection_token(self, sub: str, ttl: int | None = None, info: dict[str, Any] | None = None) -> str:
        """`info` is shown to other subscribers of presence channels. Put a display name there and nothing more."""
        claims: dict[str, Any] = {"info": info} if info is not None else {}
        return self._sign(claims, sub, ttl or self._connection_ttl)

    def mint_subscription_token(self, sub: str, channel: str, ttl: int | None = None) -> str:
        return self._sign({"channel": channel}, sub, ttl or self._subscription_ttl)

    def jwks(self) -> dict[str, list[Jwk]]:
        return {"keys": [dict(k) for k in self._jwks["keys"]]}

    def _sign(self, claims: dict[str, Any], sub: str, ttl: int) -> str:
        now = int(time.time())
        payload = {**claims, "sub": sub, "aud": self._audience, "iss": self._issuer, "iat": now, "exp": now + ttl}
        header = {"alg": "ES256", "kid": self.kid, "typ": "JWT"}
        signing_input = f"{_compact(header)}.{_compact(payload)}"
        r, s = decode_dss_signature(self._key.sign(signing_input.encode(), ec.ECDSA(hashes.SHA256())))
        return f"{signing_input}.{_b64(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"
