const baseUrl = process.env.CLOUD_HEALTH_URL ?? 'https://training-social-worker.fly.dev';
const basicAuth = process.env.CLOUD_HEALTH_BASIC_AUTH ?? '';

const unauthenticated = await fetch(`${baseUrl}/`, { method: 'HEAD' });
const challenge = unauthenticated.headers.get('www-authenticate') ?? '';
if (unauthenticated.status !== 401 || !challenge.includes('Basic realm="Social Work Avatar Lab"')) {
  throw new Error(`Expected Basic Auth 401 from ${baseUrl}, got ${unauthenticated.status} ${challenge}`);
}

const result = {
  ok: true,
  baseUrl,
  authChallenge: challenge,
  authenticatedHealth: 'skipped',
};

if (basicAuth) {
  const encoded = Buffer.from(basicAuth, 'utf8').toString('base64');
  const response = await fetch(`${baseUrl}/api/health`, {
    headers: { Authorization: `Basic ${encoded}` },
  });
  const health = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Authenticated /api/health failed: ${response.status} ${JSON.stringify(health)}`);
  }
  result.authenticatedHealth = {
    ok: health?.ok,
    node: health?.node?.ok,
    adk: health?.adk?.ok,
    googleVoiceEnabled: health?.adk?.googleVoiceEnabled,
    rhubarbAvailable: health?.adk?.rhubarbAvailable,
    corpusBackend: health?.adk?.corpusBackend,
  };
}

console.log(JSON.stringify(result, null, 2));
