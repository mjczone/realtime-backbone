"""Encodes any key as a channel ID, and back. The same rule in every SDK; see spec/channels.md."""

import re

MAX_ENCODED_ID_LENGTH = 128

_PLAIN = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-")
_HEX = re.compile(r"[0-9A-F]{2}")


def encode_id(key: str) -> str:
    """A-Z, a-z, 0-9 and - pass through; every other UTF-8 byte becomes _XX."""
    if not isinstance(key, str) or key == "":
        raise ValueError("encode_id: key must be a non-empty string")
    try:
        data = key.encode()
    except UnicodeEncodeError:
        raise ValueError("encode_id: key is not valid Unicode text") from None
    out = "".join(chr(b) if b in _PLAIN else f"_{b:02X}" for b in data)
    if len(out) > MAX_ENCODED_ID_LENGTH:
        raise ValueError(f"encode_id: encoded ID is {len(out)} characters, over {MAX_ENCODED_ID_LENGTH}")
    return out


def decode_id(id: str) -> str:
    """The reverse of encode_id. Raises ValueError on anything encode_id would not produce."""
    if not isinstance(id, str) or id == "" or len(id) > MAX_ENCODED_ID_LENGTH:
        raise ValueError("decode_id: not an encoded ID")
    data = bytearray()
    i = 0
    while i < len(id):
        c = id[i]
        if c == "_":
            hex_ = id[i + 1 : i + 3]
            if not _HEX.fullmatch(hex_):
                raise ValueError(f"decode_id: bad escape at {i}")
            b = int(hex_, 16)
            if b in _PLAIN:
                raise ValueError(f"decode_id: escaped plain character at {i}")
            data.append(b)
            i += 3
        elif c.isascii() and ord(c) in _PLAIN:
            data.append(ord(c))
            i += 1
        else:
            raise ValueError(f"decode_id: unexpected character at {i}")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("decode_id: not valid UTF-8") from None
