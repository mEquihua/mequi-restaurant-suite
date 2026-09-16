import { Kysely, PostgresDialect, sql, type Generated, type Transaction } from 'kysely';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';

export interface Database {
  organizations: OrganizationTable;
  locations: LocationTable;
  staff: StaffTable;
  roles: RoleTable;
  role_permissions: RolePermissionTable;
  staff_roles: StaffRoleTable;
  terminals: TerminalTable;
  staff_sessions: StaffSessionTable;
  terminal_pin_attempts: TerminalPinAttemptTable;
  categories: CategoryTable;
  products: ProductTable;
  product_variants: ProductVariantTable;
  modifier_groups: ModifierGroupTable;
  product_modifier_groups: ProductModifierGroupTable;
  modifiers: ModifierTable;
  product_combo_groups: ProductComboGroupTable;
  product_combo_items: ProductComboItemTable;
  location_price_overrides: LocationPriceOverrideTable;
  availability_rules: AvailabilityRuleTable;
}

export interface OrganizationTable {
  id: Generated<string>;
  name: string;
  is_single_org: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface LocationTable {
  id: Generated<string>;
  organization_id: string;
  name: string;
  address: string | null;
  timezone: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface StaffTable {
  id: Generated<string>;
  organization_id: string;
  first_name: string;
  last_name: string;
  active: Generated<boolean>;
  pin_hash: string;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface RoleTable {
  id: Generated<string>;
  organization_id: string;
  name: string;
  description: string | null;
  is_system_template: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface RolePermissionTable {
  role_id: string;
  permission_name: string;
  scope: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface StaffRoleTable {
  id: Generated<string>;
  staff_id: string;
  role_id: string;
  location_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface TerminalTable {
  id: Generated<string>;
  location_id: string;
  name: string;
  device_profile: string | null;
  is_active: Generated<boolean>;
  version: Generated<number>;
  credential_hash: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface StaffSessionTable {
  id: Generated<string>;
  staff_id: string;
  location_id: string;
  terminal_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  last_seen_at: Generated<Date>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface TerminalPinAttemptTable {
  terminal_id: string;
  credential_fingerprint: string;
  failure_count: Generated<number>;
  next_attempt_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface CategoryTable {
  id: Generated<string>;
  organization_id: string;
  name: string;
  description: string | null;
  display_order: Generated<number>;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface ProductTable {
  id: Generated<string>;
  organization_id: string;
  category_id: string | null;
  name: string;
  internal_name: string | null;
  description: string | null;
  photo_url: string | null;
  notes: string | null;
  allergens: Generated<string[]>;
  tags: Generated<string[]>;
  base_price: number;
  is_active: Generated<boolean>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface ProductVariantTable {
  id: Generated<string>;
  product_id: string;
  name: string;
  price_adjustment: Generated<number>;
  display_order: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface ModifierGroupTable {
  id: Generated<string>;
  organization_id: string;
  name: string;
  min_selections: Generated<number>;
  max_selections: number | null;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface ProductModifierGroupTable {
  product_id: string;
  modifier_group_id: string;
  display_order: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface ModifierTable {
  id: Generated<string>;
  modifier_group_id: string;
  name: string;
  price_adjustment: Generated<number>;
  display_order: Generated<number>;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface ProductComboGroupTable {
  id: Generated<string>;
  product_id: string;
  name: string;
  min_selections: Generated<number>;
  max_selections: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface ProductComboItemTable {
  id: Generated<string>;
  combo_group_id: string;
  product_id: string;
  price_adjustment: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface LocationPriceOverrideTable {
  location_id: string;
  product_id: string;
  override_price: number;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface AvailabilityRuleTable {
  id: Generated<string>;
  location_id: string;
  product_id: string;
  status: string;
  channel_scope: string | null;
  service_type_scope: string | null;
  days_of_week: number[] | null;
  start_time: Date | null;
  end_time: Date | null;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type DatabaseTransaction = Transaction<Database>;

declare module 'fastify' {
  interface FastifyInstance {
    db: Kysely<Database>;
    withLocationTransaction<T>(locationId: string, work: (trx: DatabaseTransaction) => Promise<T>): Promise<T>;
    withOrganizationTransaction<T>(organizationId: string, work: (trx: DatabaseTransaction) => Promise<T>): Promise<T>;
  }
}

export interface DatabaseOptions {
  databaseUrl?: string;
}

export function createDatabase(options: DatabaseOptions = {}): Kysely<Database> {
  const pool = new pg.Pool({ connectionString: options.databaseUrl ?? process.env.DATABASE_URL });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * Installs the shared data-access decorators. `set_config(..., true)` is PostgreSQL's
 * parameter-safe equivalent of `SET LOCAL`: its value is discarded at transaction end.
 */
export function installDatabase(app: FastifyInstance, options: DatabaseOptions = {}): void {
  const db = createDatabase(options);

  app.decorate('db', db);
  app.decorate('withLocationTransaction', async <T>(locationId: string, work: (trx: DatabaseTransaction) => Promise<T>) =>
    db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE application_runtime_role`.execute(trx);
      await sql`SELECT set_config('app.current_location_id', ${locationId}, true)`.execute(trx);
      return work(trx);
    }),
  );
  app.decorate('withOrganizationTransaction', async <T>(organizationId: string, work: (trx: DatabaseTransaction) => Promise<T>) =>
    db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE application_runtime_role`.execute(trx);
      await sql`SELECT set_config('app.current_organization_id', ${organizationId}, true)`.execute(trx);
      return work(trx);
    }),
  );
  app.addHook('onClose', async () => db.destroy());
}
