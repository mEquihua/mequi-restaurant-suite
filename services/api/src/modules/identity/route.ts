import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { sql, type RawBuilder } from 'kysely';

import { withAuthenticatedSession, IdentityHttpError, requirePermission } from './authentication.js';
import {
  effectiveRoles,
  findStaff,
  findTerminal,
  lockPinAttempt,
  recordFailedPinAttempt,
  resetPinAttempt,
} from './persistence/repository.js';
import {
  createSessionToken,
  createTerminalCredential,
  fingerprintPresentedCredential,
  hashPin,
  hashSecret,
  isPermissionName,
  nextFailedPinAttempt,
  parseTerminalCredential,
  retryAfterSeconds,
  secretMatchesHash,
  verifyPin,
} from './security.js';

const DUMMY_PIN_HASH = '$argon2id$v=19$m=19456,p=1,t=2$WFOhbphr4YF2f5d5cbVt6Q$ZvSA3wsMNnEL1wWs5MfpYFncxBPY4Jw2joqoLxxa7UI';
const uuidSchema = { type: 'string', format: 'uuid' } as const;
const terminalCredentialHeaders = {
  type: 'object',
  additionalProperties: true,
  required: ['x-terminal-credential'],
  properties: { 'x-terminal-credential': { type: 'string', minLength: 70 } },
} as const;
const pinUnlockSchema = {
  type: 'object', additionalProperties: false, required: ['staff_id', 'pin'],
  properties: { staff_id: uuidSchema, pin: { type: 'string', pattern: '^\\d{4,12}$' } },
} as const;
const staffSchema = {
  type: 'object', additionalProperties: false, required: ['first_name', 'last_name', 'pin', 'role_ids'],
  properties: { first_name: { type: 'string', minLength: 1 }, last_name: { type: 'string', minLength: 1 }, pin: { type: 'string', pattern: '^\\d{4,12}$' }, role_ids: { type: 'array', minItems: 1, items: uuidSchema } },
} as const;

export interface IdentityRouteOptions {
  now?: () => Date;
  sessionIdleMs?: number;
}

type PinUnlockBody = { staff_id: string; pin: string };
type EnrollTerminalBody = { location_id: string; name: string; device_profile?: string };
type CreateStaffBody = { first_name: string; last_name: string; pin: string; role_ids: string[] };
type UpdateStaffBody = { first_name?: string; last_name?: string; active?: boolean; pin?: string };
type UpdatePermissionsBody = { permissions: Array<{ permission_name: string; scope: 'organization' | 'location' }> };

function publicStaff(row: { id: string; first_name: string; last_name: string; active: boolean; version: number }) {
  return { id: row.id, first_name: row.first_name, last_name: row.last_name, active: row.active, version: row.version };
}

function publicTerminal(row: { id: string; location_id: string; name: string; device_profile: string | null; is_active: boolean; version: number }) {
  return { id: row.id, location_id: row.location_id, name: row.name, device_profile: row.device_profile, is_active: row.is_active, version: row.version };
}

function fail(reply: FastifyReply, request: FastifyRequest, error: IdentityHttpError) {
  for (const [name, value] of Object.entries(error.headers ?? {})) reply.header(name, value);
  return reply.status(error.statusCode).send({
    error: { status: error.statusCode, code: error.code, message: error.message, request_id: request.id, ...(error.details === undefined ? {} : { details: error.details }) },
  });
}

function terminalCredential(request: FastifyRequest) {
  const value = request.headers['x-terminal-credential'];
  return parseTerminalCredential(typeof value === 'string' ? value : undefined);
}

function parseIfMatch(value: string | undefined): number {
  if (!value) throw new IdentityHttpError(428, 'PRECONDITION_REQUIRED', 'If-Match is required for this update.');
  const parsed = Number(value.replaceAll('"', ''));
  if (!Number.isInteger(parsed) || parsed < 1) throw new IdentityHttpError(400, 'INVALID_IF_MATCH', 'If-Match must contain a positive integer version.');
  return parsed;
}

/** Private HTTP implementation for the identity module. */
export const identityRoute: FastifyPluginAsync<IdentityRouteOptions> = async (app, options) => {
  const now = options.now ?? (() => new Date());
  const sessionIdleMs = options.sessionIdleMs ?? 15 * 60 * 1000;
  const withSession = <T>(request: FastifyRequest, work: (session: Parameters<typeof requirePermission>[0]) => Promise<T>) =>
    withAuthenticatedSession(app, request, now(), sessionIdleMs, work);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof IdentityHttpError) return fail(reply, request, error);
    if (typeof error === 'object' && error !== null && 'validation' in error && (error as { validation?: unknown }).validation) {
      return reply.status(400).send({ error: { status: 400, code: 'VALIDATION_ERROR', message: 'The request does not match the required schema.', request_id: request.id } });
    }
    request.log.error({ err: error }, 'identity request failed');
    return reply.status(500).send({ error: { status: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', request_id: request.id } });
  });

  app.post('/api/v1/terminals/enroll', { schema: { body: { type: 'object', additionalProperties: false, required: ['location_id', 'name'], properties: { location_id: uuidSchema, name: { type: 'string', minLength: 1, maxLength: 120 }, device_profile: { type: 'string', maxLength: 120 } } } } }, async (request, reply) => {
    const body = request.body as EnrollTerminalBody;
    return withSession(request, async (actor) => {
      requirePermission(actor, 'iam.terminals.enroll');
      if (body.location_id !== actor.locationId) throw new IdentityHttpError(403, 'LOCATION_SCOPE_DENIED', 'The session is not scoped to the requested location.');
      if (!body.name?.trim()) throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'Terminal name is required.');
      const terminalId = crypto.randomUUID();
      const credential = createTerminalCredential(actor.locationId, terminalId);
      const terminal = await actor.trx
        .insertInto('terminals')
        .values({ id: terminalId, location_id: actor.locationId, name: body.name.trim(), device_profile: body.device_profile?.trim() || null, credential_hash: hashSecret(credential) })
        .returningAll()
        .executeTakeFirstOrThrow();
      return reply.status(201).send({ terminal: publicTerminal(terminal), terminal_credential: credential });
    });
  });

  app.get('/api/v1/terminals', async (request) =>
    withSession(request, async (actor) => {
      requirePermission(actor, 'iam.terminals.read');
      const terminals = await actor.trx.selectFrom('terminals').selectAll().orderBy('name').execute();
      return { data: terminals.map(publicTerminal) };
    }),
  );

  app.post('/api/v1/auth/pin-unlock', { schema: { headers: terminalCredentialHeaders, body: pinUnlockSchema } }, async (request, reply) => {
    const body = request.body as PinUnlockBody;
    const presentedTerminal = terminalCredential(request);
    if (!presentedTerminal) throw new IdentityHttpError(401, 'TERMINAL_UNAUTHENTICATED', 'A valid enrolled terminal credential is required.');
    if (!body.staff_id || !body.pin) throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'staff_id and pin are required.');
    const outcome = await app.withLocationTransaction(presentedTerminal.locationId, async (trx) => {
      const terminal = await findTerminal(trx, presentedTerminal.terminalId);
      if (!terminal || !terminal.is_active || !secretMatchesHash(presentedTerminal.credential, terminal.credential_hash)) {
        throw new IdentityHttpError(401, 'TERMINAL_UNAUTHENTICATED', 'The terminal credential is invalid or inactive.');
      }
      const fingerprint = fingerprintPresentedCredential(body.staff_id);
      const attempt = await lockPinAttempt(trx, terminal.id, fingerprint);
      const timestamp = now();
      const retryAfter = retryAfterSeconds({ failureCount: attempt.failure_count, nextAttemptAt: attempt.next_attempt_at }, timestamp);
      if (retryAfter !== undefined) {
        throw new IdentityHttpError(429, 'PIN_BACKOFF_ACTIVE', 'PIN verification is temporarily delayed for this terminal and credential.', { retry_after_seconds: retryAfter }, { 'Retry-After': String(retryAfter) });
      }

      const [staff, location] = await Promise.all([
        findStaff(trx, body.staff_id),
        trx.selectFrom('locations').select(['organization_id']).where('id', '=', terminal.location_id).executeTakeFirst(),
      ]);
      const assignedRoles = staff && location && staff.organization_id === location.organization_id ? await effectiveRoles(trx, staff.id, staff.organization_id) : [];
      const pinMatches = await verifyPin(staff?.pin_hash ?? DUMMY_PIN_HASH, body.pin);
      if (!staff || !location || !staff.active || staff.organization_id !== location.organization_id || assignedRoles.length === 0 || !pinMatches) {
        const next = nextFailedPinAttempt({ failureCount: attempt.failure_count, nextAttemptAt: attempt.next_attempt_at }, timestamp);
        await recordFailedPinAttempt(trx, terminal.id, fingerprint, next.failureCount, next.nextAttemptAt!);
        const seconds = retryAfterSeconds(next, timestamp)!;
        // Return a domain outcome so the transaction commits the per-terminal backoff state.
        return { kind: 'invalid-pin' as const, retryAfter: seconds };
      }

      const token = createSessionToken(terminal.location_id);
      const expiresAt = new Date(timestamp.getTime() + sessionIdleMs);
      await trx
        .insertInto('staff_sessions')
        .values({ staff_id: staff.id, location_id: terminal.location_id, terminal_id: terminal.id, token_hash: hashSecret(token), expires_at: expiresAt })
        .execute();
      await resetPinAttempt(trx, terminal.id, fingerprint);
      return { kind: 'success' as const, response: { token, expires_at: expiresAt.toISOString(), staff_id: staff.id, location_id: terminal.location_id } };
    });
    if (outcome.kind === 'invalid-pin') {
      throw new IdentityHttpError(401, 'INVALID_PIN', 'The staff credential or PIN is invalid.', undefined, { 'Retry-After': String(outcome.retryAfter) });
    }
    return reply.status(201).send(outcome.response);
  });

  app.post('/api/v1/auth/refresh', async (request) =>
    withSession(request, async (actor) => {
      const token = createSessionToken(actor.locationId);
      const expiresAt = new Date(now().getTime() + sessionIdleMs);
      await actor.trx.updateTable('staff_sessions').set({ revoked_at: now() }).where('id', '=', actor.sessionId).execute();
      await actor.trx
        .insertInto('staff_sessions')
        .values({ staff_id: actor.staffId, location_id: actor.locationId, terminal_id: actor.terminalId, token_hash: hashSecret(token), expires_at: expiresAt })
        .execute();
      return { token, expires_at: expiresAt.toISOString(), staff_id: actor.staffId, location_id: actor.locationId };
    }),
  );

  app.post('/api/v1/auth/logout', async (request, reply) =>
    withSession(request, async (actor) => {
      await actor.trx.updateTable('staff_sessions').set({ revoked_at: now() }).where('id', '=', actor.sessionId).execute();
      return reply.status(204).send();
    }),
  );

  app.get('/api/v1/auth/me', async (request) =>
    withSession(request, async (actor) => ({
      staff: { id: actor.staff.id, first_name: actor.staff.firstName, last_name: actor.staff.lastName, active: actor.staff.active, version: actor.staff.version },
      location_id: actor.locationId,
      terminal_id: actor.terminalId,
      roles: actor.roles,
      permissions: actor.permissions,
    })),
  );

  app.get('/api/v1/staff', async (request) =>
    withSession(request, async (actor) => {
      requirePermission(actor, 'iam.staff.read');
      const rows = await actor.trx
        .selectFrom('staff as s')
        .innerJoin('staff_roles as sr', 'sr.staff_id', 's.id')
        .select(['s.id', 's.first_name', 's.last_name', 's.active', 's.version'])
        .where('s.organization_id', '=', actor.organizationId)
        .distinct()
        .orderBy('s.last_name')
        .orderBy('s.first_name')
        .execute();
      return { data: rows.map(publicStaff) };
    }),
  );

  app.post('/api/v1/staff', { schema: { body: staffSchema } }, async (request, reply) => {
    const body = request.body as CreateStaffBody;
    return withSession(request, async (actor) => {
      requirePermission(actor, 'iam.staff.create');
      if (!body.first_name?.trim() || !body.last_name?.trim() || !/^\d{4,12}$/.test(body.pin ?? '') || !Array.isArray(body.role_ids) || body.role_ids.length === 0) {
        throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'first_name, last_name, a 4-12 digit PIN, and at least one role are required.');
      }
      const roles = await actor.trx.selectFrom('roles').select('id').where('organization_id', '=', actor.organizationId).where('id', 'in', body.role_ids).execute();
      if (roles.length !== new Set(body.role_ids).size) throw new IdentityHttpError(400, 'INVALID_ROLE', 'One or more roles do not belong to this organization.');
      const staff = await actor.trx
        .insertInto('staff')
        .values({ organization_id: actor.organizationId, first_name: body.first_name.trim(), last_name: body.last_name.trim(), pin_hash: await hashPin(body.pin) })
        .returningAll()
        .executeTakeFirstOrThrow();
      await actor.trx.insertInto('staff_roles').values(body.role_ids.map((roleId) => ({ staff_id: staff.id, role_id: roleId, location_id: actor.locationId }))).execute();
      return reply.status(201).send(publicStaff(staff));
    });
  });

  app.put('/api/v1/staff/:id', { schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuidSchema } }, headers: { type: 'object', additionalProperties: true, required: ['if-match'], properties: { 'if-match': { type: 'string', pattern: '^"?[1-9][0-9]*"?$' } } }, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { first_name: { type: 'string', minLength: 1 }, last_name: { type: 'string', minLength: 1 }, active: { type: 'boolean' }, pin: { type: 'string', pattern: '^\\d{4,12}$' }, role_ids: { type: 'array', minItems: 1, items: uuidSchema } } } } }, async (request, reply) => {
    const body = request.body as UpdateStaffBody & { role_ids?: string[] };
    const params = request.params as { id: string };
    const expectedVersion = parseIfMatch(request.headers['if-match']);
    return withSession(request, async (actor) => {
      requirePermission(actor, 'iam.staff.update');
      const patch: { first_name?: string; last_name?: string; active?: boolean; pin_hash?: string; version: RawBuilder<number> } = {
        version: sql<number>`version + 1`,
      };
      if (body.first_name !== undefined) patch.first_name = body.first_name.trim();
      if (body.last_name !== undefined) patch.last_name = body.last_name.trim();
      if (body.active !== undefined) patch.active = body.active;
      if (body.pin !== undefined) {
        if (!/^\d{4,12}$/.test(body.pin)) throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'PIN must contain 4-12 digits.');
        patch.pin_hash = await hashPin(body.pin);
      }
      if (body.role_ids !== undefined) {
        if (!Array.isArray(body.role_ids) || body.role_ids.length === 0) throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'role_ids must be a non-empty array.');
        const roles = await actor.trx.selectFrom('roles').select('id').where('organization_id', '=', actor.organizationId).where('id', 'in', body.role_ids).execute();
        if (roles.length !== new Set(body.role_ids).size) throw new IdentityHttpError(400, 'INVALID_ROLE', 'One or more roles do not belong to this organization.');
      }
      if (Object.keys(patch).length === 1 && body.role_ids === undefined) throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'At least one mutable staff field or role_ids is required.');
      const updated = await actor.trx
        .updateTable('staff')
        .set(patch)
        .where('id', '=', params.id)
        .where('organization_id', '=', actor.organizationId)
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirst();
      if (!updated) {
        const current = await actor.trx
          .selectFrom('staff as s')
          .innerJoin('staff_roles as sr', 'sr.staff_id', 's.id')
          .select(['s.id', 's.first_name', 's.last_name', 's.active', 's.version'])
          .where('s.id', '=', params.id)
          .where('s.organization_id', '=', actor.organizationId)
          .distinct()
          .executeTakeFirst();
        if (!current) throw new IdentityHttpError(404, 'NOT_FOUND', 'Staff member was not found in this location scope.');
        throw new IdentityHttpError(409, 'OPTIMISTIC_CONCURRENCY_CONFLICT', 'The resource has been modified since it was last read. Please refresh and try again.', { current_version: current.version, current_state: publicStaff(current) });
      }
      if (body.role_ids !== undefined) {
        await actor.trx.deleteFrom('staff_roles').where('staff_id', '=', params.id).where('location_id', '=', actor.locationId).execute();
        await actor.trx.insertInto('staff_roles').values(body.role_ids.map((roleId) => ({ staff_id: params.id, role_id: roleId, location_id: actor.locationId }))).execute();
      }
      return reply.send(publicStaff(updated));
    });
  });

  app.get('/api/v1/roles', async (request) =>
    withSession(request, async (actor) => {
      requirePermission(actor, 'iam.roles.read');
      const rows = await actor.trx
        .selectFrom('roles as r')
        .leftJoin('role_permissions as rp', 'rp.role_id', 'r.id')
        .select(['r.id', 'r.name', 'r.description', 'r.is_system_template', 'rp.permission_name', 'rp.scope'])
        .where('r.organization_id', '=', actor.organizationId)
        .orderBy('r.name')
        .execute();
      const roles = new Map<string, { id: string; name: string; description: string | null; is_system_template: boolean; permissions: Array<{ permission_name: string; scope: string }> }>();
      for (const row of rows) {
        const role = roles.get(row.id) ?? { id: row.id, name: row.name, description: row.description, is_system_template: row.is_system_template, permissions: [] };
        if (row.permission_name && row.scope) role.permissions.push({ permission_name: row.permission_name, scope: row.scope });
        roles.set(row.id, role);
      }
      return { data: [...roles.values()] };
    }),
  );

  app.post('/api/v1/roles', { schema: { body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1 }, description: { type: ['string', 'null'] } } } } }, async (request, reply) => {
    const body = request.body as { name: string; description?: string | null };
    return withSession(request, async (actor) => {
      requirePermission(actor, 'iam.roles.update');
      const role = await actor.trx.insertInto('roles').values({ organization_id: actor.organizationId, name: body.name.trim(), description: body.description?.trim() || null, is_system_template: false }).returningAll().executeTakeFirstOrThrow();
      return reply.status(201).send({ id: role.id, name: role.name, description: role.description, is_system_template: role.is_system_template, permissions: [] });
    });
  });

  app.put('/api/v1/roles/:id/permissions', { schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuidSchema } }, body: { type: 'object', additionalProperties: false, required: ['permissions'], properties: { permissions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['permission_name', 'scope'], properties: { permission_name: { type: 'string', pattern: '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$' }, scope: { type: 'string', enum: ['organization', 'location'] } } } } } } } }, async (request) => {
    const body = request.body as UpdatePermissionsBody;
    const params = request.params as { id: string };
    return withSession(request, async (actor) => {
      requirePermission(actor, 'iam.roles.update');
      if (!Array.isArray(body.permissions) || body.permissions.some((permission) => !isPermissionName(permission.permission_name) || !['organization', 'location'].includes(permission.scope))) {
        throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'Each permission must use <domain>.<resource>.<action> and a valid scope.');
      }
      const role = await actor.trx.selectFrom('roles').select('id').where('id', '=', params.id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
      if (!role) throw new IdentityHttpError(404, 'NOT_FOUND', 'Role was not found.');
      await actor.trx.deleteFrom('role_permissions').where('role_id', '=', role.id).execute();
      if (body.permissions.length > 0) await actor.trx.insertInto('role_permissions').values(body.permissions.map((permission) => ({ role_id: role.id, ...permission }))).execute();
      return { id: role.id, permissions: body.permissions };
    });
  });
};
