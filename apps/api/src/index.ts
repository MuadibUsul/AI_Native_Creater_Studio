import { buildServer } from './server.js';

const port = Number(process.env['PORT'] ?? 3001);
const app = await buildServer({ logger: true });

try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
