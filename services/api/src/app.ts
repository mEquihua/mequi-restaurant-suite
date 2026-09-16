import Fastify, { type FastifyInstance } from 'fastify';

import { pingModule } from './modules/ping/index.js';

export interface AppOptions {
  logLevel?: string;
}

/** Creates the HTTP application without binding a network port. */
export function createApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: options.logLevel ?? process.env.LOG_LEVEL ?? 'info',
    },
  });

  app.get(
    '/healthz',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['status'],
            properties: { status: { type: 'string', const: 'ok' } },
          },
        },
      },
    },
    async () => ({ status: 'ok' }),
  );

  app.register(pingModule);

  return app;
}
