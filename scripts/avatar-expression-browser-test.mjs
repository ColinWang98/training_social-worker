import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { default: sharp } = await import(process.env.SHARP_MODULE || 'sharp');
const child = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0', APP_AUTH_ENABLED: 'false', ADK_SERVICE_URL: 'http://127.0.0.1:1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(child, 'exit');
let browser;
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview start timed out')), 10000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Preview exited')); });
    child.stdout.on('data', (data) => {
      const match = String(data).match(/running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  const unexpected = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const profiles = JSON.parse(await readFile('adk_service/cases/profiles.json', 'utf8'));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { role: 'instructor', username: 'offline-test', authenticated: true, authEnabled: true } });
    if (url.pathname === '/api/cases') return route.fulfill({ json: { cases: profiles } });
    if (url.pathname === '/api/session/start') return route.fulfill({ json: { sessionId: 'offline', stateVersion: 0, sessionView: profiles[0] } });
    unexpected.push(url.pathname);
    return route.fulfill({ status: 503, json: { error: 'Offline test' } });
  });
  const output = process.env.EXPRESSION_SCREENSHOT_DIR || '/tmp/social-work-expression-check';
  await mkdir(output, { recursive: true });
  await page.goto(`http://127.0.0.1:${port}/instructor`);
  await page.getByRole('button', { name: 'Avatar 與語音', exact: true }).click();
  const lab = page.getByRole('region', { name: '表情校準', exact: true });
  const play = page.getByRole('button', { name: '播放測試序列', exact: true });
  const stop = page.getByRole('button', { name: '停止測試序列', exact: true });
  const summaries = [];
  for (const asset of ['john-do-arkit', 'streamoji-0sfg', 'haru']) {
    await page.locator('.instructorHeader select').selectOption(asset);
    await play.waitFor();
    await page.waitForFunction(() => !document.querySelector('button[aria-label="播放測試序列"]')?.disabled);
    await page.waitForTimeout(1200);
    const canvas = lab.locator('canvas');
    const before = await canvas.screenshot({ path: `${output}/${asset}-idle.png` });
    const pixels = await sharp(before).removeAlpha().raw().toBuffer();
    const colors = new Set();
    for (let i = 0; i < pixels.length; i += 21) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
    assert.ok(colors.size > 200, `${asset} canvas is blank or nearly uniform`);
    await play.click();
    await page.waitForTimeout(3500);
    await canvas.screenshot({ path: `${output}/${asset}-guarded-speaking.png` });
    await stop.click();
    await page.waitForTimeout(1200);
    assert.equal(await lab.locator('progress').getAttribute('value'), '0');
    assert.equal(await play.isEnabled(), true);
    summaries.push({ asset, colors: colors.size, readout: await lab.locator('dl').innerText() });
    if (asset === 'john-do-arkit') {
      await play.click();
      await page.waitForTimeout(12500);
      assert.equal(await play.isEnabled(), true, 'Completed sequence returns to idle');
      assert.equal(await lab.locator('progress').getAttribute('value'), '12000');
    }
  }
  for (const [width, height] of [[1280, 720], [1440, 900], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${output}/lab-${width}.png` });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, [], 'Lab must never request interview/TTS APIs');
  console.log(JSON.stringify({ passed: true, output, summaries }, null, 2));
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
  if (child.exitCode === null && child.signalCode === null) await exited;
}
