import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import net from 'node:net';

loadLocalEnv();

const port = Number(process.env.PORT ?? 5173);
const host = process.env.HOST ?? '127.0.0.1';
const adkServiceUrl = (process.env.ADK_SERVICE_URL ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
const isProduction = process.env.NODE_ENV === 'production';
const distDir = resolve('dist');
const authConfig = loadAuthConfig();

const vite = isProduction
  ? null
  : await createDevViteServer();

const server = createServer(async (req, res) => {
  try {
    const authResult = authenticateRequest(req);
    if (!authResult.ok) {
      return sendAuthChallenge(res);
    }
    if (authResult.setCookie) {
      req.authSetCookie = authResult.setCookie;
    }

    if (req.url === '/api/shutdown') {
      return handleShutdown(req, res);
    }

    if (req.url === '/api/health') {
      return proxyRequest(req, res, '/health');
    }

    if (req.url?.startsWith('/api/')) {
      return proxyRequest(req, res, req.url);
    }

    if (vite) {
      if (req.authSetCookie && !res.headersSent) {
        res.setHeader('Set-Cookie', req.authSetCookie);
      }
      vite.middlewares(req, res, (error) => {
        if (error) {
          vite.ssrFixStacktrace(error);
          sendJson(res, 500, { error: error.message });
        }
      });
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, host, () => {
  console.log(`Social Work Avatar Lab running at http://${host}:${port}/`);
  console.log(`Proxying app API routes to ADK service at ${adkServiceUrl}.`);
});

server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/api/voice-stream')) {
    socket.destroy();
    return;
  }
  if (!authenticateRequest(req).ok) {
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\n' +
        'WWW-Authenticate: Basic realm="Social Work Avatar Lab"\r\n' +
        'Connection: close\r\n' +
        '\r\n',
    );
    socket.destroy();
    return;
  }
  proxyWebSocketUpgrade(req, socket, head);
});

async function handleShutdown(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  if (!isLoopback(req.socket.remoteAddress)) {
    return sendJson(res, 403, { error: 'Shutdown is only available from localhost.' });
  }

  try {
    await fetch(`${adkServiceUrl}/api/shutdown`, { method: 'POST' });
  } catch {
    // ADK may already be down or managed by dev-all; still stop the local app server.
  }

  sendJson(res, 200, { ok: true, message: 'Local services are shutting down.' });
  setTimeout(async () => {
    try {
      await vite?.close();
    } finally {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    }
  }, 150).unref();
}

async function createDevViteServer() {
  const { createServer: createViteServer } = await import('vite');
  return createViteServer({
    server: { middlewareMode: true, host: '127.0.0.1' },
    appType: 'spa',
  });
}

function serveStatic(req, res) {
  if (!distDir || !existsSync(distDir)) {
    return sendJson(res, 500, { error: 'Production dist/ directory is missing. Run npm run build.' });
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const requestedPath = decodeURIComponent(url.pathname);
  const safePath = normalize(requestedPath).replace(/^(\.\.(\/|\\|$))+/, '');
  let filePath = join(distDir, safePath);

  if (!filePath.startsWith(distDir)) {
    return sendJson(res, 403, { error: 'Forbidden.' });
  }

  if (!existsSync(filePath) || isDirectory(filePath)) {
    filePath = join(distDir, 'index.html');
  }

  try {
    const body = readFileSync(filePath);
    res.writeHead(200, withAuthCookie(req, {
      'Content-Type': mimeType(filePath),
      'Cache-Control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
    }));
    res.end(body);
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

function isDirectory(filePath) {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function mimeType(filePath) {
  const extension = extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.vrm': 'model/gltf-binary',
    '.glb': 'model/gltf-binary',
    '.vrma': 'application/octet-stream',
  }[extension] ?? 'application/octet-stream';
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

async function proxyRequest(req, res, targetPath) {
  const body = await readRawBody(req);
  const headers = {
    'Content-Type': req.headers['content-type'] ?? 'application/json',
  };

  try {
    const response = await fetch(`${adkServiceUrl}${targetPath}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const responseBody = await response.text();
    res.writeHead(response.status, withAuthCookie(req, {
      'Content-Type': response.headers.get('content-type') ?? 'application/json',
    }));
    res.end(responseBody);
  } catch (error) {
    sendJson(res, 502, {
      error:
        `ADK service is unavailable at ${adkServiceUrl}. ` +
        'Start it with: python3 -m uvicorn adk_service.main:app --host 127.0.0.1 --port 8765',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function proxyWebSocketUpgrade(req, socket, head) {
  const target = new URL(adkServiceUrl);
  if (target.protocol !== 'http:') {
    socket.destroy(new Error('WebSocket proxy only supports local http ADK service URLs.'));
    return;
  }

  const upstream = net.connect(Number(target.port || 80), target.hostname);
  upstream.on('connect', () => {
    const headerLines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`, `Host: ${target.host}`];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      const name = req.rawHeaders[index];
      const value = req.rawHeaders[index + 1];
      if (name.toLowerCase() !== 'host') {
        headerLines.push(`${name}: ${value}`);
      }
    }
    upstream.write(`${headerLines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error('Request body too large.'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendAuthChallenge(res) {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Basic realm="Social Work Avatar Lab"',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ error: 'Authentication required.' }));
}

function withAuthCookie(req, headers) {
  if (req.authSetCookie) {
    return { ...headers, 'Set-Cookie': req.authSetCookie };
  }
  return headers;
}

function loadAuthConfig() {
  const enabled = isTruthy(process.env.APP_AUTH_ENABLED);
  const ttlSeconds = Number(process.env.APP_AUTH_TTL_SECONDS ?? 12 * 60 * 60);
  return {
    enabled,
    users: enabled ? loadAuthUsers() : [],
    secret: process.env.APP_AUTH_SECRET ?? '',
    cookieName: process.env.APP_AUTH_COOKIE_NAME ?? 'sw_auth',
    ttlSeconds: Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 12 * 60 * 60,
    secureCookie: isTruthy(process.env.APP_AUTH_COOKIE_SECURE),
  };
}

function loadAuthUsers() {
  if (process.env.APP_AUTH_USERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.APP_AUTH_USERS_JSON);
      if (!Array.isArray(parsed)) throw new Error('APP_AUTH_USERS_JSON must be an array.');
      return parsed
        .filter((user) => typeof user?.username === 'string' && typeof user?.password === 'string')
        .map((user) => ({ username: user.username, password: user.password }));
    } catch (error) {
      console.warn(`Invalid APP_AUTH_USERS_JSON: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  if (process.env.APP_AUTH_USERNAME && process.env.APP_AUTH_PASSWORD) {
    return [{ username: process.env.APP_AUTH_USERNAME, password: process.env.APP_AUTH_PASSWORD }];
  }

  return [];
}

function authenticateRequest(req) {
  if (!authConfig.enabled) return { ok: true };

  if (!authConfig.secret || authConfig.users.length === 0) {
    console.warn('APP_AUTH_ENABLED is true but APP_AUTH_SECRET or auth users are missing.');
    return { ok: false };
  }

  const cookieUsername = verifySessionCookie(req.headers.cookie);
  if (cookieUsername) return { ok: true };

  const basicUsername = verifyBasicAuth(req.headers.authorization);
  if (basicUsername) {
    return { ok: true, setCookie: createSessionCookie(basicUsername) };
  }

  return { ok: false };
}

function verifyBasicAuth(header) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator === -1) return null;

  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  const match = authConfig.users.find((user) => safeEqual(user.username, username) && safeEqual(user.password, password));
  return match?.username ?? null;
}

function createSessionCookie(username) {
  const expiresAt = Date.now() + authConfig.ttlSeconds * 1000;
  const payload = base64UrlEncode(JSON.stringify({ username, exp: expiresAt }));
  const signature = sign(payload);
  const parts = [
    `${authConfig.cookieName}=${payload}.${signature}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${authConfig.ttlSeconds}`,
  ];
  if (authConfig.secureCookie) parts.push('Secure');
  return parts.join('; ');
}

function verifySessionCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string') return null;
  const cookie = parseCookies(cookieHeader)[authConfig.cookieName];
  if (!cookie) return null;

  const [payload, signature] = cookie.split('.');
  if (!payload || !signature || !safeEqual(sign(payload), signature)) return null;

  try {
    const session = JSON.parse(base64UrlDecode(payload));
    if (typeof session?.username !== 'string' || typeof session?.exp !== 'number') return null;
    if (Date.now() > session.exp) return null;
    if (!authConfig.users.some((user) => safeEqual(user.username, session.username))) return null;
    return session.username;
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader) {
  return cookieHeader.split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator === -1) return cookies;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = value;
    return cookies;
  }, {});
}

function sign(payload) {
  return createHmac('sha256', authConfig.secret).update(payload).digest('base64url');
}

function base64UrlEncode(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

function loadLocalEnv() {
  const envPath = new URL('.env.local', import.meta.url);
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const equals = trimmed.indexOf('=');
    if (equals === -1) return;
    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}
