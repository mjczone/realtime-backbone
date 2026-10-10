using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Rtb.Publisher;

public static class ServiceCollectionExtensions
{
    /// <summary>Registers IRealtimePublisher as a singleton over the gRPC transport.</summary>
    public static IServiceCollection AddRealtimePublisher(this IServiceCollection services, Action<RealtimePublisherOptions> configure)
    {
        services.AddOptions<RealtimePublisherOptions>().Configure(configure);
        return services.AddRealtimePublisherCore();
    }

    /// <summary>Registers IRealtimePublisher with options bound from a configuration section, such as "Rtb:Publisher".</summary>
    public static IServiceCollection AddRealtimePublisher(this IServiceCollection services, IConfiguration section)
    {
        services.AddOptions<RealtimePublisherOptions>().Bind(section);
        return services.AddRealtimePublisherCore();
    }

    private static IServiceCollection AddRealtimePublisherCore(this IServiceCollection services)
    {
        services.AddSingleton<ICentrifugoTransport>(sp => new GrpcTransport(sp.GetRequiredService<IOptions<RealtimePublisherOptions>>().Value));
        services.AddSingleton<IRealtimePublisher>(sp => new RealtimePublisher(
            sp.GetRequiredService<IOptions<RealtimePublisherOptions>>().Value,
            sp.GetRequiredService<ICentrifugoTransport>(),
            sp.GetService<ILoggerFactory>()));
        return services;
    }
}
