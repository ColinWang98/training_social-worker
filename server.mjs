import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { createServer as createViteServer } from 'vite';

loadLocalEnv();

const port = Number(process.env.PORT ?? 5173);
const adkServiceUrl = (process.env.ADK_SERVICE_URL ?? 'http://127.0.0.1:8765').replace(/\/$/, '');

const vite = await createViteServer({
  server: { middlewareMode: true, host: '127.0.0.1' },
  appType: 'spa',
});

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/api/shutdown') {
      return handleShutdown(req, res);
    }

    if (req.url === '/api/health') {
      return proxyRequest(req, res, '/health');
    }

    if (req.url?.startsWith('/api/')) {
      return proxyRequest(req, res, req.url);
    }

    vite.middlewares(req, res, (error) => {
      if (error) {
        vite.ssrFixStacktrace(error);
        sendJson(res, 500, { error: error.message });
      }
    });
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Social Work Avatar Lab running at http://127.0.0.1:${port}/`);
  console.log(`Proxying app API routes to ADK service at ${adkServiceUrl}.`);
});

server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/api/voice-stream')) {
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
      await vite.close();
    } finally {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    }
  }, 150).unref();
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
    res.writeHead(response.status, {
      'Content-Type': response.headers.get('content-type') ?? 'application/json',
    });
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
