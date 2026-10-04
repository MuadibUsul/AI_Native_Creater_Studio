import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { echoRequestSchema, echoResponseSchema } from '@ancs/contracts';

/** TODO(P01-05): 临时管线验证路由（P00-03），随真实资源路由落地后删除。同 packages/contracts/src/echo.ts。 */
export function registerEchoRoutes(app: FastifyInstance): void {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/echo',
    {
      schema: {
        tags: ['smoke'],
        summary: '临时管线验证（P01-05 删除）',
        body: echoRequestSchema,
        response: { 200: echoResponseSchema },
      },
    },
    async (request) => {
      const { message, count } = request.body;
      return { message, repeated: Array.from({ length: count }, () => message) };
    },
  );
}
