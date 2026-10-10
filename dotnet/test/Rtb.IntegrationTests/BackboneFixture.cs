using DotNet.Testcontainers.Builders;
using DotNet.Testcontainers.Containers;
using DotNet.Testcontainers.Networks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Rtb.Tokens;

namespace Rtb.IntegrationTests;

/// <summary>The backbone image and Valkey in containers, with a JWKS endpoint on the host.</summary>
public sealed class BackboneFixture : IAsyncLifetime
{
    public const string ApiKey = "it-api-key";
    public const string GrpcKey = "it-grpc-key";

    private INetwork _network = null!;
    private IContainer _valkey = null!;
    private IContainer _backbone = null!;
    private WebApplication _jwks = null!;

    public RealtimeTokenSigner Signer { get; } = new(new RealtimeTokenOptions
    {
        PrivateKey = RealtimeTokenSigner.GenerateSigningKey(),
        Audience = "rtb-it",
        Issuer = "rtb-it-dotnet",
    });

    public string GrpcAddress => $"http://{_backbone.Hostname}:{_backbone.GetMappedPublicPort(10000)}";
    public string ApiUrl => $"http://{_backbone.Hostname}:{_backbone.GetMappedPublicPort(9000)}/api";
    public string WsUrl => $"ws://{_backbone.Hostname}:{_backbone.GetMappedPublicPort(8000)}/connection/websocket";

    public async ValueTask InitializeAsync()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls("http://0.0.0.0:0");
        _jwks = builder.Build();
        _jwks.MapGet(TokenEndpointExtensions.JwksPath, () => Results.Text(Signer.Jwks().ToJsonString(), "application/json"));
        await _jwks.StartAsync();
        var port = new Uri(_jwks.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First()).Port;
        var jwksUrl = $"http://host.docker.internal:{port}{TokenEndpointExtensions.JwksPath}";

        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../.."));
        // The docker CLI honors .dockerignore; Testcontainers' builder trips on unreadable dev data in .data/.
        const string image = "rtb-backbone:it-dotnet";
        using (var build = System.Diagnostics.Process.Start("docker", ["build", "-q", "-f", Path.Combine(repoRoot, "images/backbone/Dockerfile"), "-t", image, repoRoot])!)
        {
            await build.WaitForExitAsync();
            if (build.ExitCode != 0) throw new InvalidOperationException("docker build of the backbone image failed");
        }

        _network = new NetworkBuilder().Build();
        _valkey = new ContainerBuilder("valkey/valkey:8.1.10-alpine")
            .WithNetwork(_network)
            .WithNetworkAliases("valkey")
            .WithCommand("valkey-server", "--maxmemory", "128mb", "--maxmemory-policy", "noeviction", "--appendonly", "yes")
            .Build();
        await _valkey.StartAsync();

        _backbone = new ContainerBuilder(image)
            .WithNetwork(_network)
            .WithPortBinding(8000, true)
            .WithPortBinding(9000, true)
            .WithPortBinding(10000, true)
            .WithExtraHost("host.docker.internal", "host-gateway")
            .WithEnvironment(new Dictionary<string, string>
            {
                ["RTB_DOCTOR"] = "strict",
                ["CENTRIFUGO_HTTP_API_KEY"] = ApiKey,
                ["CENTRIFUGO_GRPC_API_KEY"] = GrpcKey,
                ["CENTRIFUGO_ENGINE_REDIS_ADDRESS"] = "redis://valkey:6379",
                ["CENTRIFUGO_CLIENT_ALLOWED_ORIGINS"] = "*",
                ["CENTRIFUGO_CLIENT_TOKEN_JWKS_PUBLIC_ENDPOINT"] = jwksUrl,
                ["CENTRIFUGO_CLIENT_TOKEN_AUDIENCE"] = "rtb-it",
                ["CENTRIFUGO_CLIENT_TOKEN_ISSUER"] = "rtb-it-dotnet",
                ["CENTRIFUGO_CLIENT_SUBSCRIPTION_TOKEN_JWKS_PUBLIC_ENDPOINT"] = jwksUrl,
                ["CENTRIFUGO_CLIENT_SUBSCRIPTION_TOKEN_AUDIENCE"] = "rtb-it",
                ["CENTRIFUGO_CLIENT_SUBSCRIPTION_TOKEN_ISSUER"] = "rtb-it-dotnet",
            })
            .WithWaitStrategy(Wait.ForUnixContainer().UntilHttpRequestIsSucceeded(r => r.ForPort(9000).ForPath("/health")))
            .Build();
        await _backbone.StartAsync();
    }

    public async ValueTask DisposeAsync()
    {
        await _backbone.DisposeAsync();
        await _valkey.DisposeAsync();
        await _network.DisposeAsync();
        await _jwks.DisposeAsync();
        Signer.Dispose();
    }
}
