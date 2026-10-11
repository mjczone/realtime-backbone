import { expect, test, type Page } from '@playwright/test';

const STORY =
  'This is a scripted agent run. Each word is a text delta, batched every 75 ms before it is published ' +
  'to a replay channel. Reload the page while this is still typing: the page resubscribes from its last ' +
  'position and the backbone sends what it missed, so nothing is lost or repeated. Open a second tab to ' +
  'watch the same run from another viewer. When the text stops, a RUN_FINISHED event closes the run. ';

async function connected(page: Page) {
  await expect(page.locator('#state')).toContainText('connected', { timeout: 15000 });
}

for (const transport of ['websocket', 'sse', 'http_stream']) {
  test(`job ticks arrive over ${transport}`, async ({ page }) => {
    await page.goto(`/?transport=${transport}`);
    await connected(page);
    await expect(page.locator('#state')).toContainText(transport);
    await expect(page.locator('#jobText')).toContainText('%', { timeout: 10000 });
  });
}

test('a reload mid-run resumes the full message with no duplicates', async ({ page }) => {
  await page.goto('/');
  await connected(page);
  await page.click('#startRun');
  await expect(page.locator('#runText')).toContainText('scripted agent', { timeout: 10000 });
  await page.reload();
  await connected(page);
  await expect(page.locator('#runStatus')).toHaveText('finished', { timeout: 60000 });
  expect(await page.locator('#runText').textContent()).toBe(STORY);
});

test('two tabs watch one run', async ({ context }) => {
  const a = await context.newPage();
  await a.goto('/');
  await connected(a);
  await a.click('#startRun');
  await expect(a.locator('#runText')).toContainText('scripted', { timeout: 10000 });

  const b = await context.newPage();
  await b.goto('/');
  await connected(b);
  await b.click('#watchLast');
  for (const p of [a, b]) {
    await expect(p.locator('#runStatus')).toHaveText('finished', { timeout: 60000 });
    expect(await p.locator('#runText').textContent()).toBe(STORY);
  }
  // At least the two tabs; a tab closed by the previous test can take a moment to leave presence.
  await expect.poll(() => b.locator('#roster li').count()).toBeGreaterThanOrEqual(2);
  await expect(a.locator('#notices li').first()).toContainText('notice.run_started');
});

test('another user cannot watch the run', async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage();
  await owner.goto('/');
  await connected(owner);
  await owner.click('#startRun');
  await expect(owner.locator('#runText')).toContainText('scripted', { timeout: 10000 });
  const lastRun = await owner.evaluate(() => localStorage.getItem('rtb.lastRun'));

  const otherCtx = await browser.newContext();
  await otherCtx.addInitScript((run) => localStorage.setItem('rtb.lastRun', run!), lastRun);
  const other = await otherCtx.newPage();
  await other.goto('/');
  await connected(other);
  await other.click('#watchLast');
  await expect(other.locator('#runStatus')).toContainText('error', { timeout: 15000 });
  await expect(other.locator('#runText')).toHaveText('');
});
