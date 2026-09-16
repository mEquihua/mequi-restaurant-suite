import type { FastifyPluginAsync } from 'fastify';
import type { components } from '@restaurant-suite/contracts';
import { withCustomerSession } from '../customers/index.js';
import { IdentityHttpError, requirePermission, withAuthenticatedSession, type AuthenticatedSession } from '../identity/index.js';
import { addOrderLines } from './commands.js';


export const onlineOrdersRoute: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { loc_id: string }; Body: components['schemas']['OnlineCheckoutRequest'] }>(
    '/api/v1/locations/:loc_id/online-orders/checkout',
    async (request, reply) => {
      const { loc_id } = request.params;
      const body = request.body;
      const authHeader = request.headers.authorization;

      let authCustomer: { customerId: string; organizationId: string } | null = null;
      if (authHeader?.startsWith('Bearer customer.')) {
        await withCustomerSession(app, request, new Date(), async (session) => {
          authCustomer = { customerId: session.customerId, organizationId: session.organizationId };
        });
      }

      try { return await app.withLocationTransaction(loc_id, async (trx) => {
        const location = await trx.selectFrom('locations').select('organization_id').where('id', '=', loc_id).executeTakeFirst();
        if (!location) throw new IdentityHttpError(404, 'NOT_FOUND', 'Location not found');
        const organizationId = location.organization_id;

        if (authCustomer && authCustomer.organizationId !== organizationId) {
          throw new IdentityHttpError(403, 'FORBIDDEN', 'Customer organization mismatch');
        }

        const visit = await trx
          .insertInto('visits')
          .values({
            location_id: loc_id,
                        customer_id: authCustomer?.customerId ?? null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        const order = await trx
          .insertInto('orders')
          .values({
            location_id: loc_id,
            visit_id: visit.id,
            order_type: body.fulfillment_type,
            status: 'DRAFT',
          })
          .returning(['id', 'version'])
          .executeTakeFirstOrThrow();

        const accountName = body.customer_name ? `Online: ${body.customer_name}` : `Guest Order`;
        const account = await trx
          .insertInto('accounts')
          .values({
            location_id: loc_id,
            visit_id: visit.id,
            name: accountName,
            status: 'OPEN',
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        // The checkout item modifiers structure has 'modifier_id' and 'quantity', wait!
        // `addOrderLines` expects `GuestLineInput` or `LineInput`:
        // { product_id, quantity, notes, modifiers: { product_modifier_id, quantity }[] }
        // Let's map it:
        const lines = body.items.map((item: components['schemas']['CheckoutItem']) => ({
          account_id: account.id,
          product_id: item.product_id,
          quantity: item.quantity,
          modifier_ids: (item.modifiers || []).map((m: components['schemas']['CheckoutModifier']) => m.modifier_id)
        }));

        await addOrderLines(trx, {
          locationId: loc_id,
          organizationId: organizationId,
          orderId: order.id,
          expectedVersion: order.version,
          lines: lines,
        });

        await trx.updateTable('orders').set({ status: 'HELD' }).where('id', '=', order.id).execute();
        await trx.updateTable('order_lines').set({ status: 'HELD' }).where('order_id', '=', order.id).execute();

        await trx
          .insertInto('order_fulfillments')
          .values({
            location_id: loc_id,
            order_id: order.id,
            fulfillment_type: body.fulfillment_type,
            status: 'PENDING',
            scheduled_for: body.scheduled_for ? new Date(body.scheduled_for) : null,
            customer_name: body.customer_name,
            customer_email: body.customer_email,
            customer_phone: body.customer_phone,
            delivery_address: body.delivery_address ? JSON.stringify(body.delivery_address) : null,
          })
          .execute();

        reply.status(201);
        return {
          order_id: order.id,
          // Spec requires returning order_token for guests. Since there is no DB column to store a token hash,
          // and UUIDs provide 122-bits of entropy (sufficient for capability URLs), we use the order_id as the token.
          order_token: authCustomer ? null : order.id,
        };
      });
    } catch (e) { console.error('ERROR during checkout:', e); throw e; }
  });

  app.get<{ Params: { loc_id: string; order_id: string }; Querystring: { order_token?: string } }>(
    '/api/v1/locations/:loc_id/online-orders/:order_id',
    async (request) => {
      const { loc_id, order_id } = request.params;
      const { order_token } = request.query;

      return app.withLocationTransaction(loc_id, async (trx) => {
        const authHeader = request.headers.authorization;
        let authCustomerId: string | null = null;
        if (authHeader?.startsWith('Bearer customer.')) {
          await withCustomerSession(app, request, new Date(), async (session) => {
            authCustomerId = session.customerId;
          });
        }

        const order = await trx
          .selectFrom('orders')
          .selectAll()
          .where('location_id', '=', loc_id)
          .where('id', '=', order_id)
          .executeTakeFirst();
          
        if (!order) throw new IdentityHttpError(404, 'NOT_FOUND', 'Order not found');

        const visit = await trx
          .selectFrom('visits')
          .select('customer_id')
          .where('id', '=', order.visit_id)
          .executeTakeFirstOrThrow();

        if (visit.customer_id) {
          if (visit.customer_id !== authCustomerId) throw new IdentityHttpError(403, 'FORBIDDEN', 'Order belongs to another customer');
        } else {
          // Verify guest token
          if (order_token !== order.id) throw new IdentityHttpError(403, 'FORBIDDEN', 'Invalid order token');
        }

        const linesRows = await trx
          .selectFrom('order_lines')
          .selectAll()
          .where('order_id', '=', order.id)
          .execute();

        const modifiersRows = await trx
          .selectFrom('order_line_modifiers')
          .selectAll()
          .where('order_line_id', 'in', linesRows.length > 0 ? linesRows.map(l => l.id) : ['00000000-0000-0000-0000-000000000000'])
          .execute();

        const fulfillment = await trx
          .selectFrom('order_fulfillments')
          .selectAll()
          .where('order_id', '=', order.id)
          .executeTakeFirstOrThrow();

        // Calculate totals the same way GET /orders/:id does
        const accounts = await trx.selectFrom('accounts').select(['id', 'status']).where('visit_id', '=', order.visit_id).execute();
        const payments = await trx.selectFrom('payments').select(['account_id', 'amount']).where('account_id', 'in', accounts.length > 0 ? accounts.map(a => a.id) : ['00000000-0000-0000-0000-000000000000']).execute();
        
        let subtotal = 0;
        for (const line of linesRows) {
          if (line.status !== 'CANCELLED' && line.status !== 'VOIDED') {
            const mods = modifiersRows.filter(m => m.order_line_id === line.id);
            subtotal += (line.unit_price + mods.reduce((acc, m) => acc + m.unit_price, 0)) * line.quantity;
          }
        }
        const total = subtotal; // Ignoring taxes/discounts for this summary as it's just basic implementation
        
        return {
          order: {
            id: order.id,
            location_id: order.location_id,
            visit_id: order.visit_id,
            order_type: order.order_type,
            status: order.status,
                        version: order.version,
            created_at: order.created_at.toISOString(),
            updated_at: order.updated_at.toISOString(),
            totals: {
              subtotal,
              total,
              paid: payments.reduce((acc, p) => acc + p.amount, 0),
            }
          },
          lines: linesRows.map(line => ({
            id: line.id,
            order_id: line.order_id,
            account_id: line.account_id,
            product_id: line.product_id,
            status: line.status,
            quantity: line.quantity,
                        created_at: line.created_at.toISOString(),
            updated_at: line.updated_at.toISOString(),
            modifiers: modifiersRows.filter(m => m.order_line_id === line.id).map(m => ({
              id: m.id,
              modifier_id: m.modifier_id,
            })),
          })),
          fulfillment: {
            status: fulfillment.status,
            fulfillment_type: fulfillment.fulfillment_type,
          }
        };
      });
    }
  );

  app.post<{ Params: { loc_id: string; order_id: string }; Body: { version: number } }>(
    '/api/v1/locations/:loc_id/orders/:order_id/fulfillment/dispatch',
    async (request) => {
      const { loc_id, order_id } = request.params;
      const { version } = request.body;

      return withAuthenticatedSession(app, request, new Date(), 5 * 60 * 1000, async (actor: AuthenticatedSession) => {
        requirePermission(actor, 'orders.fulfillment.dispatch');

        return app.withLocationTransaction(loc_id, async (trx) => {
          const fulfillment = await trx
            .selectFrom('order_fulfillments')
            .selectAll()
            .where('order_id', '=', order_id)
            .executeTakeFirst();
            
          if (!fulfillment) throw new IdentityHttpError(404, 'NOT_FOUND', 'Fulfillment not found');
          if (fulfillment.version !== version) throw new IdentityHttpError(409, 'CONFLICT', 'Version mismatch');
          if (fulfillment.fulfillment_type !== 'DELIVERY') throw new IdentityHttpError(409, 'CONFLICT', 'Not a delivery order');
          if (fulfillment.status !== 'PENDING') throw new IdentityHttpError(409, 'CONFLICT', 'Cannot dispatch, status is not PENDING');

          // Check lines status
          const lines = await trx
            .selectFrom('order_lines')
            .select('status')
            .where('order_id', '=', order_id)
            .execute();
            
          const allReady = lines.every(l => l.status === 'READY' || l.status === 'FULFILLED' || l.status === 'CANCELLED' || l.status === 'VOIDED');
          if (!allReady) throw new IdentityHttpError(409, 'CONFLICT', 'Cannot dispatch, not all lines are ready');

          await trx
            .updateTable('order_fulfillments')
            .set({ status: 'OUT_FOR_DELIVERY', version: version + 1, updated_at: new Date() })
            .where('order_id', '=', order_id)
            .where('version', '=', version)
            .executeTakeFirstOrThrow();

          return { message: 'Dispatched' };
        });
      });
    }
  );

  app.post<{ Params: { loc_id: string; order_id: string }; Body: { version: number } }>(
    '/api/v1/locations/:loc_id/orders/:order_id/fulfillment/deliver',
    async (request) => {
      const { loc_id, order_id } = request.params;
      const { version } = request.body;

      return withAuthenticatedSession(app, request, new Date(), 5 * 60 * 1000, async (actor: AuthenticatedSession) => {
        requirePermission(actor, 'orders.fulfillment.deliver');

        return app.withLocationTransaction(loc_id, async (trx) => {
          const fulfillment = await trx
            .selectFrom('order_fulfillments')
            .selectAll()
            .where('order_id', '=', order_id)
            .executeTakeFirst();
            
          if (!fulfillment) throw new IdentityHttpError(404, 'NOT_FOUND', 'Fulfillment not found');
          if (fulfillment.version !== version) throw new IdentityHttpError(409, 'CONFLICT', 'Version mismatch');
          if (fulfillment.fulfillment_type !== 'DELIVERY') throw new IdentityHttpError(409, 'CONFLICT', 'Not a delivery order');
          if (fulfillment.status !== 'OUT_FOR_DELIVERY') throw new IdentityHttpError(409, 'CONFLICT', 'Cannot deliver, status is not OUT_FOR_DELIVERY');

          await trx
            .updateTable('order_fulfillments')
            .set({ status: 'DELIVERED', version: version + 1, updated_at: new Date() })
            .where('order_id', '=', order_id)
            .where('version', '=', version)
            .executeTakeFirstOrThrow();

          return { message: 'Delivered' };
        });
      });
    }
  );
};
