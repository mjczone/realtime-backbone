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
    /// <summary>
    /// Events a run can't work without: the client completes on RUN_FINISHED or RUN_ERROR, and the text and
    /// tool-call events are the conversation itself. skipTypes may not contain them.
    /// </summary>
    public static readonly IReadOnlySet<string> RequiredEventTypes = new HashSet<string>
    {
        "RUN_FINISHED", "RUN_ERROR",
        "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "TEXT_MESSAGE_CHUNK",
        "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT", "TOOL_CALL_CHUNK",
    };

    /// <summary>Throws ArgumentException if skipTypes contains an event type a run needs.</summary>
    public static void CheckSkipTypes(IReadOnlySet<string>? skipTypes)
    {
        var required = skipTypes?.Where(RequiredEventTypes.Contains).Order().ToList() ?? [];
        if (required.Count > 0)
            throw new ArgumentException($"these AG-UI event types can't be skipped: {string.Join(", ", required)}", nameof(skipTypes));
    }

    // Room for the envelope fields around the AG-UI event.
    private const int EnvelopeOverhead = 1024;

    /// <summary>
    /// Publishes an agent's AG-UI events to a run channel. It drops the agent's own RUN_STARTED (the run
    /// endpoint already published one), batches deltas, replaces events over the envelope cap with an
    /// rtb.oversize marker, and publishes RUN_ERROR if the agent fails or is cancelled without one. Event types in
    /// <paramref name="skipTypes"/> are not published, for example STATE_SNAPSHOT when the UI doesn't use shared state.
    /// Completes when everything is published; it never throws, except ArgumentException for a skipTypes it refuses.
    /// </summary>
    public static async Task<SinkResult> PublishRunAsync(
        IRealtimePublisher publisher, string channel, string runId, IAsyncEnumerable<BaseEvent> events,
        CancellationToken ct = default, TimeSpan? batchInterval = null, IReadOnlySet<string>? skipTypes = null)
    {
        CheckSkipTypes(skipTypes);
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
                    var json = ToJson(e);
                    if (skipTypes?.Contains((string)json["type"]!) == true) continue;
                    batcher.Push(json);
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
