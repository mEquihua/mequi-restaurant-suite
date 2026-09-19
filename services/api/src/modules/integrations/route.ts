import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { sql } from 'kysely';

import {
  IdentityHttpError,
  requirePermission,
  withAuthenticatedSession,
} from '../identity/index.js';

const uuidSchema = { type: 'string', format: 'uuid' } as const;
const ifMatchHeader = {
  type: 'object',
  additionalProperties: true,
  properties: { 'if-match': { type: 'string', pattern: '^"?[1-9][0-9]*"?$' } },
} as const;

type WebhookBody = {
  url: string;
  event_types: string[];
  is_active?: boolean;
};

export const integrationsModule: FastifyPluginAsync = async (app) => {
  const withSession = <T>(
    request: FastifyRequest,
    work: Parameters<typeof withAuthenticatedSession<T>>[4],
  ) => withAuthenticatedSession(app, request, new Date(), 15 * 60 * 1000, work);

  app.get(
    '/api/v1/organizations/:organizationId/webhooks',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['organizationId'],
          properties: { organizationId: uuidSchema },
        },
      },
    },
    async (request) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'integrations.webhooks.read');
        const { organizationId } = request.params as { organizationId: string };
        if (actor.organizationId !== organizationId) {
          throw new IdentityHttpError(403, 'FORBIDDEN', 'Access denied.');
        }

        const webhooks = await actor.trx
          .selectFrom('webhook_subscriptions')
          .select([
            'id',
            'organization_id',
            'url',
            'event_types',
            'is_active',
            'version',
            'created_at',
            'updated_at',
          ])
          .where('organization_id', '=', organizationId)
          .orderBy('created_at', 'desc')
          .execute();

        return { data: webhooks };
      }),
  );

  app.post(
    '/api/v1/organizations/:organizationId/webhooks',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['organizationId'],
          properties: { organizationId: uuidSchema },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['url', 'event_types'],
          properties: {
            url: { type: 'string', format: 'uri', maxLength: 2048 },
            event_types: { type: 'array', minItems: 1, items: { type: 'string' } },
            is_active: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await withSession(request, async (actor) => {
        requirePermission(actor, 'integrations.webhooks.write');
        const { organizationId } = request.params as { organizationId: string };
        if (actor.organizationId !== organizationId) {
          throw new IdentityHttpError(403, 'FORBIDDEN', 'Access denied.');
        }

        const body = request.body as WebhookBody;
        const secret = 'whsec_' + crypto.randomBytes(24).toString('base64url');

        const subscription = await actor.trx
          .insertInto('webhook_subscriptions')
          .values({
            organization_id: organizationId,
            url: body.url,
            event_types: body.event_types,
            secret: secret,
            is_active: body.is_active ?? true,
          })
          .returning([
            'id',
            'organization_id',
            'url',
            'event_types',
            'is_active',
            'version',
            'created_at',
            'updated_at',
          ])
          .executeTakeFirstOrThrow();

        return { subscription, secret };
      });
      return reply.status(201).send(result);
    },
  );

  app.put(
    '/api/v1/organizations/:organizationId/webhooks/:id',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['organizationId', 'id'],
          properties: { organizationId: uuidSchema, id: uuidSchema },
        },
        headers: ifMatchHeader,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['url', 'event_types', 'is_active'],
          properties: {
            url: { type: 'string', format: 'uri', maxLength: 2048 },
            event_types: { type: 'array', minItems: 1, items: { type: 'string' } },
            is_active: { type: 'boolean' },
          },
        },
      },
    },
    async (request) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'integrations.webhooks.write');
        const { organizationId, id } = request.params as { organizationId: string; id: string };
        if (actor.organizationId !== organizationId) {
          throw new IdentityHttpError(403, 'FORBIDDEN', 'Access denied.');
        }

        const versionMatch = request.headers['if-match'];
        if (!versionMatch) {
          throw new IdentityHttpError(428, 'PRECONDITION_REQUIRED', 'If-Match is required');
        }
        const v = Number(versionMatch.replace(/"/g, ''));

        const body = request.body as WebhookBody;

        const existing = await actor.trx
          .selectFrom('webhook_subscriptions')
          .select(['version'])
          .where('id', '=', id)
          .where('organization_id', '=', organizationId)
          .executeTakeFirst();

        if (!existing) throw new IdentityHttpError(404, 'NOT_FOUND', 'Webhook not found');
        if (existing.version !== v) {
          throw new IdentityHttpError(409, 'OPTIMISTIC_CONCURRENCY_CONFLICT', 'Version mismatch');
        }

        const updated = await actor.trx
          .updateTable('webhook_subscriptions')
          .set({
            url: body.url,
            event_types: body.event_types,
            is_active: body.is_active,
            version: sql<number>`version + 1`,
          })
          .where('id', '=', id)
          .where('version', '=', v)
          .returning([
            'id',
            'organization_id',
            'url',
            'event_types',
            'is_active',
            'version',
            'created_at',
            'updated_at',
          ])
          .executeTakeFirst();

        if (!updated)
          throw new IdentityHttpError(409, 'OPTIMISTIC_CONCURRENCY_CONFLICT', 'Version mismatch');
        return updated;
      }),
  );

  app.post(
    '/api/v1/organizations/:organizationId/webhooks/:id/rotate-secret',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['organizationId', 'id'],
          properties: { organizationId: uuidSchema, id: uuidSchema },
        },
        headers: ifMatchHeader,
      },
    },
    async (request) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'integrations.webhooks.write');
        const { organizationId, id } = request.params as { organizationId: string; id: string };
        if (actor.organizationId !== organizationId) {
          throw new IdentityHttpError(403, 'FORBIDDEN', 'Access denied.');
        }

        const versionMatch = request.headers['if-match'];
        if (!versionMatch) {
          throw new IdentityHttpError(428, 'PRECONDITION_REQUIRED', 'If-Match is required');
        }
        const v = Number(versionMatch.replace(/"/g, ''));

        const existing = await actor.trx
          .selectFrom('webhook_subscriptions')
          .select(['version'])
          .where('id', '=', id)
          .where('organization_id', '=', organizationId)
          .executeTakeFirst();

        if (!existing) throw new IdentityHttpError(404, 'NOT_FOUND', 'Webhook not found');
        if (existing.version !== v) {
          throw new IdentityHttpError(409, 'OPTIMISTIC_CONCURRENCY_CONFLICT', 'Version mismatch');
        }

        const secret = 'whsec_' + crypto.randomBytes(24).toString('base64url');

        const updated = await actor.trx
          .updateTable('webhook_subscriptions')
          .set({
            secret: secret,
            version: sql<number>`version + 1`,
          })
          .where('id', '=', id)
          .where('version', '=', v)
          .returning([
            'id',
            'organization_id',
            'url',
            'event_types',
            'is_active',
            'version',
            'created_at',
            'updated_at',
          ])
          .executeTakeFirst();

        if (!updated)
          throw new IdentityHttpError(409, 'OPTIMISTIC_CONCURRENCY_CONFLICT', 'Version mismatch');
        return { subscription: updated, secret };
      }),
  );
};
