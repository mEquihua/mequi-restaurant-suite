import type { FastifyPluginAsync } from 'fastify';

import { menuRoute, type MenuRouteOptions } from './route.js';
export {
  resolveAvailability,
  effectivePrice,
  type AvailabilityRuleInput,
  type AvailabilityContext,
  type AvailabilityStatus,
} from './availability.js';

/** Public menu module entry point. Other modules may import only from this file. */
export const menuModule: FastifyPluginAsync<MenuRouteOptions> = async (app, options) => {
  await app.register(menuRoute, options);
};

export type { MenuRouteOptions } from './route.js';
