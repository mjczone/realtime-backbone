import re

import pytest
from mjczone_realtime_contract import (
    MAX_ENVELOPE_BYTES,
    Channels,
    InvalidChannelError,
    InvalidEnvelopeError,
    TenantContext,
    TenantGuardError,
    assert_tenant,
    create_envelope,
    envelope_bytes,
    new_id,
)


def test_builders():
    assert Channels.global_("maintenance") == "live:global.maintenance"
    assert Channels.tenant_all("acme") == "live:t-acme.all"
    assert Channels.record("acme", "jobs", "01JB7Q") == "live:t-acme.jobs.01JB7Q"
    assert Channels.group("acme", "ops") == "live:t-acme.grp.ops"
    assert Channels.user("acme", "u1", "replay") == "replay:t-acme.user#u1"
    assert Channels.run("acme", "r1") == "replay:t-acme.run.r1"
    assert Channels.presence("acme", "doc", "881") == "presence:t-acme.doc.881"


@pytest.mark.parametrize(
    "tenant,topic,id_",
    [("ac.me", "jobs", None), ("acme", "jobs.1", None), ("acme", "all", "1"), ("global", "x", None)],
)
def test_builders_reject_bad_parts(tenant, topic, id_):
    with pytest.raises(InvalidChannelError):
        Channels.record(tenant, topic, id_)


def test_create_envelope():
    e = create_envelope("job.progress", "acme", "w1", {"pct": 1}, corr="c1")
    assert e["v"] == 1 and e["corr"] == "c1" and e["ts"].endswith("Z")
    assert re.fullmatch(r"[0-9A-HJKMNP-TV-Z]{26}", e["id"])
    assert "corr" not in create_envelope("a.b", "t", "s", {})
    with pytest.raises(InvalidEnvelopeError):
        create_envelope("nofamily", "acme", "w", {})
    with pytest.raises(InvalidEnvelopeError):
        create_envelope("a.b", "acme", "w", [1])  # type: ignore[arg-type]


def test_ulids_are_monotonic():
    ids = [new_id() for _ in range(5000)]
    assert ids == sorted(ids) and len(set(ids)) == len(ids)


def test_envelope_bytes_counts_utf8():
    e = create_envelope("a.b", "t", "s", {"s": "é" * (MAX_ENVELOPE_BYTES // 2)})
    assert envelope_bytes(e) > MAX_ENVELOPE_BYTES


def test_assert_tenant():
    with pytest.raises(TenantGuardError) as e:
        assert_tenant(TenantContext("acme"), "live:t-globex.x", "globex")
    assert e.value.reason == "tenant_mismatch"
