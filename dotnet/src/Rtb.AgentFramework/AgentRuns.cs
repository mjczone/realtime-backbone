using System.Collections.Concurrent;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Rtb.Contract;
using Rtb.Publisher;
using Rtb.Tokens;

namespace Rtb.AgentFramework;

public sealed record RunInfo(RunAgentInput Input, string RunId, string ThreadId, string Channel, string Tenant, string UserId);

/// <summary>What the run endpoint returns with 202, and what a client needs to join the run.</summary>
public sealed record RunRef(string RunId, string ThreadId, string Channel, ulong Offset, string Epoch);

public sealed class StartRunOptions
{
    /// <summary>Publisher for the run's tenant.</summary>
    public required IRealtimePublisher Publisher { get; init; }
    public required IAgUiEventSource Agent { get; init; }
    public required RunAgentInput Input { get; init; }
    /// <summary>The user who owns the run.</summary>
    public required string UserId { get; init; }
    /// <summary>Publish notice.run_started to the user's live channel. Use it for background runs.</summary>
    public bool NotifyUser { get; init; }
    /// <summary>Called before anything is published, so the app can record who may watch the run.</summary>
    public Func<RunInfo, Task>? OnRunCreated { get; init; }
    /// <summary>Called after the run ends, with every published event, so the app can store the thread.</summary>
    public Func<RunInfo, SinkResult, Task>? OnRunFinished { get; init; }
    /// <summary>AG-UI event types not to publish, for example STATE_SNAPSHOT when the UI doesn't use shared state.</summary>
    public IReadOnlySet<string>? SkipTypes { get; init; }
    public ILogger? Logger { get; init; }
}

public static class AgentRunner
{
    /// <summary>
    /// Starts an agent run on its own replay channel. Publishes RUN_STARTED, then drives the agent in the
    /// background. Returns once RUN_STARTED is published; <c>Done</c> completes when the run has ended.
    /// Needs a long-running process.
    /// </summary>
    public static async Task<(RunRef Ref, Task Done)> StartRunAsync(StartRunOptions options, CancellationToken runToken = default)
    {
        var tenant = options.Publisher.Tenant ?? throw new InvalidOperationException("StartRunAsync needs a publisher with a tenant (ForTenant)");
        var runId = Ulid.NewId();
        var input = options.Input;
        var threadId = string.IsNullOrEmpty(input.ThreadId) ? Ulid.NewId() : input.ThreadId;
        input.ThreadId = threadId;
        input.RunId = runId;
        var channel = Channels.Run(tenant, runId);
        var info = new RunInfo(input, runId, threadId, channel, tenant, options.UserId);

        if (options.OnRunCreated is not null) await options.OnRunCreated(info);
        var started = await options.Publisher.PublishAsync(channel, "agui.RUN_STARTED",
            new { type = "RUN_STARTED", threadId, runId }, corr: runId);
        var runRef = new RunRef(runId, threadId, channel, started.Offset ?? 0, started.Epoch ?? "");
        if (options.NotifyUser)
        {
            try
            {
                await options.Publisher.PublishAsync(Channels.User(tenant, options.UserId), "notice.run_started", runRef);
            }
            catch (Exception e)
            {
                options.Logger?.LogWarning(e, "rtb: notice.run_started failed for {RunId}", runId);
            }
        }

        var done = Task.Run(async () =>
        {
            var result = await AgUiSink.PublishRunAsync(options.Publisher, channel, runId, options.Agent.RunAsync(input, runToken),
                runToken, skipTypes: options.SkipTypes);
            try
            {
                if (options.OnRunFinished is not null) await options.OnRunFinished(info, result);
            }
            catch (Exception e)
            {
                options.Logger?.LogError(e, "rtb: OnRunFinished failed for {RunId}", runId);
            }
        }, CancellationToken.None);
        return (runRef, done);
    }
}

public sealed class AgentRunEndpointOptions
{
    public required Func<HttpContext, ValueTask<TokenUser?>> Authenticate { get; init; }
    /// <summary>The agent to run for this request.</summary>
    public required Func<RunAgentInput, TokenUser, IAgUiEventSource> Agent { get; init; }
    public Func<RunInfo, Task>? OnRunCreated { get; init; }
    public Func<RunInfo, SinkResult, Task>? OnRunFinished { get; init; }
    /// <summary>Also publish notice.run_started to the user's live channel, so the user's other tabs can join.</summary>
    public bool NotifyUser { get; init; }
    /// <summary>AG-UI event types not to publish, for example STATE_SNAPSHOT when the UI doesn't use shared state.</summary>
    public IReadOnlySet<string>? SkipTypes { get; init; }
    /// <summary>POST {Prefix} starts a run; POST {Prefix}/{runId}/cancel cancels it.</summary>
    public string Prefix { get; init; } = "/api/run";
}

public static class AgentRunEndpointExtensions
{
    /// <summary>Maps the run endpoint (202 with RunRef and a subscription token) and the cancel endpoint.</summary>
    public static IEndpointRouteBuilder MapAgentRunEndpoints(this IEndpointRouteBuilder app, AgentRunEndpointOptions options)
    {
        var publisher = app.ServiceProvider.GetRequiredService<IRealtimePublisher>();
        var signer = app.ServiceProvider.GetRequiredService<RealtimeTokenSigner>();
        var logger = app.ServiceProvider.GetService<ILoggerFactory>()?.CreateLogger("Rtb.AgentFramework");
        var active = new ConcurrentDictionary<string, (string UserId, string Tenant, CancellationTokenSource Cts)>();

        app.MapPost(options.Prefix, async (HttpContext ctx) =>
        {
            var user = await options.Authenticate(ctx);
            if (user is null) return Results.Json(new { error = "unauthenticated" }, statusCode: 401);
            RunAgentInput? input;
            try
            {
                input = await JsonSerializer.DeserializeAsync(ctx.Request.Body, AGUIJsonSerializerContext.Default.RunAgentInput);
            }
            catch (JsonException)
            {
                input = null;
            }
            if (input is null) return Results.Json(new { error = "body must be RunAgentInput JSON" }, statusCode: 400);

            var cts = new CancellationTokenSource();
            var (runRef, done) = await AgentRunner.StartRunAsync(new StartRunOptions
            {
                Publisher = publisher.ForTenant(user.Tenant),
                Agent = options.Agent(input, user),
                Input = input,
                UserId = user.UserId,
                NotifyUser = options.NotifyUser,
                SkipTypes = options.SkipTypes,
                OnRunCreated = options.OnRunCreated,
                OnRunFinished = options.OnRunFinished,
                Logger = logger,
            }, cts.Token);
            active[runRef.RunId] = (user.UserId, user.Tenant, cts);
            _ = done.ContinueWith(_ =>
            {
                active.TryRemove(runRef.RunId, out var _);
                cts.Dispose();
            }, TaskScheduler.Default);

            var token = signer.MintSubscriptionToken(user.UserId, runRef.Channel);
            return Results.Json(new
            {
                runId = runRef.RunId, threadId = runRef.ThreadId, channel = runRef.Channel,
                offset = runRef.Offset, epoch = runRef.Epoch, token,
            }, statusCode: 202);
        });

        app.MapPost($"{options.Prefix}/{{runId}}/cancel", async (HttpContext ctx, string runId) =>
        {
            var user = await options.Authenticate(ctx);
            if (user is null) return Results.Json(new { error = "unauthenticated" }, statusCode: 401);
            if (!active.TryGetValue(runId, out var run) || run.UserId != user.UserId || run.Tenant != user.Tenant)
                return Results.Json(new { error = "no such run" }, statusCode: 404);
            await run.Cts.CancelAsync();
            return Results.Json(new { cancelled = true });
        });

        return app;
    }
}
