import Fastify, { type FastifyInstance } from 'fastify';

import { installDatabase } from './shared/index.js';
import { identityModule, type IdentityRouteOptions } from './modules/identity/index.js';
import { menuModule, type MenuRouteOptions } from './modules/menu/index.js';
import { floorModule, type FloorRouteOptions } from './modules/floor/index.js';
import { moduleCenterModule, type ModuleCenterRouteOptions } from './modules/module-center/index.js';
import { pingModule } from './modules/ping/index.js';

export interface AppOptions {
  logLevel?: string;
  databaseUrl?: string;
  identity?: IdentityRouteOptions;
  menu?: MenuRouteOptions;
  floor?: FloorRouteOptions;
  moduleCenter?: ModuleCenterRouteOptions;
}

/** Creates the HTTP application without binding a network port. */
export function createApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: options.logLevel ?? process.env.LOG_LEVEL ?? 'info',
    },
  });

  installDatabase(app, { databaseUrl: options.databaseUrl });

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
  app.register(identityModule, options.identity ?? {});
  app.register(menuModule, options.menu ?? {});
  app.register(floorModule, options.floor ?? {});
  app.register(moduleCenterModule, options.moduleCenter ?? {});

  return app;
}
