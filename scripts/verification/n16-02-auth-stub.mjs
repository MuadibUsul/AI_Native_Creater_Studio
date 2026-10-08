import { createServer } from 'node:http';

// Browser evidence only: a scripted /auth/session response, not real authentication.
const port = Number(process.env.ANCS_AUTH_STUB_PORT ?? 4399);
createServer((request, response) => {
  const userId = /(?:^|;\s*)appearance-test-session=([A-Za-z0-9_-]+)/.exec(request.headers.cookie ?? '')?.[1];
  if (request.url !== '/api/v1/auth/session' || !userId) {
    response.writeHead(401).end();
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    user: { id: userId, email: 'appearance-test@example.invalid', name: 'Appearance test', emailVerified: true },
    sessionId: 'scripted-session', method: 'web_session', expiresAt: '2030-01-01T00:00:00.000Z',
  }));
}).listen(port, '127.0.0.1', () => process.stdout.write(`N16-02 scripted auth session on 127.0.0.1:${port}\n`));
