import { expect, test, type Page } from '@playwright/test';

// Runs against a chat sample: RTB_SAMPLE_URL=http://localhost:3001 (Mastra) or :3002 (MAF).
const SAMPLE = process.env.RTB_SAMPLE_URL ?? 'http://localhost:3001';
const ANSWER_END = 'it picks up where it left off.';

const assistantTexts = (page: Page) =>
  page.locator('.msg.assistant').evaluateAll((els) => els.map((e) => e.textContent!.replace(/^assistant/, '').trim()).filter(Boolean));

async function open(page: Page) {
  await page.goto(SAMPLE);
  await expect(page.locator('#status')).toHaveText('idle', { timeout: 15000 });
}

async function send(page: Page, text = 'What is the weather in Paris?') {
  await page.fill('#prompt', text);
  await page.click('#send');
}

test('a run streams a tool call and the answer', async ({ page }) => {
  await open(page);
  await send(page);
  await expect(page.locator('.msg.assistant').last()).toContainText(ANSWER_END, { timeout: 30000 });
  await expect(page.locator('#status')).toHaveText('idle');
  await expect(page.locator('.msg.assistant').first()).toContainText('getWeather');
  await expect(page.locator('.msg.tool')).toContainText('sunny');
});

test('a reload mid-run resumes the answer once', async ({ page }) => {
  await open(page);
  await send(page);
  await expect(page.locator('.msg.assistant').last()).toContainText('sunny in Paris', { timeout: 30000 });
  await page.reload();
  await expect(page.locator('.msg.assistant').last()).toContainText(ANSWER_END, { timeout: 30000 });
  const texts = await assistantTexts(page);
  const answers = texts.filter((t) => t.includes('scripted model'));
  expect(answers).toHaveLength(1);
  expect(answers[0].split('scripted model').length).toBe(2);
});

test('a second tab joins the run', async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await open(a);
  await open(b);
  await send(a);
  for (const p of [a, b]) {
    await expect(p.locator('.msg.assistant').last()).toContainText(ANSWER_END, { timeout: 30000 });
  }
  await expect(b.locator('.msg.user').last()).toContainText('weather in Paris');
});

test('a background run reaches the page through the user channel', async ({ page }) => {
  await open(page);
  await page.click('#background');
  await expect(page.locator('#notice')).toContainText('started', { timeout: 10000 });
  await expect(page.locator('.msg.assistant').last()).toContainText(ANSWER_END, { timeout: 30000 });
});

test('cancel stops the run', async ({ page }) => {
  await open(page);
  await send(page);
  await expect(page.locator('.msg.assistant').last()).toContainText('sunny in Paris', { timeout: 30000 });
  await page.click('#cancel');
  await expect(page.locator('#status')).not.toHaveText('running', { timeout: 10000 });
  await page.waitForTimeout(3000);
  expect((await assistantTexts(page)).join(' ')).not.toContain(ANSWER_END);
});
