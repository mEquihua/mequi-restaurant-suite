import { Kysely, PostgresDialect, sql, type Generated, type Transaction } from 'kysely';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';


export interface CustomerTable {
  id: Generated<string>;
  organization_id: string;
  email: string;
  password_hash: string;
  name: string;
  phone: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CustomerSessionTable {
  id: Generated<string>;
  organization_id: string;
  customer_id: string;
  token_hash: string;
  created_at: Generated<Date>;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface DeliveryZoneTable {
  id: Generated<string>;
  location_id: string;
  name: string;
  fee: number;
  minimum_order_amount: Generated<number>;
  active: Generated<boolean>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OrderFulfillmentTable {
  id: Generated<string>;
  location_id: string;
  order_id: string;
  fulfillment_type: 'PICKUP' | 'DELIVERY';
  status: Generated<'PENDING' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'CANCELLED'>;
  scheduled_for: Date | null;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  delivery_address: unknown | null;
  delivery_driver_name: string | null;
  guest_token_hash: string | null;
  delivery_zone_id: string | null;
  delivery_fee: Generated<number>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}


export interface TimeclockShiftTable {
  id: Generated<string>;
  location_id: string;
  staff_id: string;
  status: 'OPEN' | 'CLOSED';
  clocked_in_at: Generated<Date>;
  clocked_out_at: Date | null;
  clocked_in_by_staff_id: string;
  clocked_out_by_staff_id: string | null;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ScheduledOrderSettingsTable {
  id: Generated<string>;
  location_id: string;
  accepts_scheduled_orders: Generated<boolean>;
  minimum_lead_time_minutes: Generated<number>;
  maximum_lead_time_days: Generated<number>;
  operating_hours: Generated<unknown>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface Database {
  scheduled_order_settings: ScheduledOrderSettingsTable;
  timeclock_shifts: TimeclockShiftTable;
  customers: CustomerTable;
  customer_sessions: CustomerSessionTable;
  delivery_zones: DeliveryZoneTable;
  order_fulfillments: OrderFulfillmentTable;
  organizations: OrganizationTable;
  locations: LocationTable;
  staff: StaffTable;
  roles: RoleTable;
  role_permissions: RolePermissionTable;
  staff_roles: StaffRoleTable;
  terminals: TerminalTable;
  staff_sessions: StaffSessionTable;
  guest_sessions: GuestSessionTable;
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
  areas: AreaTable;
  tables: DiningTableTable;
  sections: SectionTable;
  table_sections: TableSectionTable;
  module_definitions: ModuleDefinitionTable;
  module_activations: ModuleActivationTable;
  table_service_requests: TableServiceRequestTable;
  visits: VisitTable;
  accounts: AccountTable;
  orders: OrderTable;
  order_lines: OrderLineTable;
  order_line_modifiers: OrderLineModifierTable;
  payments: PaymentTable;
  account_discounts: AccountDiscountTable;
  cancellations_and_voids: CancellationAndVoidTable;
  cash_drawer_sessions: CashDrawerSessionTable;
  cash_drawer_movements: CashDrawerMovementTable;
  refunds: RefundTable;
  outbox_events: OutboxEventTable;
  audit_events: AuditEventTable;
  command_idempotency: CommandIdempotencyTable;
  ingredients: IngredientTable;
  ingredient_stock: IngredientStockTable;
  recipe_lines: RecipeLineTable;
  stock_adjustments: StockAdjustmentTable;
  reservations: ReservationTable;
  reservation_settings: ReservationSettingsTable;
  loyalty_settings: LoyaltySettingsTable;
  loyalty_accounts: LoyaltyAccountTable;
  loyalty_rewards: LoyaltyRewardTable;
  loyalty_coupons: LoyaltyCouponTable;
  loyalty_transactions: LoyaltyTransactionTable;
  loyalty_redemptions: LoyaltyRedemptionTable;
  promotions: PromotionTable;
  order_line_promotions: OrderLinePromotionTable;

}

export type TableName = keyof Database;

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
  app_target: 'KITCHEN' | 'SELF_SERVICE' | 'STAFF' | null;
  profile_config: unknown | null;
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
export interface GuestSessionTable {
  id: Generated<string>;
  location_id: string;
  visit_id: string;
  table_id: string | null;
  token_hash: string;
  device_info: string | null;
  created_at: Generated<Date>;
  expires_at: Date;
  revoked_at: Date | null;
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
  version: Generated<number>;
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
export interface AreaTable {
  id: Generated<string>;
  location_id: string;
  name: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface DiningTableTable {
  id: Generated<string>;
  location_id: string;
  area_id: string;
  name: string;
  min_capacity: Generated<number>;
  max_capacity: number;
  pos_x: Generated<number>;
  pos_y: Generated<number>;
  status: Generated<string>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface SectionTable {
  id: Generated<string>;
  location_id: string;
  name: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface TableSectionTable {
  table_id: string;
  section_id: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface ModuleDefinitionTable {
  key: string;
  display_name: string;
  description: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface ModuleActivationTable {
  location_id: string;
  module_key: string;
  status: string;
  attention_reason: string | null;
  guest_payment_mode: Generated<'ORDER_ONLY' | 'REQUEST_BILL' | 'ORDER_AND_PAY'>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface TableServiceRequestTable {
  id: Generated<string>;
  location_id: string;
  visit_id: string;
  table_id: string;
  request_type: 'CALL_WAITER' | 'REQUEST_BILL' | 'NEED_WATER' | 'NEED_UTENSILS';
  status: Generated<'PENDING' | 'RESOLVED'>;
  created_at: Generated<Date>;
  resolved_at: Date | null;
  resolved_by_staff_id: string | null;
}
export interface VisitTable {
  id: Generated<string>;
  location_id: string;
  table_id: string | null;
  customer_id: string | null;
  staff_id: string | null;
  guest_count: number | null;
  status: Generated<string>;
  opened_at: Generated<Date>;
  closed_at: Date | null;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface AccountTable {
  id: Generated<string>;
  location_id: string;
  visit_id: string;
  name: string | null;
  status: Generated<string>;
  subtotal: Generated<number>;
  tax: Generated<number>;
  discount: Generated<number>;
  total: Generated<number>;
  paid_amount: Generated<number>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface OrderTable {
  id: Generated<string>;
  location_id: string;
  visit_id: string;
  order_type: string;
  status: Generated<string>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface OrderLineTable {
  id: Generated<string>;
  location_id: string;
  order_id: string;
  account_id: string;
  product_id: string;
  variant_id: string | null;
  seat_number: number | null;
  course_name: string | null;
  quantity: number;
  unit_price: number;
  status: Generated<string>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface OrderLineModifierTable {
  id: Generated<string>;
  location_id: string;
  order_line_id: string;
  modifier_id: string;
  unit_price: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface PaymentTable {
  id: Generated<string>;
  location_id: string;
  account_id: string;
  method: string;
  amount: number;
  tip_amount: Generated<number>;
  status: string;
  reference_code: string | null;
  idempotency_key: string | null;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface AccountDiscountTable {
  id: Generated<string>;
  location_id: string;
  account_id: string;
  order_line_id: string | null;
  discount_type: 'PERCENTAGE' | 'AMOUNT';
  value: number;
  computed_amount: number;
  reason: string;
  applied_by: string | null;
  is_override: boolean;
  created_at: Generated<Date>;
}
export interface CancellationAndVoidTable {
  id: Generated<string>;
  location_id: string;
  order_line_id: string;
  operation_type: string;
  amount: number;
  reason: string;
  authorized_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface RefundTable {
  id: Generated<string>;
  location_id: string;
  payment_id: string;
  amount: number;
  reason: string;
  authorized_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface OutboxEventTable {
  id: Generated<string>;
  location_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  schema_version: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  dispatched_at: Date | null;
}
export interface AuditEventTable {
  id: Generated<string>;
  location_id: string;
  actor_id: string;
  terminal_id: string;
  action: string;
  aggregate_type: string;
  aggregate_id: string;
  before_version: number | null;
  after_version: number | null;
  reason: string | null;
  request_id: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface CommandIdempotencyTable {
  location_id: string;
  command: string;
  idempotency_key: string;
  payload_hash: string;
  response: unknown;
  created_at: Generated<Date>;
}

export interface IngredientTable {
  id: Generated<string>;
  organization_id: string;
  name: string;
  unit_of_measure: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface IngredientStockTable {
  id: Generated<string>;
  location_id: string;
  ingredient_id: string;
  quantity_on_hand: Generated<string>;
  low_stock_threshold: string | null;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RecipeLineTable {
  id: Generated<string>;
  organization_id: string;
  product_id: string | null;
  variant_id: string | null;
  modifier_id: string | null;
  ingredient_id: string;
  quantity_per_unit: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface StockAdjustmentTable {
  id: Generated<string>;
  location_id: string;
  ingredient_id: string;
  staff_id: string;
  quantity_delta: string;
  reason: string;
  created_at: Generated<Date>;
}

export interface ReservationTable {
  id: Generated<string>;
  location_id: string;
  customer_id: string | null;
  party_size: number;
  requested_at: Generated<Date>;
  reservation_time: Date;
  status: string;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  special_requests: string | null;
  visit_id: string | null;
  guest_token_hash: string | null;
  confirmed_by_staff_id: string | null;
  cancelled_by_staff_id: string | null;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ReservationSettingsTable {
  id: Generated<string>;
  location_id: string;
  accepts_reservations: Generated<boolean>;
  operating_hours: Generated<unknown>;
  estimated_visit_duration_minutes: Generated<number>;
  minimum_lead_time_minutes: Generated<number>;
  maximum_party_size: Generated<number>;
  auto_confirm: Generated<boolean>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}


export interface LoyaltySettingsTable {
  id: Generated<string>;
  organization_id: string;
  spend_amount_for_one_point: Generated<number>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LoyaltyAccountTable {
  id: Generated<string>;
  organization_id: string;
  customer_id: string;
  points_balance: Generated<number>;
  total_visits: Generated<number>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LoyaltyRewardTable {
  id: Generated<string>;
  organization_id: string;
  name: string;
  description: string | null;
  cost_in_points: number | null;
  cost_in_visits: number | null;
  discount_type: 'PERCENTAGE' | 'AMOUNT';
  discount_value: number;
  is_active: Generated<boolean>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LoyaltyCouponTable {
  id: Generated<string>;
  organization_id: string;
  code: string;
  discount_type: 'PERCENTAGE' | 'AMOUNT';
  discount_value: number;
  is_active: Generated<boolean>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LoyaltyTransactionTable {
  id: Generated<string>;
  organization_id: string;
  loyalty_account_id: string;
  transaction_type: string;
  points_delta: number;
  visit_count_delta: number;
  reason: string;
  reference_visit_id: string | null;
  created_at: Generated<Date>;
}

export interface LoyaltyRedemptionTable {
  id: Generated<string>;
  organization_id: string;
  loyalty_account_id: string | null;
  reward_id: string | null;
  coupon_id: string | null;
  account_discount_id: string;
  created_at: Generated<Date>;
}

export type DatabaseTransaction = Transaction<Database>;

declare module 'fastify' {
  interface FastifyInstance {
    db: Kysely<Database>;
    withLocationTransaction<T>(
      locationId: string,
      work: (trx: DatabaseTransaction) => Promise<T>,
    ): Promise<T>;
    withOrganizationTransaction<T>(
      organizationId: string,
      work: (trx: DatabaseTransaction) => Promise<T>,
    ): Promise<T>;
  }
}

export interface DatabaseOptions {
  databaseUrl?: string;
}

export interface CashDrawerSessionTable {
  id: Generated<string>;
  location_id: string;
  terminal_id: string;
  opened_by: string;
  opening_float: number;
  status: string;
  opened_at: Generated<Date>;
  closed_by: string | null;
  closed_at: Date | null;
  counted_amount: number | null;
  expected_amount: number | null;
  variance: number | null;
  version: Generated<number>;
}
export interface CashDrawerMovementTable {
  id: Generated<string>;
  location_id: string;
  drawer_session_id: string;
  movement_type: string;
  amount: number;
  reason: string;
  recorded_by: string;
  created_at: Generated<Date>;
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
  app.decorate(
    'withLocationTransaction',
    async <T>(locationId: string, work: (trx: DatabaseTransaction) => Promise<T>) =>
      db.transaction().execute(async (trx) => {
        await sql`SET LOCAL ROLE application_runtime_role`.execute(trx);
        await sql`SELECT set_config('app.current_location_id', ${locationId}, true)`.execute(trx);
        return work(trx);
      }),
  );
  app.decorate(
    'withOrganizationTransaction',
    async <T>(organizationId: string, work: (trx: DatabaseTransaction) => Promise<T>) =>
      db.transaction().execute(async (trx) => {
        await sql`SET LOCAL ROLE application_runtime_role`.execute(trx);
        await sql`SELECT set_config('app.current_organization_id', ${organizationId}, true)`.execute(
          trx,
        );
        return work(trx);
      }),
  );
  app.addHook('onClose', async () => db.destroy());
}

export interface PromotionTable {
  id: Generated<string>;
  organization_id: string;
  name: string;
  description: string | null;
  discount_type: 'PERCENTAGE' | 'AMOUNT';
  discount_value: number;
  category_id: string | null;
  product_id: string | null;
  is_active: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
  days_of_week: number[] | null;
  start_time: string | null;
  end_time: string | null;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OrderLinePromotionTable {
  id: Generated<string>;
  location_id: string;
  order_line_id: string;
  promotion_id: string;
  computed_amount: number;
  created_at: Generated<Date>;
}
