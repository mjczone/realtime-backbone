import os
import threading
import time

_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_lock = threading.Lock()
_last_time = -1
_last_random = 0


def new_id() -> str:
    """A monotonic ULID: 48-bit millisecond time plus 80 random bits, Crockford base32."""
    global _last_time, _last_random
    with _lock:
        now = time.time_ns() // 1_000_000
        if now <= _last_time:
            _last_random += 1
            if _last_random >= 1 << 80:
                raise OverflowError("ULID random part overflowed within one millisecond")
            now = _last_time
        else:
            _last_time = now
            _last_random = int.from_bytes(os.urandom(10), "big")
        value = (now << 80) | _last_random
    chars = []
    for _ in range(26):
        chars.append(_ALPHABET[value & 31])
        value >>= 5
    return "".join(reversed(chars))
