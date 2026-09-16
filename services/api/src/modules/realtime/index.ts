import type { FastifyPluginAsync } from 'fastify';
import { realtimeRoute } from './route.js';

export const realtimeModule: FastifyPluginAsync = async (app) => {
  await app.register(realtimeRoute);
};
