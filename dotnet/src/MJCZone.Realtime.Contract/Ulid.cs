using System.Security.Cryptography;

namespace MJCZone.Realtime.Contract;

/// <summary>Monotonic ULIDs: 48-bit millisecond time plus 80 random bits, Crockford base32.</summary>
public static class Ulid
{
    private const string Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    private static readonly Lock Gate = new();
    private static long _lastTime = -1;
    private static readonly byte[] LastRandom = new byte[10];

    public static string NewId()
    {
        Span<byte> bytes = stackalloc byte[16];
        lock (Gate)
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (now <= _lastTime)
            {
                Increment(LastRandom);
                now = _lastTime;
            }
            else
            {
                RandomNumberGenerator.Fill(LastRandom);
                _lastTime = now;
            }
            for (var i = 5; i >= 0; i--)
            {
                bytes[i] = (byte)(now & 0xFF);
                now >>= 8;
            }
            LastRandom.CopyTo(bytes[6..]);
        }
        return Encode(bytes);
    }

    private static void Increment(byte[] random)
    {
        for (var i = random.Length - 1; i >= 0; i--)
        {
            if (++random[i] != 0) return;
        }
        throw new InvalidOperationException("ULID random part overflowed within one millisecond");
    }

    private static string Encode(ReadOnlySpan<byte> b)
    {
        // 128 bits as 26 base32 characters; the first character carries the top 3 bits.
        Span<char> c = stackalloc char[26];
        var value = new System.Numerics.BigInteger(b, isUnsigned: true, isBigEndian: true);
        for (var i = 25; i >= 0; i--)
        {
            c[i] = Alphabet[(int)(value & 31)];
            value >>= 5;
        }
        return new string(c);
    }
}
