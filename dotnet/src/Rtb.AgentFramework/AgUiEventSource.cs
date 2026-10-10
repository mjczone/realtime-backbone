using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Server;
using Microsoft.Agents.AI;

namespace Rtb.AgentFramework;

/// <summary>Anything that turns a RunAgentInput into a stream of AG-UI events.</summary>
public interface IAgUiEventSource
{
    IAsyncEnumerable<BaseEvent> RunAsync(RunAgentInput input, CancellationToken ct);
}

/// <summary>Runs a Microsoft Agent Framework agent and converts its updates to AG-UI events with AGUI.Server.</summary>
public sealed class AIAgentEventSource(AIAgent agent) : IAgUiEventSource
{
    public async IAsyncEnumerable<BaseEvent> RunAsync(RunAgentInput input, [EnumeratorCancellation] CancellationToken ct)
    {
        var ctx = input.ToChatRequestContext(AgUiJson.InputOptions);
        var session = await agent.CreateSessionAsync(ct);
        var events = agent
            .RunStreamingAsync(ctx.Messages, session, new ChatClientAgentRunOptions { ChatOptions = ctx.ChatOptions }, ct)
            .AsChatResponseUpdatesAsync()
            .AsAGUIEventStreamAsync(ctx, ct);
        await foreach (var e in events.WithCancellation(ct)) yield return e;
    }
}

public static class AgUiJson
{
    /// <summary>
    /// Options AGUI.Server needs to read a RunAgentInput. They must chain the agent and AG-UI resolvers,
    /// or the stream is only RUN_STARTED then RUN_ERROR (Phase 0 spike).
    /// </summary>
    public static readonly JsonSerializerOptions InputOptions = CreateInputOptions();

    private static JsonSerializerOptions CreateInputOptions()
    {
        var o = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        o.TypeInfoResolverChain.Add(AgentAbstractionsJsonUtilities.DefaultOptions.TypeInfoResolver!);
        o.TypeInfoResolverChain.Add(AGUIJsonSerializerContext.Default.Options.TypeInfoResolver!);
        o.MakeReadOnly();
        return o;
    }
}
