import type { FastifyPluginAsync } from 'fastify';

import { identityRoute, type IdentityRouteOptions } from './route.js';

/** Public identity module entry point. Other modules may import only from this file. */
export const identityModule: FastifyPluginAsync<IdentityRouteOptions> = async (app, options) => {
  await app.register(identityRoute, options);
};

export type { IdentityRouteOptions } from './route.js';
