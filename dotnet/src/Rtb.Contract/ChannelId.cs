using System.Text;

namespace Rtb.Contract;

/// <summary>Encodes any key as a channel ID, and back. The same rule in every SDK; see spec/channels.md.</summary>
public static class ChannelId
{
    public const int MaxEncodedLength = 128;

    private static readonly UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    private static bool IsPlain(int b) => b is >= '0' and <= '9' or >= 'A' and <= 'Z' or >= 'a' and <= 'z' or '-';

    /// <summary>A-Z, a-z, 0-9 and - pass through; every other UTF-8 byte becomes _XX.</summary>
    public static string Encode(string key)
    {
        if (string.IsNullOrEmpty(key)) throw new ArgumentException("key must be a non-empty string", nameof(key));
        byte[] utf8;
        try
        {
            utf8 = StrictUtf8.GetBytes(key);
        }
        catch (EncoderFallbackException)
        {
            throw new ArgumentException("key is not valid Unicode text", nameof(key));
        }
        var sb = new StringBuilder();
        foreach (var b in utf8)
        {
            if (IsPlain(b)) sb.Append((char)b);
            else sb.Append('_').Append(b.ToString("X2"));
        }
        if (sb.Length > MaxEncodedLength)
            throw new ArgumentException($"encoded ID is {sb.Length} characters, over {MaxEncodedLength}", nameof(key));
        return sb.ToString();
    }

    /// <summary>The reverse of Encode. Throws on anything Encode would not produce.</summary>
    public static string Decode(string id)
    {
        if (string.IsNullOrEmpty(id) || id.Length > MaxEncodedLength) throw new ArgumentException("not an encoded ID", nameof(id));
        var bytes = new List<byte>(id.Length);
        for (var i = 0; i < id.Length; i++)
        {
            var c = id[i];
            if (c == '_')
            {
                var hex = id.Substring(i + 1, Math.Min(2, id.Length - i - 1));
                if (hex.Length != 2 || !hex.All(h => h is >= '0' and <= '9' or >= 'A' and <= 'F'))
                    throw new ArgumentException($"bad escape at {i}", nameof(id));
                var b = Convert.ToByte(hex, 16);
                if (IsPlain(b)) throw new ArgumentException($"escaped plain character at {i}", nameof(id));
                bytes.Add(b);
                i += 2;
            }
            else if (IsPlain(c))
            {
                bytes.Add((byte)c);
            }
            else
            {
                throw new ArgumentException($"unexpected character at {i}", nameof(id));
            }
        }
        try
        {
            return StrictUtf8.GetString(bytes.ToArray());
        }
        catch (DecoderFallbackException)
        {
            throw new ArgumentException("not valid UTF-8", nameof(id));
        }
    }
}
