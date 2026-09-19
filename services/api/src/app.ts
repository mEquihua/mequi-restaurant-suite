import Fastify, { type FastifyInstance } from 'fastify';

import { installDatabase } from './shared/index.js';
import { identityModule, type IdentityRouteOptions } from './modules/identity/index.js';
import { menuModule, type MenuRouteOptions } from './modules/menu/index.js';
import { floorModule, type FloorRouteOptions } from './modules/floor/index.js';
import { moduleCenterModule, type ModuleCenterRouteOptions } from './modules/module-center/index.js';
import { ordersModule, type OrdersRouteOptions } from './modules/orders/index.js';
import { customersModule } from './modules/customers/index.js';
import { guestSessionsModule, type GuestSessionsRouteOptions } from './modules/guest-sessions/index.js';
import { reportsModule, type ReportsRouteOptions } from './modules/reports/index.js';
import { cashDrawerModule, type CashDrawerRouteOptions } from './modules/cash-drawer/index.js';
import { inventoryModule } from './modules/inventory/index.js';
import { reservationsModule } from './modules/reservations/index.js';
import { loyaltyModule } from './modules/loyalty/index.js';
import { timeclockModule } from './modules/timeclock/index.js';
import { promotionsModule } from './modules/promotions/index.js';
import { integrationsModule } from './modules/integrations/index.js';
import { realtimeModule } from './modules/realtime/index.js';
import { pingModule } from './modules/ping/index.js';

export interface AppOptions {
  logLevel?: string;
  databaseUrl?: string;
  identity?: IdentityRouteOptions;
  menu?: MenuRouteOptions;
  floor?: FloorRouteOptions;
  moduleCenter?: ModuleCenterRouteOptions;
  orders?: OrdersRouteOptions;
  guestSessions?: GuestSessionsRouteOptions;
  reports?: ReportsRouteOptions;
  cashDrawer?: CashDrawerRouteOptions;
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
  app.register(ordersModule, options.orders ?? {});
  app.register(guestSessionsModule, options.guestSessions ?? {});
  app.register(customersModule, {});
  app.register(reportsModule, options.reports ?? {});
  app.register(cashDrawerModule, options.cashDrawer ?? {});
  app.register(inventoryModule, {});
  app.register(reservationsModule, {});
  app.register(loyaltyModule, {});
  app.register(timeclockModule, {});
  app.register(promotionsModule, {});
  app.register(integrationsModule, {});
  app.register(realtimeModule);

  return app;
}
