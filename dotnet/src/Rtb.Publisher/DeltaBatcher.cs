using System.Text;
using System.Text.Json.Nodes;

namespace Rtb.Publisher;

/// <summary>
/// Joins consecutive TEXT_MESSAGE_CONTENT deltas for one messageId, and TOOL_CALL_ARGS deltas for one
/// toolCallId, into one event. Any other event flushes the buffer first, so order is kept.
/// <c>emit</c> is called in order, one call at a time.
/// </summary>
public sealed class DeltaBatcher : IDisposable
{
    private readonly Action<JsonObject> _emit;
    private readonly TimeSpan _interval;
    private readonly int _maxBytes;
    private readonly Lock _gate = new();
    private readonly Timer _timer;
    private string? _key;
    private JsonObject? _first;
    private readonly StringBuilder _delta = new();
    private int _bytes;

    public DeltaBatcher(Action<JsonObject> emit, TimeSpan? interval = null, int maxBytes = 32768)
    {
        _emit = emit;
        _interval = interval ?? TimeSpan.FromMilliseconds(75);
        _maxBytes = maxBytes;
        _timer = new Timer(_ => Flush());
    }

    private static string? KeyOf(JsonObject e) => (string?)e["type"] switch
    {
        "TEXT_MESSAGE_CONTENT" when e["messageId"] is not null => $"text:{e["messageId"]}",
        "TOOL_CALL_ARGS" when e["toolCallId"] is not null => $"args:{e["toolCallId"]}",
        _ => null,
    };

    public void Push(JsonObject e)
    {
        lock (_gate)
        {
            var key = KeyOf(e);
            if (key is null)
            {
                FlushLocked();
                _emit(e);
                return;
            }
            if (_key is not null && _key != key) FlushLocked();
            var delta = (string?)e["delta"] ?? "";
            if (_key is null)
            {
                _key = key;
                _first = e;
                _timer.Change(_interval, Timeout.InfiniteTimeSpan);
            }
            _delta.Append(delta);
            _bytes += Encoding.UTF8.GetByteCount(delta);
            if (_bytes >= _maxBytes) FlushLocked();
        }
    }

    public void Flush()
    {
        lock (_gate) FlushLocked();
    }

    private void FlushLocked()
    {
        if (_key is null) return;
        _timer.Change(Timeout.Infinite, Timeout.Infinite);
        var e = (JsonObject)_first!.DeepClone();
        e["delta"] = _delta.ToString();
        _key = null;
        _first = null;
        _delta.Clear();
        _bytes = 0;
        _emit(e);
    }

    public void Dispose() => _timer.Dispose();
}
