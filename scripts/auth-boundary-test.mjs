import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';

const secret = 'local-test-only-secret';
const basic = (username) => `Basic ${Buffer.from(`${username}:test-password`).toString('base64')}`;
let upgrades = 0;
let upgradeHeaders;
const upstream = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ headers: req.headers, path: req.url }));
});
upstream.on('upgrade', (req, socket) => {
  upgrades += 1;
  upgradeHeaders = req.headers;
  socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const child = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0',
    APP_AUTH_ENABLED: 'true', APP_AUTH_SECRET: secret, APP_AUTH_COOKIE_SECURE: 'false',
    APP_AUTH_USERS_JSON: JSON.stringify(['trainee', 'instructor'].map((role) => ({ username: role, password: 'test-password', role }))),
    ADK_SERVICE_URL: `http://127.0.0.1:${upstream.address().port}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });
const exited = once(child, 'exit');

function websocket(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('Upgrade timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write([
      'GET /api/voice-stream HTTP/1.1', 'Host: localhost', 'Connection: Upgrade', 'Upgrade: websocket',
      'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`), '', '',
    ].join('\r\n')));
    socket.on('data', (chunk) => {
      received += chunk;
      if (received.includes('\r\n\r\n')) { resolve(received); socket.destroy(); }
    });
    socket.on('end', () => resolve(received));
  });
}

try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server start timed out: ${stderr}`)), 5000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(stderr || 'Server exited before ready')); });
    child.stdout.on('data', (data) => {
      const match = String(data).match(/running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  const url = `http://127.0.0.1:${port}`;
  const request = (path, headers = {}) => fetch(url + path, { headers, signal: AbortSignal.timeout(3000) });
  for (const path of ['/', '/api/health', '/api/cases', '/instructor']) {
    const response = await request(path);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /Basic/);
  }
  const auth = { Authorization: basic('trainee') };
  const login = await request('/api/auth/session', auth);
  assert.equal((await login.json()).role, 'trainee');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await request('/api/auth/session', { Cookie: cookie })).status, 200);
  for (const path of ['/instructor', '/instructor/evidence', '/%69nstructor', '/api/evidence-cards?limit=1',
    '/api/%65vidence-cards', '/api/session/export', '/api/shutdown', '/api/shutdown?confirm=1', '/api/%73hutdown?confirm=1',
    '/api/shutdown/', '/api/%73hutdown%2F?confirm=1', '/api/evidence-cards/']) {
    assert.equal((await request(path, auth)).status, 403, path);
  }
  const instructor = await request('/api/auth/session', { Authorization: basic('instructor') });
  assert.equal((await instructor.json()).role, 'instructor');
  assert.equal((await request('/instructor', { Authorization: basic('instructor') })).status, 200);
  const spoofed = await request('/api/cases', { ...auth, 'X-App-Role': 'instructor', 'X-App-Subject': 'victim' });
  const forwarded = (await spoofed.json()).headers;
  assert.equal(forwarded['x-app-role'], 'trainee');
  assert.equal(forwarded['x-app-subject'], Buffer.from('trainee').toString('base64url'));
  const payload = Buffer.from(JSON.stringify({ username: 'trainee', role: 'trainee', exp: Date.now() - 1000 })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  assert.equal((await request('/api/cases', { Cookie: `sw_auth=${payload}.${signature}` })).status, 401);
  assert.equal((await request('/api/cases', { Cookie: cookie + 'invalid' })).status, 401);
  assert.match(await websocket(port), /^HTTP\/1.1 401/);
  assert.equal(upgrades, 0);
  assert.match(await websocket(port, { Cookie: cookie, 'X-App-Role': 'instructor', 'X-App-Subject': 'victim' }), /^HTTP\/1.1 101/);
  assert.equal(upgrades, 1);
  assert.equal(upgradeHeaders['x-app-role'], 'trainee');
  assert.equal(upgradeHeaders['x-app-subject'], Buffer.from('trainee').toString('base64url'));
  console.log('Passed HTTP/cookie roles, encoded/query routes, forged identity, and authenticated WebSocket forwarding.');
} finally {
  child.kill('SIGTERM');
  if (child.exitCode === null && child.signalCode === null) await exited;
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
}
