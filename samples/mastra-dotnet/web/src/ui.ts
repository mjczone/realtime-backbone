// The page's UI: a plain @ag-ui/client page (no CopilotKit). The .NET API serves it and owns login, tasks and threads;
// the Mastra service runs the agent; events arrive over the backbone through CentrifugoAgent. app.ts and gateway.ts
// differ only in how they connect.
import type { Message, Tool, buildResumeArray } from '@ag-ui/client';
import type { CentrifugoAgent, RunRef } from '@rtb/agui-client';
import type { RealtimeClient } from '@rtb/client';
import type { Channels } from '@rtb/contract';

export interface Session {
  accessToken: string;
  userId: string;
  tenant: string;
}
export interface Config {
  backboneUrl: string;
  agentUrl: string;
  gatewayUrl: string | null;
}
export interface Realtime {
  client: RealtimeClient;
  channels: typeof Channels;
  buildResumeArray: typeof buildResumeArray;
  agent: (threadId: string) => CentrifugoAgent;
}
/** Calls the .NET API as the signed-in user. */
export type Api = (method: string, path: string, body?: unknown) => Promise<any>;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* storage may be blocked */
    }
  },
};

// The page's own frontend tool: the agent asks for it, the page runs it.
const frontendTools: Tool[] = [
  {
    name: 'setTheme',
    description: 'Switch the page between light and dark',
    parameters: { type: 'object', properties: { theme: { type: 'string', enum: ['light', 'dark'] } }, required: ['theme'] },
  },
];
const frontendImpl: Record<string, (args: Record<string, unknown>) => unknown> = {
  setTheme: ({ theme }) => {
    applyTheme(theme === 'dark' ? 'dark' : 'light');
    return { applied: theme };
  },
};
function applyTheme(theme: string) {
  document.documentElement.dataset.theme = theme;
  store.set('mdn.theme', theme);
}
applyTheme(store.get('mdn.theme') ?? 'light');

export async function boot(connect: (s: Session, config: Config, api: Api) => Promise<Realtime>) {
  const config = (await (await fetch('/api/config')).json()) as Config;
  const session: Session | null = JSON.parse(store.get('mdn.session') ?? 'null');
  if (session) await start(session, config, connect);
}

$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: $<HTMLInputElement>('userId').value.trim() }),
  });
  if (!res.ok) return alert((await res.json()).error);
  store.set('mdn.session', JSON.stringify(await res.json()));
  location.reload();
};

async function start(s: Session, config: Config, connect: (s: Session, config: Config, api: Api) => Promise<Realtime>) {
  $('login').hidden = true;
  $('chat').hidden = false;
  $('side').hidden = false;
  $('who').textContent = `signed in as ${s.userId}`;
  const auth = { Authorization: `Bearer ${s.accessToken}` };
  const status = (t: string) => {
    $('status').textContent = t;
  };

  async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(path, { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401) {
      store.set('mdn.session', null);
      location.reload();
    }
    if (!res.ok) throw Object.assign(new Error(`${path}: HTTP ${res.status}`), { status: res.status });
    return res.json();
  }

  const { client, channels: Channels, buildResumeArray, agent: makeAgent } = await connect(s, config, api);

  // ---- Tasks: REST from the .NET API, refreshed live when the API publishes entity.changed ----
  async function loadTasks() {
    const tasks = (await api('GET', '/api/tasks')) as Array<{ id: string; title: string; createdBy: string }>;
    $('tasks').innerHTML = '';
    for (const t of tasks) {
      const li = document.createElement('li');
      li.textContent = `${t.title} `;
      const by = document.createElement('span');
      by.className = 'muted';
      by.textContent = `(${t.createdBy})`;
      li.append(by);
      $('tasks').append(li);
    }
    if (!tasks.length) $('tasks').innerHTML = '<li class="muted">No tasks</li>';
  }
  client.subscribe(Channels.record(s.tenant, 'tasks'), (e) => {
    if (e.type === 'entity.changed') void loadTasks();
  });
  void loadTasks();
  $('taskForm').onsubmit = async (e) => {
    e.preventDefault();
    const title = $<HTMLInputElement>('taskTitle').value.trim();
    if (!title) return;
    $<HTMLInputElement>('taskTitle').value = '';
    await api('POST', '/api/tasks', { title });
  };

  // ---- Chat ----
  const threadKey = `mdn.thread.${s.userId}`;
  const threadId = store.get(threadKey) ?? crypto.randomUUID();
  store.set(threadKey, threadId);
  const agent = makeAgent(threadId);

  function render() {
    $('messages').innerHTML = '';
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
      $('messages').append(div);
    }
  }
  agent.subscribe({
    onMessagesChanged: render,
    onRunStartedEvent: () => status('running'),
    onRunErrorEvent: ({ event }) => status(`error: ${event.message}`),
  });

  /**
   * Runs the agent, then handles what the run left for the page: frontend tool calls (run them, send the results in
   * a new run) and interrupts (ask the user, then resume).
   */
  async function runLoop(params: Parameters<typeof agent.runAgent>[0] = {}) {
    let pending: string[] = [];
    try {
      await agent.runAgent({ tools: frontendTools, ...params }, {
        onRunFinishedEvent: (p: any) => {
          pending = p.outcome === 'success' ? (p.pendingToolCallIds ?? []) : [];
        },
      });
    } catch (e) {
      status(`error: ${(e as Error).message}`);
      return;
    }
    const calls = (agent.messages as Message[])
      .flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []) : []))
      .filter((tc) => pending.includes(tc.id) && frontendImpl[tc.function.name]);
    if (calls.length) {
      for (const tc of calls) {
        const result = frontendImpl[tc.function.name](JSON.parse(tc.function.arguments || '{}'));
        agent.addMessage({ id: crypto.randomUUID(), role: 'tool', toolCallId: tc.id, content: JSON.stringify(result) } as Message);
      }
      render();
      return runLoop();
    }
    showApproval();
  }

  function showApproval() {
    const interrupt = (agent as any).pendingInterrupts?.[0];
    if (!interrupt) {
      $('approval').style.display = 'none';
      status('idle');
      return;
    }
    const mastra = interrupt.metadata?.mastra ?? {};
    $('approvalText').textContent = `The assistant wants to run ${mastra.toolName ?? 'a tool'}${mastra.args && Object.keys(mastra.args).length ? ` with ${JSON.stringify(mastra.args)}` : ''}. Allow it?`;
    $('approval').style.display = 'block';
    status('waiting for approval');
  }
  async function answer(approved: boolean) {
    const interrupts = (agent as any).pendingInterrupts ?? [];
    if (!interrupts.length) return;
    $('approval').style.display = 'none';
    const response = approved ? { status: 'resolved', payload: { approved: true } } : { status: 'cancelled' };
    await runLoop({ resume: buildResumeArray(interrupts, Object.fromEntries(interrupts.map((i: any) => [i.id, response]))) } as any);
  }
  $('approve').onclick = () => answer(true);
  $('reject').onclick = () => answer(false);

  async function join(run?: RunRef) {
    if (agent.isRunning) return;
    const t = await api('GET', `/api/threads/${threadId}`);
    agent.setMessages(t.messages);
    render();
    if (run) agent.attach(run);
    if (run || agent.storedRun) {
      status('joining run');
      await agent.connectAgent().catch((e) => status(`error: ${e.message}`));
      showApproval();
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
    await runLoop();
  };
  $('cancel').onclick = () => agent.abortRun();
  $('newThread').onclick = () => {
    store.set(threadKey, null);
    location.reload();
  };

  client.subscribe<RunRef>(Channels.user(s.tenant, s.userId), (e) => {
    if (e.type === 'notice.run_started' && e.data.threadId === threadId) void join(e.data);
  });
  await join();
  showApproval();
}
