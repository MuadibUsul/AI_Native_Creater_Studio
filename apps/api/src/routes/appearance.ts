import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ApiFailure, ERROR_CODES, errorEnvelopeSchema,
  setUserAppearancePreferenceRequestSchema, userAppearancePreferenceSchema,
} from '@ancs/contracts';
import { getUserAppearance, setUserAppearance, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/** Account-scoped UI intent; both Web sessions and native access tokens use the same endpoint. */
export function registerAppearanceRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };
  const currentUser = async (request: Parameters<typeof app.authResolve>[0]): Promise<string> => {
    const context = await app.authResolve(request);
    if (!context) throw new ApiFailure(ERROR_CODES.UNAUTHENTICATED, 'Not authenticated', 401);
    return context.userId;
  };

  typed.get('/users/me/appearance', {
    schema: { tags: ['appearance'], summary: '当前用户同步的界面外观偏好', response: { 200: userAppearancePreferenceSchema, 401: errorEnvelopeSchema } },
  }, async (request, reply) => {
    const userId = await currentUser(request);
    reply.header('cache-control', 'private, no-store');
    return getUserAppearance(domain, userId);
  });

  typed.put('/users/me/appearance', {
    schema: { tags: ['appearance'], summary: '设置当前用户同步的界面外观偏好', body: setUserAppearancePreferenceRequestSchema, response: { 200: userAppearancePreferenceSchema, 401: errorEnvelopeSchema, 400: errorEnvelopeSchema } },
  }, async (request, reply) => {
    const userId = await currentUser(request);
    reply.header('cache-control', 'private, no-store');
    return setUserAppearance(domain, userId, request.body.mode);
  });
}
