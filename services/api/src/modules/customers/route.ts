import type { FastifyPluginAsync } from 'fastify';
import { hashPin, verifyPin } from '../identity/index.js';
import { createCustomerSessionToken, hashCustomerSecret, withCustomerSession } from './authentication.js';
import type { components } from '@restaurant-suite/contracts';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CustomersRouteOptions {}

type RegisterReq = components['schemas']['RegisterCustomerRequest'];
type LoginReq = components['schemas']['LoginCustomerRequest'];
type CustomerSchema = components['schemas']['Customer'];

export const customersRoute: FastifyPluginAsync<CustomersRouteOptions> = async (app) => {
  app.post<{ Params: { org_id: string }; Body: RegisterReq }>(
    '/api/v1/organizations/:org_id/customers',
    async (request, reply) => {
      const { org_id } = request.params;
      const { email, password, name, phone } = request.body;

      const password_hash = await hashPin(password);

      return app.withOrganizationTransaction(org_id, async (trx) => {
        const customer = await trx
          .insertInto('customers')
          .values({
            organization_id: org_id,
            email,
            password_hash,
            name,
            phone: phone || null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        reply.status(201);
        return {
          id: customer.id,
          organization_id: customer.organization_id,
          email: customer.email,
          name: customer.name,
          phone: customer.phone,
          created_at: customer.created_at.toISOString(),
          updated_at: customer.updated_at.toISOString(),
        } satisfies CustomerSchema;
      });
    }
  );

  app.post<{ Params: { org_id: string }; Body: LoginReq }>(
    '/api/v1/organizations/:org_id/customer-sessions',
    async (request, reply) => {
      const { org_id } = request.params;
      const { email, password } = request.body;

      return app.withOrganizationTransaction(org_id, async (trx) => {
        const customer = await trx
          .selectFrom('customers')
          .selectAll()
          .where('organization_id', '=', org_id)
          .where('email', '=', email)
          .executeTakeFirst();

        if (!customer) {
          reply.status(401);
          return { message: 'Invalid credentials' };
        }

        const valid = await verifyPin(customer.password_hash, password);
        if (!valid) {
          reply.status(401);
          return { message: 'Invalid credentials' };
        }

        const token = createCustomerSessionToken(org_id);
        const token_hash = hashCustomerSecret(token);
        
        // Expiration for customer session is let's say 30 days
        const expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        await trx
          .insertInto('customer_sessions')
          .values({
            organization_id: org_id,
            customer_id: customer.id,
            token_hash,
            expires_at,
          })
          .execute();

        return {
          token,
          customer: {
            id: customer.id,
            organization_id: customer.organization_id,
            email: customer.email,
            name: customer.name,
            phone: customer.phone,
            created_at: customer.created_at.toISOString(),
            updated_at: customer.updated_at.toISOString(),
          }
        };
      });
    }
  );

  app.get<{ Params: { org_id: string } }>(
    '/api/v1/organizations/:org_id/customer-sessions/current',
    async (request) => {
      return withCustomerSession(app, request, new Date(), async ({ trx, customerId }) => {
        const customer = await trx
          .selectFrom('customers')
          .selectAll()
          .where('id', '=', customerId)
          .executeTakeFirstOrThrow();
          
        return {
          id: customer.id,
          organization_id: customer.organization_id,
          email: customer.email,
          name: customer.name,
          phone: customer.phone,
          created_at: customer.created_at.toISOString(),
          updated_at: customer.updated_at.toISOString(),
        } satisfies CustomerSchema;
      });
    }
  );
};
