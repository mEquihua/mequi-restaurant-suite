import type { FastifyPluginAsync } from 'fastify';
import { ordersRoute, type OrdersRouteOptions } from './route.js';
import { onlineOrdersRoute } from './online-ordering.js';
export const ordersModule: FastifyPluginAsync<OrdersRouteOptions> = async (app, options) => {
  await app.register(ordersRoute, options);
  await app.register(onlineOrdersRoute);
};
export type { OrdersRouteOptions } from './route.js';
export { addOrderLines, type GuestLineInput } from './commands.js';
export {
  canTransitionLineStatus,
  lineStatuses,
  splitEqually,
  resolveLinePrice,
  lineAmount,
  type LineStatus,
} from './state.js';
