using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Rtb.Tokens;

public sealed class RealtimeTokenOptions
{
    /// <summary>ES256 private key as a JWK JSON string or a PEM string (PKCS8 or EC PRIVATE KEY).</summary>
    public string PrivateKey { get; set; } = "";
    public string Audience { get; set; } = "";
    public string Issuer { get; set; } = "";
    /// <summary>Key ID. Defaults to the JWK's kid, or its RFC 7638 thumbprint.</summary>
    public string? Kid { get; set; }
    /// <summary>Extra public JWKs (JSON strings) to publish, for example the old key during a rotation.</summary>
    public List<string> AdditionalPublicKeys { get; set; } = [];
    public TimeSpan ConnectionTtl { get; set; } = TimeSpan.FromMinutes(10);
    public TimeSpan SubscriptionTtl { get; set; } = TimeSpan.FromMinutes(10);
    /// <summary>How long an allowed authorize result is cached. Zero turns it off.</summary>
    public TimeSpan AuthorizeCacheTtl { get; set; } = TimeSpan.FromSeconds(30);
}

/// <summary>Signs ES256 JWTs for Centrifugo and exposes the public half as a JWKS.</summary>
public sealed class RealtimeTokenSigner : IDisposable
{
    private readonly ECDsa _key;
    private readonly RealtimeTokenOptions _options;
    private readonly JsonObject _jwks;

    public RealtimeTokenSigner(RealtimeTokenOptions options)
    {
        _options = options;
        string? jwkKid;
        (_key, jwkKid) = LoadKey(options.PrivateKey);
        var p = _key.ExportParameters(false);
        if (p.Curve.Oid.Value != ECCurve.NamedCurves.nistP256.Oid.Value)
            throw new ArgumentException("PrivateKey must be an EC P-256 key");
        var x = B64(p.Q.X!);
        var y = B64(p.Q.Y!);
        Kid = options.Kid ?? jwkKid ?? Thumbprint(x, y);

        var keys = new JsonArray(PublicJwk(x, y, Kid));
        foreach (var json in options.AdditionalPublicKeys)
        {
            var k = JsonNode.Parse(json)!.AsObject();
            var kid = (string?)k["kid"] ?? throw new ArgumentException("every additional public key needs a kid");
            keys.Add(PublicJwk((string)k["x"]!, (string)k["y"]!, kid));
        }
        _jwks = new JsonObject { ["keys"] = keys };
    }

    public string Kid { get; }

    public string MintConnectionToken(string sub, TimeSpan? ttl = null, JsonObject? info = null)
    {
        var claims = new JsonObject();
        if (info is not null) claims["info"] = info.DeepClone();
        return Sign(claims, sub, ttl ?? _options.ConnectionTtl);
    }

    public string MintSubscriptionToken(string sub, string channel, TimeSpan? ttl = null) =>
        Sign(new JsonObject { ["channel"] = channel }, sub, ttl ?? _options.SubscriptionTtl);

    public JsonObject Jwks() => (JsonObject)_jwks.DeepClone();

    /// <summary>Generates a new ES256 key as a JWK JSON string with a thumbprint kid. For dev and rotation scripts.</summary>
    public static string GenerateSigningKey()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var p = key.ExportParameters(true);
        var x = B64(p.Q.X!);
        var y = B64(p.Q.Y!);
        return new JsonObject
        {
            ["kty"] = "EC", ["crv"] = "P-256", ["x"] = x, ["y"] = y, ["d"] = B64(p.D!),
            ["kid"] = Thumbprint(x, y), ["alg"] = "ES256",
        }.ToJsonString();
    }

    private string Sign(JsonObject claims, string sub, TimeSpan ttl)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        claims["sub"] = sub;
        claims["aud"] = _options.Audience;
        claims["iss"] = _options.Issuer;
        claims["iat"] = now;
        claims["exp"] = now + (long)ttl.TotalSeconds;
        var header = new JsonObject { ["alg"] = "ES256", ["kid"] = Kid, ["typ"] = "JWT" };
        var signingInput = $"{B64(Encoding.UTF8.GetBytes(header.ToJsonString()))}.{B64(Encoding.UTF8.GetBytes(claims.ToJsonString()))}";
        var signature = _key.SignData(Encoding.ASCII.GetBytes(signingInput), HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return $"{signingInput}.{B64(signature)}";
    }

    private static (ECDsa, string?) LoadKey(string key)
    {
        var ec = ECDsa.Create();
        if (key.TrimStart().StartsWith("-----BEGIN", StringComparison.Ordinal))
        {
            ec.ImportFromPem(key);
            return (ec, null);
        }
        var jwk = JsonNode.Parse(key)?.AsObject() ?? throw new ArgumentException("PrivateKey is empty");
        if ((string?)jwk["kty"] != "EC" || (string?)jwk["crv"] != "P-256" || jwk["d"] is null)
            throw new ArgumentException("PrivateKey must be an EC P-256 private JWK");
        ec.ImportParameters(new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            D = FromB64((string)jwk["d"]!),
            Q = new ECPoint { X = FromB64((string)jwk["x"]!), Y = FromB64((string)jwk["y"]!) },
        });
        return (ec, (string?)jwk["kid"]);
    }

    private static JsonObject PublicJwk(string x, string y, string kid) =>
        new() { ["kty"] = "EC", ["crv"] = "P-256", ["x"] = x, ["y"] = y, ["kid"] = kid, ["alg"] = "ES256", ["use"] = "sig" };

    private static string Thumbprint(string x, string y) =>
        B64(SHA256.HashData(Encoding.UTF8.GetBytes($$"""{"crv":"P-256","kty":"EC","x":"{{x}}","y":"{{y}}"}""")));

    private static string B64(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] FromB64(string s)
    {
        var t = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(t.PadRight(t.Length + (4 - t.Length % 4) % 4, '='));
    }

    public void Dispose() => _key.Dispose();
}
