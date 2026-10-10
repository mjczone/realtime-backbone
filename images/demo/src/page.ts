import { Channels, type Envelope } from '@rtb/contract';
import { UnauthorizedError, createRealtimeClient, type RealtimeSubscription, type StreamPosition } from '@rtb/client';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
  get: (s: Storage, k: string) => {
    try {
      return JSON.parse(s.getItem(k) ?? 'null');
    } catch {
      return null;
    }
  },
  set: (s: Storage, k: string, v: unknown) => {
    try {
      s.setItem(k, JSON.stringify(v));
    } catch {
      /* storage may be blocked */
    }
  },
};

const params = new URLSearchParams(location.search);
const user: string = store.get(localStorage, 'rtb.user') ?? `u_${Math.random().toString(36).slice(2, 8)}`;
store.set(localStorage, 'rtb.user', user);
const transport = params.get('transport') ?? 'websocket';
$<HTMLInputElement>('user').value = user;
$<HTMLSelectElement>('transport').value = transport;
$('apply').onclick = () => {
  store.set(localStorage, 'rtb.user', $<HTMLInputElement>('user').value.trim() || user);
  location.search = `?transport=${$<HTMLSelectElement>('transport').value}`;
};

const post = async (path: string, body?: unknown) => {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Demo-User': user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401 || r.status === 403) throw new UnauthorizedError(`${path}: HTTP ${r.status}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
};

const config = await (await fetch('/api/config')).json();
const tenant: string = config.tenant;
const transports = transport === 'websocket' ? undefined : [transport as 'sse' | 'http_stream'];

const client = createRealtimeClient({
  url: config.backboneUrl,
  transports,
  getConnectionToken: async () => (await post('/api/token/connection')).token,
  getSubscriptionToken: async (channel) => (await post('/api/token/subscription', { channel })).token,
});
client.onStateChange((s) => ($('state').textContent = `${s} (${transport})`));
client.connect();

client.subscribe<{ pct: number; step?: string }>(Channels.record(tenant, 'jobs', 'demo-job'), (e) => {
  $('jobBar').style.width = `${e.data.pct}%`;
  $('jobText').textContent = `${e.data.pct}% ${e.data.step ?? ''} · ${new Date(e.ts).toLocaleTimeString()}`;
});

interface RunRef {
  channel: string;
  offset: number;
  epoch: string;
}

let runSub: RealtimeSubscription | null = null;

function watchRun(run: RunRef) {
  runSub?.unsubscribe();
  store.set(sessionStorage, 'rtb.run', run);
  $('runChannel').textContent = run.channel;
  $('runText').textContent = '';
  $('runStatus').textContent = 'subscribing…';
  const since: StreamPosition = { offset: run.offset - 1, epoch: run.epoch };
  runSub = client.subscribe<Record<string, string>>(
    run.channel,
    (e: Envelope<Record<string, string>>) => {
      if (e.type === 'agui.RUN_STARTED') $('runStatus').textContent = 'running';
      if (e.type === 'agui.TEXT_MESSAGE_CONTENT') $('runText').textContent += e.data.delta;
      if (e.type === 'agui.RUN_FINISHED') {
        $('runStatus').textContent = 'finished';
        store.set(sessionStorage, 'rtb.run', null);
      }
    },
    {
      since,
      onSubscribed: (info) => {
        if (info.wasRecovering && !info.recovered) $('runStatus').textContent = 'history expired: load the result from the app';
      },
      onFailed: (err) => ($('runStatus').textContent = `error ${err.code}: ${err.message}`),
    },
  );
}

$('startRun').onclick = async () => {
  const r = await post('/api/runs');
  const run = { channel: r.channel, offset: r.offset, epoch: r.epoch };
  store.set(localStorage, 'rtb.lastRun', run);
  watchRun(run);
};
$('watchLast').onclick = () => {
  const last = store.get(localStorage, 'rtb.lastRun');
  if (last) watchRun(last);
};
const active = store.get(sessionStorage, 'rtb.run');
if (active) watchRun(active);

const members = new Map<string, string>();
const drawRoster = () => {
  $('roster').innerHTML = '';
  for (const name of [...members.values()].sort()) {
    const li = document.createElement('li');
    li.textContent = name === user ? `${name} (you)` : name;
    $('roster').append(li);
  }
};
const presence = client.subscribe(Channels.presence(tenant, 'room', 'lobby'), () => {}, {
  onSubscribed: async () => {
    members.clear();
    for (const m of await presence.roster()) members.set(m.clientId, m.userId);
    drawRoster();
  },
  onJoin: (m) => {
    members.set(m.clientId, m.userId);
    drawRoster();
  },
  onLeave: (m) => {
    members.delete(m.clientId);
    drawRoster();
  },
});

const userChannel = Channels.user(tenant, user);
$('userChannel').textContent = userChannel;
client.subscribe<{ channel: string }>(userChannel, (e) => {
  const li = document.createElement('li');
  li.innerHTML = `<code>${e.type}</code> ${new Date(e.ts).toLocaleTimeString()} `;
  li.append(document.createTextNode(e.data.channel ?? ''));
  $('notices').prepend(li);
});
