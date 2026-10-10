import json
from pathlib import Path

import pytest
from rtb_contract import TenantContext, check_tenant, try_parse_channel, validate_envelope

VECTORS = Path(__file__).parents[3] / "spec" / "vectors"


def load(name: str) -> list[dict]:
    return json.loads((VECTORS / name).read_text())


def ids(vectors: list[dict], key: str) -> list[str]:
    return [str(v.get(key, ""))[:60] for v in vectors]


VALID = load("channels.valid.json")
INVALID = load("channels.invalid.json")
ENV_VALID = load("envelopes.valid.json")
ENV_INVALID = load("envelopes.invalid.json")
GUARD = load("guard.json")


@pytest.mark.parametrize("v", VALID, ids=ids(VALID, "name"))
def test_valid_channels(v):
    c = try_parse_channel(v["name"])
    assert c is not None
    p = v["parsed"]
    assert (c.tier, c.tenant, c.topic, c.id, c.user_id) == (
        p["tier"],
        p["tenant"],
        p["topic"],
        p.get("id"),
        p.get("userId"),
    )


@pytest.mark.parametrize("v", INVALID, ids=ids(INVALID, "why"))
def test_invalid_channels(v):
    assert try_parse_channel(v["name"]) is None


@pytest.mark.parametrize("v", ENV_VALID, ids=ids(ENV_VALID, "why"))
def test_valid_envelopes(v):
    assert validate_envelope(v["envelope"]) is None


@pytest.mark.parametrize("v", ENV_INVALID, ids=ids(ENV_INVALID, "why"))
def test_invalid_envelopes(v):
    assert validate_envelope(v["envelope"]) is not None


@pytest.mark.parametrize("v", GUARD, ids=ids(GUARD, "why"))
def test_guard(v):
    ctx = TenantContext(v["context"].get("tenant"), v["context"].get("allowGlobal", False))
    r = check_tenant(ctx, v["channel"], v["envelopeTenant"])
    assert (r.allow, r.reason) == (v["allow"], v.get("reason"))
