import re
from dataclasses import dataclass

MAX_CHANNEL_LENGTH = 255
TIERS = ("live", "replay", "presence")
RESERVED_TOPICS = ("all", "grp", "user", "run")

_SEGMENT = re.compile(r"[A-Za-z0-9_-]+")
_TENANT = re.compile(r"[A-Za-z0-9_-]{1,64}")
_USER_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")


@dataclass(frozen=True)
class ParsedChannel:
    tier: str
    tenant: str
    """The tenant ID, or the literal "global" for global channels."""
    topic: str
    id: str | None = None
    user_id: str | None = None

    @property
    def is_global(self) -> bool:
        return self.tenant == "global"


class InvalidChannelError(ValueError):
    pass


def is_valid_tenant(tenant: str) -> bool:
    return bool(_TENANT.fullmatch(tenant)) and tenant != "global"


def is_valid_user_id(user_id: str) -> bool:
    return bool(_USER_ID.fullmatch(user_id))


def _segments(text: str) -> list[str] | None:
    parts = text.split(".")
    if len(parts) > 2 or not all(_SEGMENT.fullmatch(p) for p in parts):
        return None
    return parts


def try_parse_channel(name: str) -> ParsedChannel | None:
    if not isinstance(name, str) or len(name) > MAX_CHANNEL_LENGTH:
        return None
    tier, colon, rest = name.partition(":")
    if not colon or tier not in TIERS:
        return None

    if rest.startswith("global."):
        if tier == "presence":
            return None
        parts = _segments(rest[len("global."):])
        if parts is None or parts[0] in RESERVED_TOPICS:
            return None
        return ParsedChannel(tier, "global", parts[0], parts[1] if len(parts) == 2 else None)

    if not rest.startswith("t-"):
        return None
    tenant, dot, tail = rest[2:].partition(".")
    if not dot or not is_valid_tenant(tenant):
        return None

    if tail.startswith("user#"):
        user_id = tail[len("user#"):]
        if tier == "presence" or not is_valid_user_id(user_id):
            return None
        return ParsedChannel(tier, tenant, "user", user_id=user_id)

    parts = _segments(tail)
    if parts is None:
        return None
    topic = parts[0]
    id_ = parts[1] if len(parts) == 2 else None
    if topic == "all" and (id_ is not None or tier == "presence"):
        return None
    if topic in ("grp", "run") and id_ is None:
        return None
    if topic == "user":
        return None
    return ParsedChannel(tier, tenant, topic, id_)


def parse_channel(name: str) -> ParsedChannel:
    c = try_parse_channel(name)
    if c is None:
        raise InvalidChannelError(f"Invalid channel name: {name!r}")
    return c


def is_valid_channel(name: str) -> bool:
    return try_parse_channel(name) is not None


def _build(name: str, tenant: str, topic: str, id_: str | None = None, user_id: str | None = None) -> str:
    c = parse_channel(name)
    if (c.tenant, c.topic, c.id, c.user_id) != (tenant, topic, id_, user_id):
        raise InvalidChannelError(f"Invalid channel parts for {name!r}")
    return name


def _suffix(id_: str | None) -> str:
    return "" if id_ is None else f".{id_}"


class Channels:
    """Builders per audience. They raise on any input that would not parse back to the same parts."""

    @staticmethod
    def global_(topic: str, id: str | None = None, tier: str = "live") -> str:
        return _build(f"{tier}:global.{topic}{_suffix(id)}", "global", topic, id)

    @staticmethod
    def tenant_all(tenant: str, tier: str = "live") -> str:
        return _build(f"{tier}:t-{tenant}.all", tenant, "all")

    @staticmethod
    def record(tenant: str, topic: str, id: str | None = None, tier: str = "live") -> str:
        return _build(f"{tier}:t-{tenant}.{topic}{_suffix(id)}", tenant, topic, id)

    @staticmethod
    def group(tenant: str, group: str, tier: str = "live") -> str:
        return _build(f"{tier}:t-{tenant}.grp.{group}", tenant, "grp", group)

    @staticmethod
    def user(tenant: str, user_id: str, tier: str = "live") -> str:
        return _build(f"{tier}:t-{tenant}.user#{user_id}", tenant, "user", user_id=user_id)

    @staticmethod
    def run(tenant: str, run_id: str) -> str:
        return _build(f"replay:t-{tenant}.run.{run_id}", tenant, "run", run_id)

    @staticmethod
    def presence(tenant: str, topic: str, id: str | None = None) -> str:
        return _build(f"presence:t-{tenant}.{topic}{_suffix(id)}", tenant, topic, id)
