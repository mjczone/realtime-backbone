import type { Message } from '@ag-ui/client';
import { CentrifugoAgent, type RunRef } from '@mjczone/realtime-agui-client';
import { UnauthorizedError, createRealtimeClient } from '@mjczone/realtime-client';
import { Channels } from '@mjczone/realtime-contract';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const local = (key: string, make: () => string) => {
  try {
    const v = localStorage.getItem(key) ?? make();
    localStorage.setItem(key, v);
    return v;
  } catch {
    return make();
  }
};

const user = local('rtb.chat.user', () => `u_${Math.random().toString(36).slice(2, 8)}`);
const threadId = local('rtb.chat.thread', () => crypto.randomUUID());
const headers = () => ({ 'Content-Type': 'application/json', 'X-Demo-User': user });

async function api(path: string, body?: unknown) {
  const r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: headers(), body: JSON.stringify(body) });
  if (r.status === 401 || r.status === 403) throw new UnauthorizedError(`${path}: HTTP ${r.status}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

const config = await api('/api/config');
$('title').textContent = `Chat with ${config.agentName}`;
$('user').textContent = user;
$('thread').textContent = threadId.slice(0, 8);
const status = (s: string) => ($('status').textContent = s);

const client = createRealtimeClient({
  url: config.backboneUrl,
  getConnectionToken: async () => (await api('/api/token/connection', {})).token,
  getSubscriptionToken: async (channel) => (await api('/api/token/subscription', { channel })).token,
});
client.connect();

const agent = new CentrifugoAgent({
  client,
  agentId: 'chat',
  threadId,
  runUrl: '/api/run',
  headers,
  cancelUrl: (run) => `/api/run/${run.runId}/cancel`,
});

function render() {
  const box = $('messages');
  box.innerHTML = '';
  for (const m of agent.messages as Message[]) {
    const div = document.createElement('div');
    div.className = `msg ${m.role}`;
    const role = document.createElement('span');
    role.className = 'role';
    role.textContent = m.role;
    div.append(role);
    let text = typeof m.content === 'string' ? m.content : '';
    if (m.role === 'assistant' && m.toolCalls?.length) {
      text += m.toolCalls.map((t) => `${text ? '\n' : ''}calls ${t.function.name}(${t.function.arguments})`).join('\n');
    }
    div.append(document.createTextNode(text));
    box.append(div);
  }
}

agent.subscribe({
  onMessagesChanged: render,
  onRunStartedEvent: () => status('running'),
  onRunErrorEvent: ({ event }) => status(`error: ${event.message}`),
  onRunFinalized: () => {
    if (!$('status').textContent?.startsWith('error')) status('idle');
  },
});

async function loadThread() {
  const t = await api(`/api/threads/${threadId}`);
  agent.setMessages(t.messages);
  render();
}

async function join(run?: RunRef) {
  if (agent.isRunning) return;
  await loadThread();
  if (run) agent.attach(run);
  if (run || agent.storedRun) {
    status('joining run');
    await agent.connectAgent().catch((e) => status(`error: ${e.message}`));
  }
}

$('form').onsubmit = async (e) => {
  e.preventDefault();
  const content = $<HTMLInputElement>('prompt').value.trim();
  if (!content || agent.isRunning) return;
  $<HTMLInputElement>('prompt').value = '';
  agent.addMessage({ id: crypto.randomUUID(), role: 'user', content });
  render();
  status('starting');
  await agent.runAgent().catch((err) => status(`error: ${err.message}`));
};
$('cancel').onclick = () => agent.abortRun();
$('background').onclick = () => api('/api/background-run', { threadId, prompt: 'What is the weather in Paris?' });
$('newThread').onclick = () => {
  localStorage.removeItem('rtb.chat.thread');
  location.reload();
};

client.subscribe<RunRef>(Channels.user(config.tenant, user), (e) => {
  if (e.type !== 'notice.run_started' || e.data.threadId !== threadId) return;
  $('notice').textContent = `run ${e.data.runId.slice(-6)} started ${new Date(e.ts).toLocaleTimeString()}`;
  void join(e.data);
});

await join();
