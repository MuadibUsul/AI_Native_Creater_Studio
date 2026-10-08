import { createServer } from 'node:http';

// Browser evidence only: a scripted current-user preference response, not real authentication.
const port = Number(process.env.ANCS_AUTH_STUB_PORT ?? 4399);
createServer((request, response) => {
  const userId = /(?:^|;\s*)appearance-test-session=([A-Za-z0-9_-]+)/.exec(request.headers.cookie ?? '')?.[1];
  if (request.url !== '/api/v1/users/me/appearance' || !userId) {
    response.writeHead(401).end();
    return;
  }
  const accountMode = /(?:^|;\s*)appearance-test-account=(system|light|dark)/.exec(request.headers.cookie ?? '')?.[1] ?? 'system';
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    userId, mode: accountMode, updatedAt: null,
  }));
}).listen(port, '127.0.0.1', () => process.stdout.write(`N16-02 scripted auth session on 127.0.0.1:${port}\n`));
