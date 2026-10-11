import json
import re
from datetime import UTC, datetime
from typing import Any

from .ulid import new_id

MAX_ENVELOPE_BYTES = 65536
RESERVED_FAMILIES = ("agui", "job", "entity", "notice", "system")

_ULID = re.compile(r"[0-9A-HJKMNP-TV-Z]{26}")
_TYPE = re.compile(r"[a-z][a-z0-9]*\.[A-Za-z0-9_.]+")
_TENANT = re.compile(r"[A-Za-z0-9_-]{1,64}")
_SOURCE = re.compile(r"[A-Za-z0-9_.-]{1,128}")
_TS = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z")


class InvalidEnvelopeError(ValueError):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def create_envelope(
    type: str, tenant: str, source: str, data: dict[str, Any], corr: str | None = None
) -> dict[str, Any]:
    """Builds an envelope dict, filling in v, id and ts."""
    env: dict[str, Any] = {"v": 1, "id": new_id(), "type": type, "tenant": tenant, "source": source, "ts": _now()}
    if corr is not None:
        env["corr"] = corr
    env["data"] = data
    problem = validate_envelope(env)
    if problem:
        raise InvalidEnvelopeError(f"Invalid envelope: {problem}")
    return env


def _matches(value: Any, pattern: re.Pattern[str]) -> bool:
    return isinstance(value, str) and bool(pattern.fullmatch(value))


def validate_envelope(x: Any) -> str | None:
    """Returns why the value is not a valid envelope, or None when it is. Unknown fields are ignored."""
    if not isinstance(x, dict):
        return "not an object"
    v = x.get("v")
    if v != 1 or isinstance(v, bool) or not isinstance(v, (int, float)):
        return "v must be 1"
    if not _matches(x.get("id"), _ULID):
        return "id must be a ULID"
    if not _matches(x.get("type"), _TYPE) or len(x["type"]) > 128:
        return "type must be <family>.<name>"
    if not _matches(x.get("tenant"), _TENANT):
        return "tenant is invalid"
    if not _matches(x.get("source"), _SOURCE):
        return "source is invalid"
    if not _matches(x.get("ts"), _TS):
        return "ts must be RFC 3339 UTC"
    if "corr" in x and not (isinstance(x["corr"], str) and 1 <= len(x["corr"]) <= 256):
        return "corr must be a string of 1 to 256 characters"
    if not isinstance(x.get("data"), dict):
        return "data must be an object"
    return None


def is_envelope(x: Any) -> bool:
    return validate_envelope(x) is None


def envelope_json(env: dict[str, Any]) -> bytes:
    """The envelope as compact UTF-8 JSON, the bytes that are published and size-checked."""
    return json.dumps(env, separators=(",", ":"), ensure_ascii=False).encode()


def envelope_bytes(env: dict[str, Any]) -> int:
    return len(envelope_json(env))
