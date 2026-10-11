using AGUI.Abstractions;

namespace MJCZone.Realtime.AgUi;

/// <summary>Anything that turns a RunAgentInput into a stream of AG-UI events.</summary>
public interface IAgUiEventSource
{
    IAsyncEnumerable<BaseEvent> RunAsync(RunAgentInput input, CancellationToken ct);
}
