import { expect, test, type Browser, type Page } from '@playwright/test';

// The Mastra + .NET sample: page and REST API on 3010, Mastra agent service on 3011. On 3012 the same sample runs
// through rtb-gateway.
const APP = process.env.RTB_MDN_URL ?? 'http://localhost:3010';
const TAIL = 'picks up where it left off.';

async function signIn(page: Page, user: string) {
  await page.goto(APP);
  await page.fill('#userId', user);
  await page.click('#loginForm button');
  await expect(page.locator('#who')).toHaveText(`signed in as ${user}`);
  await expect(page.locator('#status')).toHaveText('idle', { timeout: 15000 });
}

async function newUser(browser: Browser, user: string) {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, user);
  return page;
}

async function ask(page: Page, text: string) {
  await page.fill('#prompt', text);
  await page.click('#send');
}

const lastAnswer = (page: Page) => page.locator('.msg.assistant').last();

test.beforeEach(async ({ request }) => {
  // Start every test from an empty task list.
  const { accessToken } = await (await request.post(`${APP}/api/login`, { data: { userId: 'cleaner' } })).json();
  await request.delete(`${APP}/api/tasks`, { headers: { Authorization: `Bearer ${accessToken}` } });
});

test('the agent adds a task through the .NET API and the list updates live', async ({ browser }) => {
  const ann = await newUser(browser, 'ann');
  const bob = await newUser(browser, 'bob');
  await ask(ann, 'add a task: buy milk');
  await expect(lastAnswer(ann)).toContainText('Added "buy milk" to your tasks.', { timeout: 30000 });
  await expect(lastAnswer(ann)).toContainText(TAIL);
  await expect(ann.locator('.msg.assistant').first()).toContainText('createTask');
  for (const p of [ann, bob]) await expect(p.locator('#tasks')).toContainText('buy milk (ann)');
});

test('a task added with the REST form shows up for everyone, and the agent can list it', async ({ browser }) => {
  const ann = await newUser(browser, 'ann');
  const bob = await newUser(browser, 'bob');
  await bob.fill('#taskTitle', 'call the bank');
  await bob.click('#taskForm button');
  await expect(ann.locator('#tasks')).toContainText('call the bank (bob)');
  await ask(ann, 'list my tasks');
  await expect(lastAnswer(ann)).toContainText('You have 1 task: call the bank.', { timeout: 30000 });
});

test('a frontend tool runs in the page, then the agent finishes', async ({ browser }) => {
  const ann = await newUser(browser, 'ann');
  await ask(ann, 'switch to dark mode');
  await expect(lastAnswer(ann)).toContainText('Done, the theme is now dark.', { timeout: 30000 });
  await expect(ann.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(ann.locator('#status')).toHaveText('idle');
  await ask(ann, 'back to light mode please');
  await expect(lastAnswer(ann)).toContainText('Done, the theme is now light.', { timeout: 30000 });
  await expect(ann.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('deleting needs approval, and approving runs it', async ({ browser }) => {
  const ann = await newUser(browser, 'ann');
  await ann.fill('#taskTitle', 'old task');
  await ann.click('#taskForm button');
  await expect(ann.locator('#tasks')).toContainText('old task');
  await ask(ann, 'delete all tasks');
  await expect(ann.locator('#approval')).toBeVisible({ timeout: 30000 });
  await expect(ann.locator('#approvalText')).toContainText('deleteAllTasks');
  await expect(ann.locator('#tasks')).toContainText('old task');
  await ann.click('#approve');
  await expect(lastAnswer(ann)).toContainText('Deleted 1 tasks.', { timeout: 30000 });
  await expect(ann.locator('#tasks')).toContainText('No tasks');
  await expect(ann.locator('#approval')).toBeHidden();
});

test('rejecting leaves the tasks alone', async ({ browser }) => {
  const ann = await newUser(browser, 'ann');
  await ann.fill('#taskTitle', 'keep me');
  await ann.click('#taskForm button');
  await ask(ann, 'delete all tasks');
  await expect(ann.locator('#approval')).toBeVisible({ timeout: 30000 });
  await ann.click('#reject');
  await expect(lastAnswer(ann)).toContainText('OK, I left your tasks alone.', { timeout: 30000 });
  await expect(ann.locator('#tasks')).toContainText('keep me');
});

test('the approval prompt survives a reload', async ({ browser }) => {
  const ann = await newUser(browser, 'ann');
  await ann.fill('#taskTitle', 'still here');
  await ann.click('#taskForm button');
  await ask(ann, 'delete all tasks');
  await expect(ann.locator('#approval')).toBeVisible({ timeout: 30000 });
  await ann.reload();
  await expect(ann.locator('#approval')).toBeVisible({ timeout: 15000 });
  await ann.click('#approve');
  await expect(lastAnswer(ann)).toContainText('Deleted 1 tasks.', { timeout: 30000 });
});

test('a reload mid-answer resumes it once', async ({ browser }) => {
  const ann = await newUser(browser, 'ann');
  await ask(ann, 'add a task: water the plants');
  await expect(lastAnswer(ann)).toContainText('Added', { timeout: 30000 });
  await ann.reload();
  await expect(lastAnswer(ann)).toContainText(TAIL, { timeout: 30000 });
  const answers = await ann.locator('.msg.assistant').evaluateAll((els) => els.map((e) => e.textContent ?? '').filter((t) => t.includes('Added')));
  expect(answers).toHaveLength(1);
  expect(answers[0].split('Added').length).toBe(2);
});

test('the run endpoint refuses calls without a valid access token', async ({ request }) => {
  const config = await (await request.get(`${APP}/api/config`)).json();
  const runUrl = config.gatewayUrl ? `${config.gatewayUrl}/v1/agents/tasks/runs` : `${config.agentUrl}/api/run`;
  const res = await request.post(runUrl, { data: { messages: [] } });
  expect(res.status()).toBe(401);
  const forged = await request.post(runUrl, {
    data: { messages: [] },
    headers: { Authorization: 'Bearer not.a.token' },
  });
  expect(forged.status()).toBe(401);
});
