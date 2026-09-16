import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';

import { IdentityHttpError, requirePermission, withAuthenticatedSession } from '../identity/index.js';
import { canPauseModule, type ModuleStatus } from './status.js';

const uuidSchema = { type: 'string', format: 'uuid' } as const;
const moduleKeySchema = { type: 'string', pattern: '^[a-z][a-z0-9_]*$', maxLength: 80 } as const;
const ifMatchHeader = { type: 'object', additionalProperties: true, properties: { 'if-match': { type: 'string', pattern: '^"?[1-9][0-9]*"?$' } } } as const;

export interface ModuleCenterRouteOptions { now?: () => Date; sessionIdleMs?: number }

function fail(reply: FastifyReply, request: FastifyRequest, error: IdentityHttpError) {
  for (const [name, value] of Object.entries(error.headers ?? {})) reply.header(name, value);
  return reply.status(error.statusCode).send({ error: { status: error.statusCode, code: error.code, message: error.message, request_id: request.id, ...(error.details === undefined ? {} : { details: error.details }) } });
}

function parseIfMatch(value: string | undefined): number {
  if (!value) throw new IdentityHttpError(428, 'PRECONDITION_REQUIRED', 'If-Match is required for an existing module activation.');
  const parsed = Number(value.replaceAll('"', ''));
  if (!Number.isInteger(parsed) || parsed < 1) throw new IdentityHttpError(400, 'INVALID_IF_MATCH', 'If-Match must contain a positive integer version.');
  return parsed;
}

function publicActivation(row: { location_id: string; module_key: string; status: string; attention_reason: string | null; version: number }) {
  return { ...row };
}

/** Private HTTP implementation for the Module Center module. */
export const moduleCenterRoute: FastifyPluginAsync<ModuleCenterRouteOptions> = async (app, options) => {
  const now = options.now ?? (() => new Date());
  const sessionIdleMs = options.sessionIdleMs ?? 15 * 60 * 1000;
  const withSession = <T>(request: FastifyRequest, work: Parameters<typeof withAuthenticatedSession<T>>[4]) => withAuthenticatedSession(app, request, now(), sessionIdleMs, work);
  const requireActorLocation = (actor: { locationId: string }, locationId: string) => {
    if (locationId !== actor.locationId) throw new IdentityHttpError(403, 'LOCATION_SCOPE_DENIED', 'The session is not scoped to the requested location.');
  };

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof IdentityHttpError) return fail(reply, request, error);
    if (typeof error === 'object' && error !== null && 'validation' in error && (error as { validation?: unknown }).validation) return reply.status(400).send({ error: { status: 400, code: 'VALIDATION_ERROR', message: 'The request does not match the required schema.', request_id: request.id } });
    request.log.error({ err: error }, 'module center request failed');
    return reply.status(500).send({ error: { status: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', request_id: request.id } });
  });

  app.get('/api/v1/module-definitions', async (request) => withSession(request, async (actor) => {
    requirePermission(actor, 'module_center.modules.read');
    return { data: await actor.trx.selectFrom('module_definitions').selectAll().orderBy('key').execute() };
  }));

  app.get('/api/v1/locations/:locationId/modules', { schema: { params: { type: 'object', additionalProperties: false, required: ['locationId'], properties: { locationId: uuidSchema } } } }, async (request) => withSession(request, async (actor) => {
    requirePermission(actor, 'module_center.modules.read'); const { locationId } = request.params as { locationId: string }; requireActorLocation(actor, locationId);
    const definitions = await actor.trx.selectFrom('module_definitions').selectAll().orderBy('key').execute();
    const activations = await actor.trx.selectFrom('module_activations').selectAll().where('location_id', '=', locationId).execute();
    const byKey = new Map(activations.map((activation) => [activation.module_key, activation]));
    return { data: definitions.map((definition) => ({ ...definition, location_id: locationId, status: 'DISABLED', attention_reason: null, version: 0, ...byKey.get(definition.key) })) };
  }));

  async function loadDefinition(actor: { trx: typeof app.db }, moduleKey: string) {
    const definition = await actor.trx.selectFrom('module_definitions').select('key').where('key', '=', moduleKey).executeTakeFirst();
    if (!definition) throw new IdentityHttpError(404, 'MODULE_DEFINITION_NOT_FOUND', 'Module definition was not found.');
  }

  async function changeStatus(request: FastifyRequest, reply: FastifyReply, target: ModuleStatus, reason?: string) {
    return withSession(request, async (actor) => {
      requirePermission(actor, 'module_center.modules.write');
      const { locationId, moduleKey } = request.params as { locationId: string; moduleKey: string }; requireActorLocation(actor, locationId); await loadDefinition(actor, moduleKey);
      const current = await actor.trx.selectFrom('module_activations').selectAll().where('location_id', '=', locationId).where('module_key', '=', moduleKey).executeTakeFirst();
      if (target === 'PAUSED' && (!current || !canPauseModule(current.status as ModuleStatus))) throw new IdentityHttpError(409, 'ILLEGAL_MODULE_STATUS_TRANSITION', `Cannot pause a module from ${current?.status ?? 'DISABLED'}.`);
      if (!current) {
        const created = await actor.trx.insertInto('module_activations').values({ location_id: locationId, module_key: moduleKey, status: target, attention_reason: reason ?? null }).returningAll().executeTakeFirstOrThrow();
        return reply.send(publicActivation(created));
      }
      const expected = parseIfMatch(request.headers['if-match']);
      const updated = await actor.trx.updateTable('module_activations').set({ status: target, attention_reason: target === 'NEEDS_ATTENTION' ? reason! : null, version: sql<number>`version + 1` }).where('location_id', '=', locationId).where('module_key', '=', moduleKey).where('version', '=', expected).returningAll().executeTakeFirst();
      if (!updated) throw new IdentityHttpError(409, 'OPTIMISTIC_CONCURRENCY_CONFLICT', 'The resource has been modified since it was last read. Please refresh and try again.', { current_version: current.version, current_state: publicActivation(current) });
      return reply.send(publicActivation(updated));
    });
  }

  const commandSchema = { params: { type: 'object', additionalProperties: false, required: ['locationId', 'moduleKey'], properties: { locationId: uuidSchema, moduleKey: moduleKeySchema } }, headers: ifMatchHeader } as const;
  app.post('/api/v1/locations/:locationId/modules/:moduleKey/activate', { schema: { ...commandSchema, body: { type: 'object', additionalProperties: false, maxProperties: 0 } } }, async (request, reply) => changeStatus(request, reply, 'ACTIVE'));
  app.post('/api/v1/locations/:locationId/modules/:moduleKey/pause', { schema: { ...commandSchema, body: { type: 'object', additionalProperties: false, maxProperties: 0 } } }, async (request, reply) => changeStatus(request, reply, 'PAUSED'));
  // Product invariant: disabling or pausing never deletes historical information; this only changes the activation row.
  app.post('/api/v1/locations/:locationId/modules/:moduleKey/deactivate', { schema: { ...commandSchema, body: { type: 'object', additionalProperties: false, maxProperties: 0 } } }, async (request, reply) => changeStatus(request, reply, 'DISABLED'));
  app.post('/api/v1/locations/:locationId/modules/:moduleKey/flag-attention', { schema: { ...commandSchema, body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 2000 } } } } }, async (request, reply) => changeStatus(request, reply, 'NEEDS_ATTENTION', (request.body as { reason: string }).reason.trim()));
};
