using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Rtb.Contract;

namespace Rtb.Publisher;

public sealed class RealtimePublisherOptions
{
    /// <summary>Centrifugo gRPC API address, for example https://backbone:10000 (or http:// on a trusted network).</summary>
    public string Address { get; set; } = "http://localhost:10000";
    public string ApiKey { get; set; } = "";
    /// <summary>This component's ID, written to every envelope and audit entry.</summary>
    public string Source { get; set; } = "";
    public string? Tenant { get; set; }
    /// <summary>Allow publishing to global channels. Null reads RTB_ALLOW_GLOBAL=true.</summary>
    public bool? AllowGlobal { get; set; }
    /// <summary>PEM client certificate and key for mTLS.</summary>
    public string? ClientCertificatePath { get; set; }
    public string? ClientKeyPath { get; set; }
    /// <summary>PEM CA that signed the server certificate, when it is not in the system store.</summary>
    public string? ServerCaPath { get; set; }
    public int RetryAttempts { get; set; } = 8;
    public TimeSpan RetryBaseDelay { get; set; } = TimeSpan.FromMilliseconds(100);
    public TimeSpan RetryMaxDelay { get; set; } = TimeSpan.FromSeconds(5);
    /// <summary>Stop retrying after this long, well inside Centrifugo's 5 minute idempotency window.</summary>
    public TimeSpan RetryTotal { get; set; } = TimeSpan.FromSeconds(30);
    /// <summary>Deadline for each request.</summary>
    public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(10);
}

public sealed record PublishResult(Envelope Envelope, ulong? Offset, string? Epoch);

public sealed class PublishException(string message, bool transient, uint? code = null, Exception? inner = null)
    : Exception(message, inner)
{
    public bool Transient { get; } = transient;
    public uint? Code { get; } = code;
}

public sealed class EnvelopeTooLargeException(int bytes, string channel)
    : Exception($"Envelope of {bytes} bytes for {channel} is over the {Envelopes.MaxBytes} byte cap")
{
    public int Bytes { get; } = bytes;
    public string Channel { get; } = channel;
}

/// <summary>Sends one publication. The gRPC transport is the default; tests use a fake.</summary>
public interface ICentrifugoTransport
{
    Task<(ulong? Offset, string? Epoch)> PublishAsync(string channel, byte[] data, string idempotencyKey, CancellationToken ct);
}

public interface IRealtimePublisher
{
    string? Tenant { get; }

    /// <summary>A view of this publisher for another tenant. It shares the per-channel queues.</summary>
    IRealtimePublisher ForTenant(string tenant);

    /// <summary>
    /// Publishes one envelope. Publishes to the same channel are sent one at a time, in call order,
    /// so retries never reorder messages. Different channels publish concurrently.
    /// </summary>
    Task<PublishResult> PublishAsync(string channel, string type, object data, string? corr = null, CancellationToken ct = default);

    /// <summary>Completes when every publish queued so far has finished.</summary>
    Task IdleAsync();
}

public sealed class RealtimePublisher : IRealtimePublisher
{
    private readonly Core _core;
    private readonly TenantContext _context;

    public RealtimePublisher(RealtimePublisherOptions options, ICentrifugoTransport transport, ILoggerFactory? loggers = null)
    {
        var allowGlobal = options.AllowGlobal ?? Environment.GetEnvironmentVariable("RTB_ALLOW_GLOBAL") == "true";
        _core = new Core(options, transport, (loggers ?? NullLoggerFactory.Instance).CreateLogger("Rtb.Audit"));
        _context = new TenantContext(options.Tenant, allowGlobal);
    }

    private RealtimePublisher(Core core, TenantContext context)
    {
        _core = core;
        _context = context;
    }

    public string? Tenant => _context.Tenant;

    public IRealtimePublisher ForTenant(string tenant) => new RealtimePublisher(_core, _context with { Tenant = tenant });

    public Task<PublishResult> PublishAsync(string channel, string type, object data, string? corr = null, CancellationToken ct = default)
    {
        var options = _core.Options;
        var parsed = Channel.TryParse(channel);
        var tenant = parsed?.IsGlobal == true ? "global" : _context.Tenant ?? "";
        var audit = new AuditEntry(options.Source, tenant, channel, type);

        var guard = TenantGuard.Check(_context, channel, tenant);
        if (!guard.Allow)
        {
            _core.Audit(audit with { Outcome = "denied", Reason = guard.Reason });
            return Task.FromException<PublishResult>(new TenantGuardException(guard.Reason!, channel));
        }

        Envelope envelope;
        try
        {
            envelope = Envelopes.Create(type, tenant, options.Source, data, corr);
        }
        catch (ArgumentException e)
        {
            _core.Audit(audit with { Outcome = "denied", Reason = e.Message });
            return Task.FromException<PublishResult>(e);
        }
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(envelope));
        if (bytes.Length > Envelopes.MaxBytes)
        {
            _core.Audit(audit with { Id = envelope.Id, Outcome = "too_large", Reason = $"{bytes.Length} bytes" });
            return Task.FromException<PublishResult>(new EnvelopeTooLargeException(bytes.Length, channel));
        }

        return _core.Enqueue(channel, async () =>
        {
            var attempts = 0;
            try
            {
                var (offset, epoch) = await _core.SendWithRetry(channel, bytes, envelope.Id, () => ++attempts, ct);
                _core.Audit(audit with { Id = envelope.Id, Outcome = "ok", Attempts = attempts });
                return new PublishResult(envelope, offset, epoch);
            }
            catch (Exception e)
            {
                _core.Audit(audit with { Id = envelope.Id, Outcome = "failed", Reason = e.Message, Attempts = attempts });
                throw;
            }
        });
    }

    public Task IdleAsync() => _core.IdleAsync();

    private sealed record AuditEntry(string Component, string Tenant, string Channel, string Type)
    {
        public string? Id { get; init; }
        public string Outcome { get; init; } = "";
        public string? Reason { get; init; }
        public int Attempts { get; init; }
    }

    private sealed class Core(RealtimePublisherOptions options, ICentrifugoTransport transport, ILogger audit)
    {
        private readonly Lock _gate = new();
        private readonly Dictionary<string, Task> _tails = new();

        public RealtimePublisherOptions Options { get; } = options;

        public void Audit(AuditEntry e) =>
            audit.Log(e.Outcome == "ok" ? LogLevel.Information : LogLevel.Warning,
                "rtb.audit {Component} {Tenant} {Channel} {Type} {Id} {Outcome} {Reason} {Attempts}",
                e.Component, e.Tenant, e.Channel, e.Type, e.Id, e.Outcome, e.Reason, e.Attempts);

        public Task<T> Enqueue<T>(string channel, Func<Task<T>> work)
        {
            lock (_gate)
            {
                var prev = _tails.GetValueOrDefault(channel) ?? Task.CompletedTask;
                var next = RunAfter(prev, work);
                Task tail = next.ContinueWith(static _ => { }, TaskScheduler.Default);
                _tails[channel] = tail;
                tail.ContinueWith(_ =>
                {
                    lock (_gate)
                    {
                        if (_tails.GetValueOrDefault(channel) == tail) _tails.Remove(channel);
                    }
                }, TaskScheduler.Default);
                return next;
            }
        }

        private static async Task<T> RunAfter<T>(Task prev, Func<Task<T>> work)
        {
            await prev;
            return await work();
        }

        public async Task IdleAsync()
        {
            while (true)
            {
                Task[] pending;
                lock (_gate) pending = _tails.Values.ToArray();
                if (pending.Length == 0) return;
                await Task.WhenAll(pending);
            }
        }

        public async Task<(ulong?, string?)> SendWithRetry(string channel, byte[] data, string key, Func<int> countAttempt, CancellationToken ct)
        {
            var started = DateTime.UtcNow;
            for (var i = 0; ; i++)
            {
                countAttempt();
                try
                {
                    return await transport.PublishAsync(channel, data, key, ct);
                }
                catch (Exception e) when (!ct.IsCancellationRequested)
                {
                    var transient = e is not PublishException pe || pe.Transient;
                    var cap = Math.Min(Options.RetryMaxDelay.TotalMilliseconds, Options.RetryBaseDelay.TotalMilliseconds * Math.Pow(2, i));
                    var delay = TimeSpan.FromMilliseconds(Random.Shared.NextDouble() * cap);
                    if (!transient || i + 1 >= Options.RetryAttempts || DateTime.UtcNow - started + delay > Options.RetryTotal) throw;
                    await Task.Delay(delay, ct);
                }
            }
        }
    }
}
