import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';

// Optional test dependency; never included in the production bundle.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const profiles = JSON.parse(await readFile('adk_service/cases/profiles.json', 'utf8')).slice(0, 2);
const cases = profiles.map(({ id, caseType, issueLabel, localizedTitle, client, avatarBaseline }) => ({
  id, caseType, issueLabel, localizedTitle, avatarBaseline,
  client: { displayName: client.displayName, presentingContext: client.presentingContext }, hiddenFacts: [],
}));
const child = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0', APP_AUTH_ENABLED: 'false',
    ADK_SERVICE_URL: 'http://127.0.0.1:1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(child, 'exit');
let browser;
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview start timed out')), 5000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Preview exited')); });
    child.stdout.on('data', (data) => {
      const match = String(data).match(/running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(12000);
  await page.addInitScript(() => {
    window.speechSynthesis.speak = () => {};
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let startCount = 0;
  let turnFailure = true;
  let holdTurn;
  let releaseTurn;
  let holdReview;
  let releaseReview;
  let reviewFailure = true;
  const requests = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON() ?? {};
    const reply = (data, status = 200) => route.fulfill({ status, json: data });
    if (path === '/api/auth/session') return reply({ authenticated: true, username: 'test', role: 'trainee', authEnabled: true });
    if (path === '/api/cases') return reply({ cases });
    if (path === '/api/session/start' || path === '/api/session/reset') {
      startCount += 1;
      if (startCount === 1) return reply({ error: 'service_unavailable' }, 503);
      return reply({ sessionId: `session-${startCount}`, stateVersion: 0,
        sessionView: cases.find((item) => item.id === body.caseProfile.id) });
    }
    if (path === '/api/interview-turn') {
      requests.push(body);
      if (holdTurn) await holdTurn;
      if (turnFailure) { turnFailure = false; return reply({ detail: 'provider_failed' }, 500); }
      return reply({ clientText: body.studentText === 'old case' ? 'Obsolete reply' : 'Accepted reply',
        affect: 'neutral', riskSignals: [], revealedFacts: [], resistanceLevel: 'unavailable', stateDelta: {},
        motionCue: 'neutral', turnId: body.turnId, sessionId: body.sessionId,
        responseId: body.turnId, stateVersion: 1, sessionView: cases[0] });
    }
    if (path === '/api/session/final-review') {
      if (holdReview) await holdReview;
      if (reviewFailure) { reviewFailure = false; return reply({ error: 'service_unavailable' }, 503); }
    }
    return reply({ error: 'Mock endpoint unavailable' }, 503);
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByRole('button', { name: '重試連線', exact: true }).click();
  const input = page.locator('textarea');
  await input.fill('hello');
  await page.getByRole('button', { name: '送出', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await input.inputValue(), 'hello');
  await page.getByRole('button', { name: '重試', exact: true }).click();
  await page.getByText('Accepted reply', { exact: true }).waitFor();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].turnId, requests[1].turnId, 'Retry must reuse the turn ID');

  holdReview = new Promise((resolve) => { releaseReview = resolve; });
  await page.getByRole('button', { name: '結束訪談並生成報告', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('textarea').disabled);
  releaseReview();
  await page.getByRole('alert').waitFor();
  await input.fill('old case');
  holdTurn = new Promise((resolve) => { releaseTurn = resolve; });
  await page.getByRole('button', { name: '重試', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('textarea').disabled);
  await page.locator('.toolbarCaseSelector select').selectOption(cases[1].id);
  await input.fill('new case draft');
  releaseTurn();
  await page.waitForTimeout(300);
  assert.equal(await page.getByText('Obsolete reply', { exact: true }).count(), 0);
  assert.equal(await input.inputValue(), 'new case draft');
  assert.equal(await page.getByTitle('督導控制台').count(), 0);

  const directory = process.env.DESKTOP_SCREENSHOT_DIR || '/tmp/social-work-desktop-check';
  await mkdir(directory, { recursive: true });
  await page.waitForTimeout(1500);
  for (const [width, height] of [[1280, 720], [1440, 900], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(dimensions.scroll <= dimensions.width, `Horizontal overflow at ${width}`);
    const bounds = await input.boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height, `Composer clipped at ${width}`);
    await page.screenshot({ path: `${directory}/${width}x${height}.png` });
  }
  assert.deepEqual(errors, []);
  console.log(`Passed startup recovery, idempotent retry, report lock/recovery, stale-case response and three desktop sizes. Screenshots: ${directory}`);
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
  if (child.exitCode === null && child.signalCode === null) await exited;
}
