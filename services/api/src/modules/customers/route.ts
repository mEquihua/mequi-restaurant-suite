import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { DUMMY_PIN_HASH, IdentityHttpError, hashPin, verifyPin } from '../identity/index.js';
import {
  CustomerSessionHttpError,
  createCustomerSessionToken,
  hashCustomerSecret,
  withCustomerSession,
} from './authentication.js';
import type { components } from '@restaurant-suite/contracts';

function fail(
  reply: FastifyReply,
  request: FastifyRequest,
  error: IdentityHttpError | CustomerSessionHttpError,
) {
  return reply.status(error.statusCode).send({
    error: {
      status: error.statusCode,
      code: error.code,
      message: error.message,
      request_id: request.id,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  });
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CustomersRouteOptions {}

type RegisterReq = components['schemas']['RegisterCustomerRequest'];
type LoginReq = components['schemas']['LoginCustomerRequest'];
type CustomerSchema = components['schemas']['Customer'];

const uuidSchema = { type: 'string', format: 'uuid' } as const;
const registerSchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['org_id'],
    properties: { org_id: uuidSchema },
  },
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['email', 'password', 'name'],
    properties: {
      email: { type: 'string', format: 'email', maxLength: 255 },
      password: { type: 'string', minLength: 8, maxLength: 200 },
      name: { type: 'string', minLength: 1, maxLength: 200 },
      phone: { type: 'string', maxLength: 40 },
    },
  },
} as const;
const loginSchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['org_id'],
    properties: { org_id: uuidSchema },
  },
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email', maxLength: 255 },
      password: { type: 'string', minLength: 1, maxLength: 200 },
    },
  },
} as const;

function publicCustomer(customer: {
  id: string;
  organization_id: string;
  email: string;
  name: string;
  phone: string | null;
  created_at: Date;
  updated_at: Date;
}): CustomerSchema {
  return {
    id: customer.id,
    organization_id: customer.organization_id,
    email: customer.email,
    name: customer.name,
    phone: customer.phone,
    created_at: customer.created_at.toISOString(),
    updated_at: customer.updated_at.toISOString(),
  };
}

export const customersRoute: FastifyPluginAsync<CustomersRouteOptions> = async (app) => {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof IdentityHttpError || error instanceof CustomerSessionHttpError)
      return fail(reply, request, error);
    if (
      typeof error === 'object' &&
      error !== null &&
      'validation' in error &&
      (error as { validation?: unknown }).validation
    )
      return reply.status(400).send({
        error: {
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'The request does not match the required schema.',
          request_id: request.id,
        },
      });
    request.log.error({ err: error }, 'customers request failed');
    return reply.status(500).send({
      error: {
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        request_id: request.id,
      },
    });
  });

  app.post<{ Params: { org_id: string }; Body: RegisterReq }>(
    '/api/v1/organizations/:org_id/customers',
    { schema: registerSchema },
    async (request, reply) => {
      const { org_id } = request.params;
      const { email, password, name, phone } = request.body;
      const password_hash = await hashPin(password);

      return app.withOrganizationTransaction(org_id, async (trx) => {
        const existing = await trx
          .selectFrom('customers')
          .select('id')
          .where('organization_id', '=', org_id)
          .where('email', '=', email)
          .executeTakeFirst();
        if (existing)
          throw new IdentityHttpError(
            409,
            'EMAIL_ALREADY_REGISTERED',
            'An account with this email already exists.',
          );

        const customer = await trx
          .insertInto('customers')
          .values({ organization_id: org_id, email, password_hash, name, phone: phone || null })
          .returningAll()
          .executeTakeFirstOrThrow();

        const body = publicCustomer(customer);
        reply.status(201);
        return body;
      });
    },
  );

  app.post<{ Params: { org_id: string }; Body: LoginReq }>(
    '/api/v1/organizations/:org_id/customer-sessions',
    { schema: loginSchema },
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

        // Always run a real Argon2id verify, even when the email doesn't
        // exist, against a fixed dummy hash (matching the identity module's
        // pin-unlock convention) — otherwise the response time itself leaks
        // whether an email is registered.
        const valid = await verifyPin(customer?.password_hash ?? DUMMY_PIN_HASH, password);
        if (!customer || !valid) {
          reply.status(401);
          return {
            error: {
              status: 401,
              code: 'INVALID_CREDENTIALS',
              message: 'Invalid email or password.',
              request_id: request.id,
            },
          };
        }

        const token = createCustomerSessionToken(org_id);
        const token_hash = hashCustomerSecret(token);
        const expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        await trx
          .insertInto('customer_sessions')
          .values({ organization_id: org_id, customer_id: customer.id, token_hash, expires_at })
          .execute();

        const body = { token, customer: publicCustomer(customer) };
        return body;
      });
    },
  );

  app.get<{ Params: { org_id: string } }>(
    '/api/v1/organizations/:org_id/locations',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['org_id'],
          properties: { org_id: uuidSchema },
        },
      },
    },
    async (request) => {
      const { org_id } = request.params;
      return app.withOrganizationTransaction(org_id, async (trx) => {
        const locations = await trx
          .selectFrom('locations')
          .select(['id', 'name', 'address', 'timezone'])
          .where('organization_id', '=', org_id)
          .orderBy('name')
          .execute();
        return { data: locations };
      });
    },
  );

  app.get<{ Params: { org_id: string } }>(
    '/api/v1/organizations/:org_id/customer-sessions/current',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['org_id'],
          properties: { org_id: uuidSchema },
        },
      },
    },
    async (request) =>
      withCustomerSession(app, request, new Date(), async ({ trx, customerId }) => {
        const customer = await trx
          .selectFrom('customers')
          .selectAll()
          .where('id', '=', customerId)
          .executeTakeFirstOrThrow();
        return publicCustomer(customer);
      }),
  );
};
