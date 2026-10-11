using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using Centrifugal.Centrifugo.Api;
using Google.Protobuf;
using Grpc.Core;
using Grpc.Net.Client;

namespace MJCZone.Realtime.Publisher;

/// <summary>Publishes over Centrifugo's gRPC API with the API key in metadata and an optional client certificate.</summary>
public sealed class GrpcTransport : ICentrifugoTransport, IDisposable
{
    // Centrifugo codes worth retrying: internal (100), not available (108), too many requests (111).
    private static readonly HashSet<uint> TransientCodes = [100, 108, 111];
    private static readonly HashSet<StatusCode> TransientStatus =
        [StatusCode.Unavailable, StatusCode.DeadlineExceeded, StatusCode.ResourceExhausted, StatusCode.Internal, StatusCode.Aborted];

    private readonly GrpcChannel _channel;
    private readonly CentrifugoApi.CentrifugoApiClient _client;
    private readonly Metadata _headers;
    private readonly TimeSpan _timeout;

    public GrpcTransport(RealtimePublisherOptions options)
    {
        var handler = new SocketsHttpHandler
        {
            EnableMultipleHttp2Connections = true,
            KeepAlivePingDelay = TimeSpan.FromSeconds(30),
            KeepAlivePingTimeout = TimeSpan.FromSeconds(10),
        };
        if (options.ClientCertificatePath is not null)
        {
            var cert = X509Certificate2.CreateFromPemFile(options.ClientCertificatePath, options.ClientKeyPath);
            handler.SslOptions.ClientCertificates = [cert];
        }
        if (options.ServerCaPath is not null)
        {
            var ca = X509Certificate2.CreateFromPem(File.ReadAllText(options.ServerCaPath));
            handler.SslOptions.RemoteCertificateValidationCallback = (_, cert, _, errors) => ValidateWithCa(cert, errors, ca);
        }
        _channel = GrpcChannel.ForAddress(options.Address, new GrpcChannelOptions { HttpHandler = handler });
        _client = new CentrifugoApi.CentrifugoApiClient(_channel);
        _headers = new Metadata { { "authorization", $"apikey {options.ApiKey}" } };
        _timeout = options.Timeout;
    }

    public async Task<(ulong? Offset, string? Epoch)> PublishAsync(string channel, byte[] data, string idempotencyKey, CancellationToken ct)
    {
        PublishResponse res;
        try
        {
            res = await _client.PublishAsync(
                new PublishRequest { Channel = channel, Data = ByteString.CopyFrom(data), IdempotencyKey = idempotencyKey },
                _headers, deadline: DateTime.UtcNow + _timeout, cancellationToken: ct);
        }
        catch (RpcException e)
        {
            throw new PublishException($"gRPC {e.StatusCode}: {e.Status.Detail}", TransientStatus.Contains(e.StatusCode), null, e);
        }
        if (res.Error is { } err)
            throw new PublishException($"Centrifugo error {err.Code}: {err.Message}", TransientCodes.Contains(err.Code), err.Code);
        var r = res.Result;
        return r is null || (r.Offset == 0 && r.Epoch == "") ? (null, null) : (r.Offset, r.Epoch);
    }

    private static bool ValidateWithCa(X509Certificate? cert, SslPolicyErrors errors, X509Certificate2 ca)
    {
        if (cert is null) return false;
        if (errors == SslPolicyErrors.None) return true;
        if ((errors & SslPolicyErrors.RemoteCertificateNameMismatch) != 0) return false;
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(ca);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        return chain.Build(new X509Certificate2(cert));
    }

    public void Dispose() => _channel.Dispose();
}
