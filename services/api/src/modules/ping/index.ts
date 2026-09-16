import type { FastifyPluginAsync } from 'fastify';

import { pingRoute } from './route.js';

/** Public module entry point. Other modules may import only from this file. */
export const pingModule: FastifyPluginAsync = async (app) => {
  await app.register(pingRoute);
};
