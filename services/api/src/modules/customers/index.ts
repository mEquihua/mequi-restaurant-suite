import type { FastifyPluginAsync } from 'fastify';
import { customersRoute, type CustomersRouteOptions } from './route.js';

export { CustomerSessionHttpError, withCustomerSession } from './authentication.js';
export type { CustomerSession } from './authentication.js';

export const customersModule: FastifyPluginAsync<CustomersRouteOptions> = async (app, options) => {
  await app.register(customersRoute, options);
};
export type { CustomersRouteOptions } from './route.js';
