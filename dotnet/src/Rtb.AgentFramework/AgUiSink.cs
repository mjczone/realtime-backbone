using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using AGUI.Abstractions;
using Rtb.Contract;
using Rtb.Publisher;

namespace Rtb.AgentFramework;

public sealed record SinkResult(IReadOnlyList<JsonObject> Events, Exception? Error);

public static class AgUiSink
{
    // Room for the envelope fields around the AG-UI event.
    private const int EnvelopeOverhead = 1024;

    /// <summary>
    /// Publishes an agent's AG-UI events to a run channel. It drops the agent's own RUN_STARTED (the run
    /// endpoint already published one), batches deltas, replaces events over the envelope cap with an
    /// rtb.oversize marker, and publishes RUN_ERROR if the agent fails or is cancelled without one.
    /// Completes when everything is published; it never throws.
    /// </summary>
    public static async Task<SinkResult> PublishRunAsync(
        IRealtimePublisher publisher, string channel, string runId, IAsyncEnumerable<BaseEvent> events,
        CancellationToken ct = default, TimeSpan? batchInterval = null)
    {
        var published = new List<JsonObject>();
        var pending = new List<Task>();
        var ended = false;

        void Send(JsonObject e)
        {
            var bytes = Encoding.UTF8.GetByteCount(e.ToJsonString());
            var type = (string)e["type"]!;
            var output = bytes + EnvelopeOverhead > Envelopes.MaxBytes
                ? new JsonObject { ["type"] = "CUSTOM", ["name"] = "rtb.oversize", ["value"] = new JsonObject { ["type"] = type, ["bytes"] = bytes } }
                : e;
            var outType = (string)output["type"]!;
            if (outType is "RUN_FINISHED" or "RUN_ERROR") ended = true;
            published.Add(output);
            pending.Add(publisher.PublishAsync(channel, $"agui.{outType}", output, corr: runId).ContinueWith(_ => { }, TaskScheduler.Default));
        }

        Exception? error = null;
        var code = "rtb.agent_error";
        using (var batcher = new DeltaBatcher(Send, batchInterval))
        {
            try
            {
                await foreach (var e in events.WithCancellation(ct))
                {
                    if (e is RunStartedEvent) continue;
                    batcher.Push(ToJson(e));
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                error = new OperationCanceledException("Run cancelled");
                code = "rtb.cancelled";
            }
            catch (Exception e)
            {
                error = e;
            }
            batcher.Flush();
            if (error is not null && !ended)
                Send(new JsonObject { ["type"] = "RUN_ERROR", ["message"] = error.Message, ["code"] = code });
        }
        await Task.WhenAll(pending);
        return new SinkResult(published, error);
    }

    public static JsonObject ToJson(BaseEvent e) =>
        JsonSerializer.SerializeToNode(e, AGUIJsonSerializerContext.Default.BaseEvent)!.AsObject();
}
