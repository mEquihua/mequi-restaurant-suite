import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { sql, type RawBuilder } from 'kysely';

import { IdentityHttpError, requirePermission, withAuthenticatedSession } from '../identity/index.js';
import { effectivePrice, resolveAvailability, type AvailabilityStatus } from './availability.js';
import { assertLocationInOrganization, findOrganizationCategory, findOrganizationModifierGroup, findOrganizationProduct } from './persistence/repository.js';

const uuidSchema = { type: 'string', format: 'uuid' } as const;
const ifMatchHeader = { type: 'object', additionalProperties: true, required: ['if-match'], properties: { 'if-match': { type: 'string', pattern: '^"?[0-9]+"?$' } } } as const;
const nullableString = { type: ['string', 'null'] } as const;
const availabilityStatus = ['EXHAUSTED', 'HIDDEN', 'SCHEDULED'] as const;

export interface MenuRouteOptions {
  now?: () => Date;
  sessionIdleMs?: number;
}

type ProductBody = { category_id?: string | null; name: string; internal_name?: string | null; description?: string | null; photo_url?: string | null; notes?: string | null; allergens?: string[]; tags?: string[]; base_price: number; is_active?: boolean };
type AvailabilityBody = { rule_id?: string; status?: AvailabilityStatus; channel_scope?: string | null; service_type_scope?: string | null; days_of_week?: number[] | null; start_time?: string | null; end_time?: string | null };

function fail(reply: FastifyReply, request: FastifyRequest, error: IdentityHttpError) {
  for (const [name, value] of Object.entries(error.headers ?? {})) reply.header(name, value);
  return reply.status(error.statusCode).send({
    error: { status: error.statusCode, code: error.code, message: error.message, request_id: request.id, ...(error.details === undefined ? {} : { details: error.details }) },
  });
}

function parseIfMatch(value: string | undefined, allowCreate = false): number {
  if (!value) throw new IdentityHttpError(428, 'PRECONDITION_REQUIRED', 'If-Match is required for this update.');
  const parsed = Number(value.replaceAll('"', ''));
  if (!Number.isInteger(parsed) || parsed < (allowCreate ? 0 : 1)) throw new IdentityHttpError(400, 'INVALID_IF_MATCH', allowCreate ? 'If-Match must contain a non-negative integer version.' : 'If-Match must contain a positive integer version.');
  return parsed;
}

function optionalText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : value.trim() || null;
}

function validSelectionRange(min: number, max: number | null | undefined): boolean {
  return Number.isInteger(min) && min >= 0 && (max === null || max === undefined || (Number.isInteger(max) && max >= min));
}

function dates(body: AvailabilityBody): { start_time: Date | null; end_time: Date | null } {
  const start_time = body.start_time ? new Date(body.start_time) : null;
  const end_time = body.end_time ? new Date(body.end_time) : null;
  if ((start_time && Number.isNaN(start_time.getTime())) || (end_time && Number.isNaN(end_time.getTime())) || (start_time && end_time && start_time >= end_time)) {
    throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'Availability times must be valid and end_time must be after start_time.');
  }
  return { start_time, end_time };
}

function publicCategory(row: { id: string; name: string; description: string | null; display_order: number; is_active: boolean }) {
  return { id: row.id, name: row.name, description: row.description, display_order: row.display_order, is_active: row.is_active };
}

function publicAvailability(row: { id: string; location_id: string; product_id: string; status: string; channel_scope: string | null; service_type_scope: string | null; days_of_week: number[] | null; start_time: Date | null; end_time: Date | null; version: number }) {
  return { ...row, start_time: row.start_time?.toISOString() ?? null, end_time: row.end_time?.toISOString() ?? null };
}

/** Private HTTP implementation for the menu module. */
export const menuRoute: FastifyPluginAsync<MenuRouteOptions> = async (app, options) => {
  const now = options.now ?? (() => new Date());
  const sessionIdleMs = options.sessionIdleMs ?? 15 * 60 * 1000;
  const withSession = <T>(request: FastifyRequest, work: Parameters<typeof withAuthenticatedSession<T>>[4]) => withAuthenticatedSession(app, request, now(), sessionIdleMs, work);

  async function productRepresentation(trx: Parameters<typeof findOrganizationProduct>[0], organizationId: string, locationId: string, productId: string, context: { channel?: string; serviceType?: string; at?: Date } = {}) {
    const product = await findOrganizationProduct(trx, organizationId, productId);
    if (!product) return undefined;
    const [override, variants, groupRows, comboRows, ruleRows] = await Promise.all([
      trx.selectFrom('location_price_overrides').select('override_price').where('location_id', '=', locationId).where('product_id', '=', productId).executeTakeFirst(),
      trx.selectFrom('product_variants').selectAll().where('product_id', '=', productId).orderBy('display_order').execute(),
      trx.selectFrom('product_modifier_groups as pmg').innerJoin('modifier_groups as mg', 'mg.id', 'pmg.modifier_group_id').select(['mg.id', 'mg.name', 'mg.min_selections', 'mg.max_selections', 'mg.is_active', 'pmg.display_order']).where('pmg.product_id', '=', productId).orderBy('pmg.display_order').execute(),
      trx.selectFrom('product_combo_groups').selectAll().where('product_id', '=', productId).orderBy('name').execute(),
      trx.selectFrom('availability_rules').selectAll().where('location_id', '=', locationId).where('product_id', '=', productId).execute(),
    ]);
    const price = effectivePrice(product.base_price, override?.override_price);
    const modifier_groups = await Promise.all(groupRows.map(async (group) => ({
      id: group.id, name: group.name, min_selections: group.min_selections, max_selections: group.max_selections, is_active: group.is_active, display_order: group.display_order,
      modifiers: await trx.selectFrom('modifiers').select(['id', 'name', 'price_adjustment', 'display_order', 'is_active']).where('modifier_group_id', '=', group.id).orderBy('display_order').execute(),
    })));
    const combo_groups = await Promise.all(comboRows.map(async (group) => ({
      id: group.id, name: group.name, min_selections: group.min_selections, max_selections: group.max_selections,
      items: await trx.selectFrom('product_combo_items as pci').innerJoin('products as p', 'p.id', 'pci.product_id').select(['pci.id', 'pci.product_id', 'pci.price_adjustment', 'p.name']).where('pci.combo_group_id', '=', group.id).execute(),
    })));
    const availability = resolveAvailability(ruleRows as Parameters<typeof resolveAvailability>[0], { channel: context.channel, serviceType: context.serviceType, now: context.at ?? now() });
    return {
      id: product.id, category_id: product.category_id, name: product.name, internal_name: product.internal_name, description: product.description, photo_url: product.photo_url, notes: product.notes,
      allergens: product.allergens, tags: product.tags, is_active: product.is_active, version: product.version, price,
      variants: variants.map((variant) => ({ id: variant.id, name: variant.name, price: price + variant.price_adjustment, price_adjustment: variant.price_adjustment, display_order: variant.display_order })),
      modifier_groups, combo_groups, availability,
    };
  }

  async function requireActorLocation(actor: { locationId: string; organizationId: string; trx: Parameters<typeof findOrganizationProduct>[0] }, requestedLocationId: string) {
    if (requestedLocationId !== actor.locationId) throw new IdentityHttpError(403, 'LOCATION_SCOPE_DENIED', 'The session is not scoped to the requested location.');
    if (!await assertLocationInOrganization(actor.trx, actor.organizationId, requestedLocationId)) throw new IdentityHttpError(404, 'NOT_FOUND', 'Location was not found.');
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof IdentityHttpError) return fail(reply, request, error);
    if (typeof error === 'object' && error !== null && 'validation' in error && (error as { validation?: unknown }).validation) return reply.status(400).send({ error: { status: 400, code: 'VALIDATION_ERROR', message: 'The request does not match the required schema.', request_id: request.id } });
    request.log.error({ err: error }, 'menu request failed');
    return reply.status(500).send({ error: { status: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', request_id: request.id } });
  });

  app.get('/api/v1/categories', async (request) => withSession(request, async (actor) => {
    requirePermission(actor, 'menu.catalog.read');
    const categories = await actor.trx.selectFrom('categories').selectAll().where('organization_id', '=', actor.organizationId).orderBy('display_order').orderBy('name').execute();
    return { data: categories.map(publicCategory) };
  }));

  app.post('/api/v1/categories', { schema: { body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 160 }, description: nullableString, display_order: { type: 'integer' }, is_active: { type: 'boolean' } } } } }, async (request, reply) => withSession(request, async (actor) => {
    requirePermission(actor, 'menu.products.write');
    const body = request.body as { name: string; description?: string | null; display_order?: number; is_active?: boolean };
    const category = await actor.trx.insertInto('categories').values({ organization_id: actor.organizationId, name: body.name.trim(), description: optionalText(body.description) ?? null, display_order: body.display_order ?? 0, is_active: body.is_active ?? true }).returningAll().executeTakeFirstOrThrow();
    return reply.status(201).send(publicCategory(category));
  }));

  app.put('/api/v1/categories/:id', { schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuidSchema } }, headers: ifMatchHeader, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { name: { type: 'string', minLength: 1, maxLength: 160 }, description: nullableString, display_order: { type: 'integer' }, is_active: { type: 'boolean' } } } } }, async (request, reply) => withSession(request, async (actor) => {
    requirePermission(actor, 'menu.products.write');
    const body = request.body as { name?: string; description?: string | null; display_order?: number; is_active?: boolean };
    const categoryId = (request.params as { id: string }).id;
    const expectedVersion = parseIfMatch(request.headers['if-match']);
    const patch: Record<string, unknown> & { version: RawBuilder<number> } = { version: sql<number>`version + 1` };
    for (const field of ['name', 'description', 'display_order', 'is_active'] as const) {
      if (body[field] !== undefined) patch[field] = field === 'name' ? String(body[field]).trim() : field === 'description' ? optionalText(body[field] as string | null) : body[field];
    }
    const updated = await actor.trx.updateTable('categories').set(patch as never).where('id', '=', categoryId).where('organization_id', '=', actor.organizationId).where('version', '=', expectedVersion).returningAll().executeTakeFirst();
    if (!updated) {
      const current = await actor.trx.selectFrom('categories').selectAll().where('id', '=', categoryId).where('organization_id', '=', actor.organizationId).executeTakeFirst();
      if (!current) throw new IdentityHttpError(404, 'NOT_FOUND', 'Category was not found.');
      throw new IdentityHttpError(409, 'OPTIMISTIC_CONCURRENCY_CONFLICT', 'The resource has been modified since it was last read. Please refresh and try again.', { current_version: current.version, current_state: publicCategory(current) });
    }
    return reply.send(publicCategory(updated));
  }));

  app.get('/api/v1/products', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { channel: { type: 'string' }, service_type: { type: 'string' }, at: { type: 'string', format: 'date-time' } } } } }, async (request) => withSession(request, async (actor) => {
    requirePermission(actor, 'menu.catalog.read');
    const query = request.query as { channel?: string; service_type?: string; at?: string };
    const at = query.at ? new Date(query.at) : undefined;
    if (at && Number.isNaN(at.getTime())) throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'at must be a valid date-time.');
    const rows = await actor.trx.selectFrom('products').select('id').where('organization_id', '=', actor.organizationId).orderBy('name').execute();
    return { data: (await Promise.all(rows.map((row) => productRepresentation(actor.trx, actor.organizationId, actor.locationId, row.id, { channel: query.channel, serviceType: query.service_type, at })))).filter((product): product is NonNullable<typeof product> => product !== undefined) };
  }));

  app.post('/api/v1/products', { schema: { body: { type: 'object', additionalProperties: false, required: ['name', 'base_price'], properties: { category_id: { anyOf: [uuidSchema, { type: 'null' }] }, name: { type: 'string', minLength: 1, maxLength: 200 }, internal_name: nullableString, description: nullableString, photo_url: nullableString, notes: nullableString, allergens: { type: 'array', items: { type: 'string' } }, tags: { type: 'array', items: { type: 'string' } }, base_price: { type: 'integer', minimum: 0 }, is_active: { type: 'boolean' } } } } }, async (request, reply) => withSession(request, async (actor) => {
    requirePermission(actor, 'menu.products.write');
    const body = request.body as ProductBody;
    if (body.category_id && !await findOrganizationCategory(actor.trx, actor.organizationId, body.category_id)) throw new IdentityHttpError(400, 'INVALID_CATEGORY', 'Category does not belong to this organization.');
    const product = await actor.trx.insertInto('products').values({ organization_id: actor.organizationId, category_id: body.category_id ?? null, name: body.name.trim(), internal_name: optionalText(body.internal_name) ?? null, description: optionalText(body.description) ?? null, photo_url: optionalText(body.photo_url) ?? null, notes: optionalText(body.notes) ?? null, allergens: body.allergens ?? [], tags: body.tags ?? [], base_price: body.base_price, is_active: body.is_active ?? true }).returning('id').executeTakeFirstOrThrow();
    return reply.status(201).send(await productRepresentation(actor.trx, actor.organizationId, actor.locationId, product.id));
  }));

  app.put('/api/v1/products/:id', { schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuidSchema } }, headers: ifMatchHeader, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { category_id: { anyOf: [uuidSchema, { type: 'null' }] }, name: { type: 'string', minLength: 1, maxLength: 200 }, internal_name: nullableString, description: nullableString, photo_url: nullableString, notes: nullableString, allergens: { type: 'array', items: { type: 'string' } }, tags: { type: 'array', items: { type: 'string' } }, base_price: { type: 'integer', minimum: 0 }, is_active: { type: 'boolean' } } } } }, async (request, reply) => withSession(request, async (actor) => {
    requirePermission(actor, 'menu.products.write');
    const body = request.body as Partial<ProductBody>;
    const productId = (request.params as { id: string }).id;
    const expectedVersion = parseIfMatch(request.headers['if-match']);
    if (body.category_id && !await findOrganizationCategory(actor.trx, actor.organizationId, body.category_id)) throw new IdentityHttpError(400, 'INVALID_CATEGORY', 'Category does not belong to this organization.');
    const patch: Record<string, unknown> & { version: RawBuilder<number> } = { version: sql<number>`version + 1` };
    for (const field of ['category_id', 'name', 'internal_name', 'description', 'photo_url', 'notes', 'allergens', 'tags', 'base_price', 'is_active'] as const) {
      if (body[field] !== undefined) patch[field] = field === 'name' ? String(body[field]).trim() : ['internal_name', 'description', 'photo_url', 'notes'].includes(field) ? optionalText(body[field] as string | null) : body[field];
    }
    const updated = await actor.trx.updateTable('products').set(patch as never).where('id', '=', productId).where('organization_id', '=', actor.organizationId).where('version', '=', expectedVersion).returning('id').executeTakeFirst();
    if (!updated) {
      const current = await productRepresentation(actor.trx, actor.organizationId, actor.locationId, productId);
      if (!current) throw new IdentityHttpError(404, 'NOT_FOUND', 'Product was not found.');
      throw new IdentityHttpError(409, 'OPTIMISTIC_CONCURRENCY_CONFLICT', 'The resource has been modified since it was last read. Please refresh and try again.', { current_version: current.version, current_state: current });
    }
    return reply.send(await productRepresentation(actor.trx, actor.organizationId, actor.locationId, updated.id));
  }));

  app.post('/api/v1/products/:id/variants', { schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuidSchema } }, body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1 }, price_adjustment: { type: 'integer' }, display_order: { type: 'integer' } } } } }, async (request, reply) => withSession(request, async (actor) => {
    requirePermission(actor, 'menu.products.write');
    const productId = (request.params as { id: string }).id; const body = request.body as { name: string; price_adjustment?: number; display_order?: number };
    if (!await findOrganizationProduct(actor.trx, actor.organizationId, productId)) throw new IdentityHttpError(404, 'NOT_FOUND', 'Product was not found.');
    const variant = await actor.trx.insertInto('product_variants').values({ product_id: productId, name: body.name.trim(), price_adjustment: body.price_adjustment ?? 0, display_order: body.display_order ?? 0 }).returningAll().executeTakeFirstOrThrow();
    return reply.status(201).send(variant);
  }));

  app.post('/api/v1/modifier-groups', { schema: { body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1 }, min_selections: { type: 'integer', minimum: 0 }, max_selections: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] }, is_active: { type: 'boolean' } } } } }, async (request, reply) => withSession(request, async (actor) => {
    requirePermission(actor, 'menu.products.write');
    const body = request.body as { name: string; min_selections?: number; max_selections?: number | null; is_active?: boolean };
    const min = body.min_selections ?? 0; if (!validSelectionRange(min, body.max_selections)) throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'max_selections must be at least min_selections.');
    const group = await actor.trx.insertInto('modifier_groups').values({ organization_id: actor.organizationId, name: body.name.trim(), min_selections: min, max_selections: body.max_selections ?? null, is_active: body.is_active ?? true }).returningAll().executeTakeFirstOrThrow();
    return reply.status(201).send(group);
  }));

  app.post('/api/v1/modifier-groups/:id/modifiers', { schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuidSchema } }, body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1 }, price_adjustment: { type: 'integer' }, display_order: { type: 'integer' }, is_active: { type: 'boolean' } } } } }, async (request, reply) => withSession(request, async (actor) => {
    requirePermission(actor, 'menu.products.write');
    const groupId = (request.params as { id: string }).id; const body = request.body as { name: string; price_adjustment?: number; display_order?: number; is_active?: boolean };
    if (!await findOrganizationModifierGroup(actor.trx, actor.organizationId, groupId)) throw new IdentityHttpError(404, 'NOT_FOUND', 'Modifier group was not found.');
    const modifier = await actor.trx.insertInto('modifiers').values({ modifier_group_id: groupId, name: body.name.trim(), price_adjustment: body.price_adjustment ?? 0, display_order: body.display_order ?? 0, is_active: body.is_active ?? true }).returningAll().executeTakeFirstOrThrow();
    return reply.status(201).send(modifier);
  }));

  app.post('/api/v1/products/:id/modifier-groups', { schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuidSchema } }, body: { type: 'object', additionalProperties: false, required: ['modifier_group_id'], properties: { modifier_group_id: uuidSchema, display_order: { type: 'integer' } } } } }, async (request, reply) => withSession(request, async (actor) => {
    requirePermission(actor, 'menu.products.write');
    const productId = (request.params as { id: string }).id; const body = request.body as { modifier_group_id: string; display_order?: number };
    if (!await findOrganizationProduct(actor.trx, actor.organizationId, productId) || !await findOrganizationModifierGroup(actor.trx, actor.organizationId, body.modifier_group_id)) throw new IdentityHttpError(404, 'NOT_FOUND', 'Product or modifier group was not found.');
    const attached = await actor.trx.insertInto('product_modifier_groups').values({ product_id: productId, modifier_group_id: body.modifier_group_id, display_order: body.display_order ?? 0 }).onConflict((oc) => oc.columns(['product_id', 'modifier_group_id']).doUpdateSet({ display_order: body.display_order ?? 0 })).returningAll().executeTakeFirstOrThrow();
    return reply.status(201).send(attached);
  }));

  app.post('/api/v1/products/:id/combo-groups', { schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuidSchema } }, body: { type: 'object', additionalProperties: false, required: ['name', 'items'], properties: { name: { type: 'string', minLength: 1 }, min_selections: { type: 'integer', minimum: 0 }, max_selections: { type: 'integer', minimum: 0 }, items: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['product_id'], properties: { product_id: uuidSchema, price_adjustment: { type: 'integer' } } } } } } } }, async (request, reply) => withSession(request, async (actor) => {
    requirePermission(actor, 'menu.products.write');
    const productId = (request.params as { id: string }).id; const body = request.body as { name: string; min_selections?: number; max_selections?: number; items: Array<{ product_id: string; price_adjustment?: number }> };
    const min = body.min_selections ?? 1; const max = body.max_selections ?? 1;
    if (!validSelectionRange(min, max) || max < 1 || body.items.length < min) throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'Combo selections are invalid.');
    if (!await findOrganizationProduct(actor.trx, actor.organizationId, productId)) throw new IdentityHttpError(404, 'NOT_FOUND', 'Product was not found.');
    const options = await actor.trx.selectFrom('products').select('id').where('organization_id', '=', actor.organizationId).where('id', 'in', body.items.map((item) => item.product_id)).execute();
    if (options.length !== new Set(body.items.map((item) => item.product_id)).size) throw new IdentityHttpError(400, 'INVALID_COMBO_ITEM', 'Every combo item must belong to this organization.');
    const combo = await actor.trx.insertInto('product_combo_groups').values({ product_id: productId, name: body.name.trim(), min_selections: min, max_selections: max }).returningAll().executeTakeFirstOrThrow();
    await actor.trx.insertInto('product_combo_items').values(body.items.map((item) => ({ combo_group_id: combo.id, product_id: item.product_id, price_adjustment: item.price_adjustment ?? 0 }))).execute();
    return reply.status(201).send({ ...combo, items: body.items });
  }));

  app.post('/api/v1/products/:id/duplicate', { schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuidSchema } } } }, async (request, reply) => withSession(request, async (actor) => {
    requirePermission(actor, 'menu.products.write');
    const sourceId = (request.params as { id: string }).id; const source = await findOrganizationProduct(actor.trx, actor.organizationId, sourceId);
    if (!source) throw new IdentityHttpError(404, 'NOT_FOUND', 'Product was not found.');
    const duplicate = await actor.trx.insertInto('products').values({ organization_id: source.organization_id, category_id: source.category_id, name: `Copy of ${source.name}`, internal_name: source.internal_name, description: source.description, photo_url: source.photo_url, notes: source.notes, allergens: source.allergens, tags: source.tags, base_price: source.base_price, is_active: source.is_active }).returning('id').executeTakeFirstOrThrow();
    const variants = await actor.trx.selectFrom('product_variants').select(['name', 'price_adjustment', 'display_order']).where('product_id', '=', sourceId).execute();
    if (variants.length) await actor.trx.insertInto('product_variants').values(variants.map((variant) => ({ product_id: duplicate.id, ...variant }))).execute();
    const groups = await actor.trx.selectFrom('product_modifier_groups').select(['modifier_group_id', 'display_order']).where('product_id', '=', sourceId).execute();
    if (groups.length) await actor.trx.insertInto('product_modifier_groups').values(groups.map((group) => ({ product_id: duplicate.id, ...group }))).execute();
    return reply.status(201).send(await productRepresentation(actor.trx, actor.organizationId, actor.locationId, duplicate.id));
  }));

  app.put('/api/v1/locations/:locationId/price-overrides/:productId', { schema: { params: { type: 'object', additionalProperties: false, required: ['locationId', 'productId'], properties: { locationId: uuidSchema, productId: uuidSchema } }, headers: ifMatchHeader, body: { type: 'object', additionalProperties: false, required: ['override_price'], properties: { override_price: { type: 'integer', minimum: 0 } } } } }, async (request, reply) => withSession(request, async (actor) => {
    requirePermission(actor, 'menu.prices.update');
    const params = request.params as { locationId: string; productId: string }; const expected = parseIfMatch(request.headers['if-match'], true); const body = request.body as { override_price: number };
    await requireActorLocation(actor, params.locationId);
    if (!await findOrganizationProduct(actor.trx, actor.organizationId, params.productId)) throw new IdentityHttpError(404, 'NOT_FOUND', 'Product was not found.');
    const existing = await actor.trx.selectFrom('location_price_overrides').selectAll().where('location_id', '=', params.locationId).where('product_id', '=', params.productId).executeTakeFirst();
    if (!existing && expected !== 0) throw new IdentityHttpError(409, 'OPTIMISTIC_CONCURRENCY_CONFLICT', 'The resource has been modified since it was last read. Please refresh and try again.', { current_version: 0, current_state: null });
    if (existing && existing.version !== expected) throw new IdentityHttpError(409, 'OPTIMISTIC_CONCURRENCY_CONFLICT', 'The resource has been modified since it was last read. Please refresh and try again.', { current_version: existing.version, current_state: existing });
    const override = existing
      ? await actor.trx.updateTable('location_price_overrides').set({ override_price: body.override_price, version: sql<number>`version + 1` }).where('location_id', '=', params.locationId).where('product_id', '=', params.productId).returningAll().executeTakeFirstOrThrow()
      : await actor.trx.insertInto('location_price_overrides').values({ location_id: params.locationId, product_id: params.productId, override_price: body.override_price }).returningAll().executeTakeFirstOrThrow();
    return reply.send(override);
  }));

  async function changeAvailability(request: FastifyRequest, reply: FastifyReply, forcedStatus: AvailabilityStatus) {
    const params = request.params as { locationId: string; productId: string }; const body = request.body as AvailabilityBody; const expected = parseIfMatch(request.headers['if-match'], true);
    return withSession(request, async (actor) => {
      requirePermission(actor, 'menu.availability.update');
      await requireActorLocation(actor, params.locationId);
      if (!await findOrganizationProduct(actor.trx, actor.organizationId, params.productId)) throw new IdentityHttpError(404, 'NOT_FOUND', 'Product was not found.');
      const status = forcedStatus === 'AVAILABLE' ? 'AVAILABLE' : body.status ?? forcedStatus;
      if (!['AVAILABLE', ...availabilityStatus].includes(status)) throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'Invalid availability status.');
      if (body.days_of_week && (body.days_of_week.length === 0 || body.days_of_week.some((day) => !Number.isInteger(day) || day < 1 || day > 7))) throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'days_of_week must contain ISO weekdays 1 through 7.');
      const schedule = dates(body);
      const all = await actor.trx.selectFrom('availability_rules').selectAll().where('location_id', '=', params.locationId).where('product_id', '=', params.productId).execute();
      const existing = body.rule_id ? all.find((rule) => rule.id === body.rule_id) : all.find((rule) => rule.channel_scope === (body.channel_scope ?? null) && rule.service_type_scope === (body.service_type_scope ?? null));
      if (!existing && expected !== 0) throw new IdentityHttpError(409, 'OPTIMISTIC_CONCURRENCY_CONFLICT', 'The resource has been modified since it was last read. Please refresh and try again.', { current_version: 0, current_state: null });
      if (existing && existing.version !== expected) throw new IdentityHttpError(409, 'OPTIMISTIC_CONCURRENCY_CONFLICT', 'The resource has been modified since it was last read. Please refresh and try again.', { current_version: existing.version, current_state: publicAvailability(existing) });
      const values = { status, channel_scope: optionalText(body.channel_scope) ?? null, service_type_scope: optionalText(body.service_type_scope) ?? null, days_of_week: body.days_of_week ?? null, ...schedule };
      const rule = existing
        ? await actor.trx.updateTable('availability_rules').set({ ...values, version: sql<number>`version + 1` }).where('id', '=', existing.id).returningAll().executeTakeFirstOrThrow()
        : await actor.trx.insertInto('availability_rules').values({ location_id: params.locationId, product_id: params.productId, ...values }).returningAll().executeTakeFirstOrThrow();
      return reply.send(publicAvailability(rule));
    });
  }

  app.post('/api/v1/locations/:locationId/products/:productId/mark-unavailable', { schema: { params: { type: 'object', additionalProperties: false, required: ['locationId', 'productId'], properties: { locationId: uuidSchema, productId: uuidSchema } }, headers: ifMatchHeader, body: { type: 'object', additionalProperties: false, properties: { rule_id: uuidSchema, status: { type: 'string', enum: availabilityStatus }, channel_scope: nullableString, service_type_scope: nullableString, days_of_week: { anyOf: [{ type: 'array', minItems: 1, items: { type: 'integer', minimum: 1, maximum: 7 } }, { type: 'null' }] }, start_time: { type: ['string', 'null'], format: 'date-time' }, end_time: { type: ['string', 'null'], format: 'date-time' } } } } }, async (request, reply) => changeAvailability(request, reply, 'EXHAUSTED'));
  app.post('/api/v1/locations/:locationId/products/:productId/mark-available', { schema: { params: { type: 'object', additionalProperties: false, required: ['locationId', 'productId'], properties: { locationId: uuidSchema, productId: uuidSchema } }, headers: ifMatchHeader, body: { type: 'object', additionalProperties: false, properties: { rule_id: uuidSchema, channel_scope: nullableString, service_type_scope: nullableString, days_of_week: { anyOf: [{ type: 'array', minItems: 1, items: { type: 'integer', minimum: 1, maximum: 7 } }, { type: 'null' }] }, start_time: { type: ['string', 'null'], format: 'date-time' }, end_time: { type: ['string', 'null'], format: 'date-time' } } } } }, async (request, reply) => changeAvailability(request, reply, 'AVAILABLE'));

  app.get('/api/v1/locations/:locationId/products/:productId/availability-rules', { schema: { params: { type: 'object', additionalProperties: false, required: ['locationId', 'productId'], properties: { locationId: uuidSchema, productId: uuidSchema } } } }, async (request) => withSession(request, async (actor) => {
    requirePermission(actor, 'menu.catalog.read');
    const params = request.params as { locationId: string; productId: string };
    await requireActorLocation(actor, params.locationId);
    if (!await findOrganizationProduct(actor.trx, actor.organizationId, params.productId)) throw new IdentityHttpError(404, 'NOT_FOUND', 'Product was not found.');
    const rules = await actor.trx.selectFrom('availability_rules').selectAll().where('location_id', '=', params.locationId).where('product_id', '=', params.productId).execute();
    return { data: rules.map(publicAvailability) };
  }));
};
