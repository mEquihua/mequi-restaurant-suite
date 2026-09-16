import type { FastifyPluginAsync } from 'fastify';
import { guestSessionsRoute, type GuestSessionsRouteOptions } from './route.js';

export { GuestSessionHttpError, withGuestSession } from './authentication.js';
export type { GuestSession } from './authentication.js';

/** Public guest-session module boundary. */
export const guestSessionsModule: FastifyPluginAsync<GuestSessionsRouteOptions> = async (app, options) => {
  await app.register(guestSessionsRoute, options);
};
export type { GuestSessionsRouteOptions } from './route.js';
