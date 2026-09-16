# Foundation Data Model

This document outlines the core PostgreSQL schema for the Foundation scope of Restaurant Suite. It implements the single-organization invariant, multi-location architecture, robust auditing, and state machines described in the functional specification and system architecture ADR.

## 1. Entity-Relationship Narrative

The system is rooted in a single `organizations` row. The organization contains multiple `locations`, and every operational record is strongly scoped to a `location_id`.

**Identity & Access**: `staff` and `roles` are organization-wide, allowing employees to operate across the business. However, `staff_roles` binds a person to a role at a specific `location_id` (or globally if null). Terminals are enrolled per location (`terminals`). When a staff member unlocks a terminal with their PIN, a short-lived `staff_sessions` record is created to track their operations securely.

**Menu & Catalog**: The core catalog (`categories`, `products`, `modifier_groups`, `modifiers`, `product_combo_groups`, `product_combo_items`) is shared globally. Each location manages its own reality through `location_price_overrides` and `availability_rules`, preventing the need to duplicate products for minor price or stock differences.

**Floor & Tables**: Physical layout is modeled via `areas`, `tables`, and `sections`. These belong exclusively to a `location_id` and track real-time occupancy.

**Operations (Visits, Orders, Accounts)**: A `visits` row represents a table's occupancy session. During a visit, an `accounts` record manages the financial totals and payments. An `orders` aggregate tracks the overarching fulfillment lifecycle, containing multiple `order_lines`. Order lines carry the precise `seat_number` and `course_name`, evolving independently through states (Held -> Sent -> Preparing -> Ready -> Fulfilled). 

**Audit & Delivery**: Every transactional boundary that produces side effects writes an `outbox_events` record in the same commit. Sensitive operations (voids, cancellations, refunds) write immutable `audit_events`.

---

## 2. Table Definitions & Constraints

*Note: All primary keys default to `gen_random_uuid()`. Money is represented as `INTEGER` cents. All tables include `created_at` (TIMESTAMPTZ DEFAULT NOW()) and `updated_at` (TIMESTAMPTZ DEFAULT NOW()).*

### 2.1 Organization & Locations

**`organizations`**
- `id` UUID PK
- `name` VARCHAR NOT NULL
- `is_single_org` BOOLEAN NOT NULL DEFAULT TRUE
- *Constraints*: `CHECK (is_single_org IS TRUE)`, `UNIQUE (is_single_org)` (Ensures exactly one row).

**`locations`**
- `id` UUID PK
- `organization_id` UUID NOT NULL
- `name` VARCHAR NOT NULL
- `address` TEXT
- `timezone` VARCHAR NOT NULL DEFAULT 'UTC'
- *Constraints*: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`.

**`location_operating_config`**
- `location_id` UUID PK *(Location Scoping Column)*
- `config_json` JSONB NOT NULL DEFAULT '{}'
- *Constraints*: `FOREIGN KEY (location_id) REFERENCES locations(id)`.

### 2.2 Identity

**`staff`**
- `id` UUID PK
- `organization_id` UUID NOT NULL
- `first_name` VARCHAR NOT NULL
- `last_name` VARCHAR NOT NULL
- `active` BOOLEAN NOT NULL DEFAULT TRUE
- `pin_hash` VARCHAR NOT NULL *(Argon2id hash reference)*
- `version` INTEGER NOT NULL DEFAULT 1
- *Constraints*: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`.

**`roles`**
- `id` UUID PK
- `organization_id` UUID NOT NULL
- `name` VARCHAR NOT NULL
- `description` TEXT
- `is_system_template` BOOLEAN NOT NULL DEFAULT FALSE
- *Constraints*: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`.

**`role_permissions`**
- `role_id` UUID NOT NULL
- `permission_name` VARCHAR NOT NULL
- `scope` VARCHAR NOT NULL
- *Constraints*: `PRIMARY KEY (role_id, permission_name)`, `FOREIGN KEY (role_id) REFERENCES roles(id)`.

**`staff_roles`**
- `staff_id` UUID NOT NULL
- `role_id` UUID NOT NULL
- `location_id` UUID *(Location Scoping Column)*
- *Constraints*: `PRIMARY KEY (staff_id, role_id, location_id)`, `FOREIGN KEY (staff_id) REFERENCES staff(id)`, `FOREIGN KEY (role_id) REFERENCES roles(id)`, `FOREIGN KEY (location_id) REFERENCES locations(id)`. Null location implies organization-wide grant.

**`terminals`**
- `id` UUID PK
- `location_id` UUID NOT NULL *(Location Scoping Column)*
- `name` VARCHAR NOT NULL
- `device_profile` VARCHAR
- `is_active` BOOLEAN NOT NULL DEFAULT TRUE
- `version` INTEGER NOT NULL DEFAULT 1
- *Constraints*: `FOREIGN KEY (location_id) REFERENCES locations(id)`.

**`staff_sessions`**
- `id` UUID PK
- `staff_id` UUID NOT NULL
- `location_id` UUID NOT NULL *(Location Scoping Column)*
- `terminal_id` UUID NOT NULL
- `token_hash` VARCHAR NOT NULL
- `expires_at` TIMESTAMPTZ NOT NULL
- *Constraints*: `FOREIGN KEY (staff_id) REFERENCES staff(id)`, `FOREIGN KEY (location_id) REFERENCES locations(id)`, `FOREIGN KEY (terminal_id) REFERENCES terminals(id)`.

### 2.3 Menu & Catalog

**`categories`**
- `id` UUID PK
- `organization_id` UUID NOT NULL
- `name` VARCHAR NOT NULL
- `description` TEXT
- `display_order` INTEGER NOT NULL DEFAULT 0
- `is_active` BOOLEAN NOT NULL DEFAULT TRUE
- *Constraints*: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`.

**`products`**
- `id` UUID PK
- `organization_id` UUID NOT NULL
- `category_id` UUID
- `name` VARCHAR NOT NULL
- `internal_name` VARCHAR
- `description` TEXT
- `photo_url` TEXT *(nullable; idea.md section 12 — customer-facing photo)*
- `notes` TEXT *(nullable; kitchen/prep notes, distinct from the customer-facing description)*
- `allergens` TEXT[] NOT NULL DEFAULT '{}' *(idea.md section 12 — declared allergens)*
- `tags` TEXT[] NOT NULL DEFAULT '{}' *(idea.md section 12 — free-form labels)*
- `base_price` INTEGER NOT NULL *(cents)*
- `is_active` BOOLEAN NOT NULL DEFAULT TRUE
- `version` INTEGER NOT NULL DEFAULT 1
- *Constraints*: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`, `FOREIGN KEY (category_id) REFERENCES categories(id)`.

*Deferred (idea.md section 12, not Foundation): related products / upsell suggestions — idea.md itself treats these as a later, optional recommendation feature ("no necesitamos inicialmente un motor de recomendación inteligente"), so they are out of scope until a later module.*

**`product_variants`**
- `id` UUID PK
- `product_id` UUID NOT NULL
- `name` VARCHAR NOT NULL
- `price_adjustment` INTEGER NOT NULL DEFAULT 0 *(cents)*
- `display_order` INTEGER NOT NULL DEFAULT 0
- *Constraints*: `FOREIGN KEY (product_id) REFERENCES products(id)`.

**`modifier_groups`**
- `id` UUID PK
- `organization_id` UUID NOT NULL
- `name` VARCHAR NOT NULL
- `min_selections` INTEGER NOT NULL DEFAULT 0
- `max_selections` INTEGER
- `is_active` BOOLEAN NOT NULL DEFAULT TRUE
- *Constraints*: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`.

**`product_modifier_groups`**
- `product_id` UUID NOT NULL
- `modifier_group_id` UUID NOT NULL
- `display_order` INTEGER NOT NULL DEFAULT 0
- *Constraints*: `PRIMARY KEY (product_id, modifier_group_id)`, `FOREIGN KEY (product_id) REFERENCES products(id)`, `FOREIGN KEY (modifier_group_id) REFERENCES modifier_groups(id)`.

**`modifiers`**
- `id` UUID PK
- `modifier_group_id` UUID NOT NULL
- `name` VARCHAR NOT NULL
- `price_adjustment` INTEGER NOT NULL DEFAULT 0 *(cents)*
- `display_order` INTEGER NOT NULL DEFAULT 0
- `is_active` BOOLEAN NOT NULL DEFAULT TRUE
- *Constraints*: `FOREIGN KEY (modifier_group_id) REFERENCES modifier_groups(id)`.

**`product_combo_groups`**
- `id` UUID PK
- `product_id` UUID NOT NULL *(Parent combo product)*
- `name` VARCHAR NOT NULL
- `min_selections` INTEGER NOT NULL DEFAULT 1
- `max_selections` INTEGER NOT NULL DEFAULT 1
- *Constraints*: `FOREIGN KEY (product_id) REFERENCES products(id)`.

**`product_combo_items`**
- `id` UUID PK
- `combo_group_id` UUID NOT NULL
- `product_id` UUID NOT NULL *(Option product)*
- `price_adjustment` INTEGER NOT NULL DEFAULT 0 *(cents)*
- *Constraints*: `FOREIGN KEY (combo_group_id) REFERENCES product_combo_groups(id)`, `FOREIGN KEY (product_id) REFERENCES products(id)`.

**`location_price_overrides`**
- `location_id` UUID NOT NULL *(Location Scoping Column)*
- `product_id` UUID NOT NULL
- `override_price` INTEGER NOT NULL *(cents)*
- `version` INTEGER NOT NULL DEFAULT 1
- *Constraints*: `PRIMARY KEY (location_id, product_id)`, `FOREIGN KEY (location_id) REFERENCES locations(id)`, `FOREIGN KEY (product_id) REFERENCES products(id)`.

**`availability_rules`**
- `id` UUID PK
- `location_id` UUID NOT NULL *(Location Scoping Column)*
- `product_id` UUID NOT NULL
- `status` VARCHAR NOT NULL
- `channel_scope` VARCHAR
- `service_type_scope` VARCHAR
- `days_of_week` SMALLINT[] *(nullable; ISO 8601 weekday numbers 1=Monday..7=Sunday; NULL means every day — idea.md section 13 "disponible durante determinados días")*
- `start_time` TIMESTAMPTZ
- `end_time` TIMESTAMPTZ
- `version` INTEGER NOT NULL DEFAULT 1
- *Constraints*: `FOREIGN KEY (location_id) REFERENCES locations(id)`, `FOREIGN KEY (product_id) REFERENCES products(id)`, `CHECK (status IN ('AVAILABLE', 'EXHAUSTED', 'HIDDEN', 'SCHEDULED'))`, `CHECK (days_of_week IS NULL OR days_of_week <@ ARRAY[1,2,3,4,5,6,7]::smallint[])`.

*Note on "available until stock runs out" (idea.md section 13): Foundation has no inventory-quantity tracking yet, so this dimension is handled operationally — staff/kitchen set `status = 'EXHAUSTED'` when stock depletes (see the Kitchen module's out-of-stock reporting). A dedicated stock-quantity-driven auto-transition is deferred to the Inventory module.*

### 2.4 Floor & Tables

**`areas`**
- `id` UUID PK
- `location_id` UUID NOT NULL *(Location Scoping Column)*
- `name` VARCHAR NOT NULL
- *Constraints*: `FOREIGN KEY (location_id) REFERENCES locations(id)`.

**`tables`**
- `id` UUID PK
- `location_id` UUID NOT NULL *(Location Scoping Column)*
- `area_id` UUID NOT NULL
- `name` VARCHAR NOT NULL
- `min_capacity` INTEGER NOT NULL DEFAULT 1
- `max_capacity` INTEGER NOT NULL
- `pos_x` INTEGER NOT NULL DEFAULT 0
- `pos_y` INTEGER NOT NULL DEFAULT 0
- `status` VARCHAR NOT NULL DEFAULT 'AVAILABLE'
- `version` INTEGER NOT NULL DEFAULT 1
- *Constraints*: `FOREIGN KEY (location_id) REFERENCES locations(id)`, `FOREIGN KEY (area_id) REFERENCES areas(id)`.

**`sections`**
- `id` UUID PK
- `location_id` UUID NOT NULL *(Location Scoping Column)*
- `name` VARCHAR NOT NULL
- *Constraints*: `FOREIGN KEY (location_id) REFERENCES locations(id)`.

**`table_sections`**
- `table_id` UUID NOT NULL
- `section_id` UUID NOT NULL
- *Constraints*: `PRIMARY KEY (table_id, section_id)`, `FOREIGN KEY (table_id) REFERENCES tables(id)`, `FOREIGN KEY (section_id) REFERENCES sections(id)`.

### 2.5 Orders, Visits, and Accounts

**`visits`**
- `id` UUID PK
- `location_id` UUID NOT NULL *(Location Scoping Column)*
- `table_id` UUID
- `staff_id` UUID
- `guest_count` INTEGER
- `status` VARCHAR NOT NULL DEFAULT 'OPEN'
- `opened_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()
- `closed_at` TIMESTAMPTZ
- `version` INTEGER NOT NULL DEFAULT 1
- *Constraints*: `FOREIGN KEY (location_id) REFERENCES locations(id)`, `FOREIGN KEY (table_id) REFERENCES tables(id)`, `FOREIGN KEY (staff_id) REFERENCES staff(id)`.

**`accounts`**
- `id` UUID PK
- `location_id` UUID NOT NULL *(Location Scoping Column)*
- `visit_id` UUID NOT NULL
- `name` VARCHAR
- `status` VARCHAR NOT NULL DEFAULT 'OPEN'
- `subtotal` INTEGER NOT NULL DEFAULT 0
- `tax` INTEGER NOT NULL DEFAULT 0
- `discount` INTEGER NOT NULL DEFAULT 0
- `total` INTEGER NOT NULL DEFAULT 0
- `paid_amount` INTEGER NOT NULL DEFAULT 0
- `version` INTEGER NOT NULL DEFAULT 1
- *Constraints*: `FOREIGN KEY (location_id) REFERENCES locations(id)`, `FOREIGN KEY (visit_id) REFERENCES visits(id)`, `CHECK (subtotal >= 0)`, `CHECK (tax >= 0)`, `CHECK (total >= 0)`, `CHECK (paid_amount >= 0)`.

**`orders`**
- `id` UUID PK
- `location_id` UUID NOT NULL *(Location Scoping Column)*
- `visit_id` UUID NOT NULL
- `order_type` VARCHAR NOT NULL
- `status` VARCHAR NOT NULL DEFAULT 'DRAFT'
- `version` INTEGER NOT NULL DEFAULT 1
- *Constraints*: `FOREIGN KEY (location_id) REFERENCES locations(id)`, `FOREIGN KEY (visit_id) REFERENCES visits(id)`.

**`order_lines`**
- `id` UUID PK
- `location_id` UUID NOT NULL *(Location Scoping Column)*
- `order_id` UUID NOT NULL
- `account_id` UUID NOT NULL
- `product_id` UUID NOT NULL
- `variant_id` UUID
- `seat_number` INTEGER
- `course_name` VARCHAR
- `quantity` INTEGER NOT NULL DEFAULT 1
- `unit_price` INTEGER NOT NULL *(cents)*
- `status` VARCHAR NOT NULL DEFAULT 'DRAFT'
- `version` INTEGER NOT NULL DEFAULT 1
- *Constraints*: `FOREIGN KEY (location_id) REFERENCES locations(id)`, `FOREIGN KEY (order_id) REFERENCES orders(id)`, `FOREIGN KEY (account_id) REFERENCES accounts(id)`, `FOREIGN KEY (product_id) REFERENCES products(id)`, `FOREIGN KEY (variant_id) REFERENCES product_variants(id)`.

**`order_line_modifiers`**
- `id` UUID PK
- `location_id` UUID NOT NULL *(Location Scoping Column)*
- `order_line_id` UUID NOT NULL
- `modifier_id` UUID NOT NULL
- `unit_price` INTEGER NOT NULL *(cents)*
- *Constraints*: `FOREIGN KEY (location_id) REFERENCES locations(id)`, `FOREIGN KEY (order_line_id) REFERENCES order_lines(id)`, `FOREIGN KEY (modifier_id) REFERENCES modifiers(id)`.

**`payments`**
- `id` UUID PK
- `location_id` UUID NOT NULL *(Location Scoping Column)*
- `account_id` UUID NOT NULL
- `method` VARCHAR NOT NULL
- `amount` INTEGER NOT NULL *(cents)*
- `tip_amount` INTEGER NOT NULL DEFAULT 0 *(cents)*
- `status` VARCHAR NOT NULL
- `reference_code` VARCHAR
- `idempotency_key` VARCHAR
- `version` INTEGER NOT NULL DEFAULT 1
- *Constraints*: `FOREIGN KEY (location_id) REFERENCES locations(id)`, `FOREIGN KEY (account_id) REFERENCES accounts(id)`, `UNIQUE (idempotency_key)`, `CHECK (amount >= 0)`.

**`cancellations_and_voids`**
- `id` UUID PK
- `location_id` UUID NOT NULL *(Location Scoping Column)*
- `order_line_id` UUID NOT NULL
- `operation_type` VARCHAR NOT NULL
- `amount` INTEGER NOT NULL
- `reason` VARCHAR NOT NULL
- `authorized_by` UUID NOT NULL
- *Constraints*: `FOREIGN KEY (location_id) REFERENCES locations(id)`, `FOREIGN KEY (order_line_id) REFERENCES order_lines(id)`, `FOREIGN KEY (authorized_by) REFERENCES staff(id)`, `CHECK (operation_type IN ('VOID', 'CANCEL'))`.

**`refunds`**
- `id` UUID PK
- `location_id` UUID NOT NULL *(Location Scoping Column)*
- `payment_id` UUID NOT NULL
- `amount` INTEGER NOT NULL
- `reason` VARCHAR NOT NULL
- `authorized_by` UUID NOT NULL
- *Constraints*: `FOREIGN KEY (location_id) REFERENCES locations(id)`, `FOREIGN KEY (payment_id) REFERENCES payments(id)`, `FOREIGN KEY (authorized_by) REFERENCES staff(id)`.

### 2.6 Outbox and Audit

**`outbox_events`**
- `id` UUID PK
- `location_id` UUID NOT NULL *(Location Scoping Column)*
- `aggregate_type` VARCHAR NOT NULL
- `aggregate_id` UUID NOT NULL
- `event_type` VARCHAR NOT NULL
- `payload` JSONB NOT NULL
- `schema_version` INTEGER NOT NULL
- `created_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()
- `dispatched_at` TIMESTAMPTZ
- *Constraints*: `FOREIGN KEY (location_id) REFERENCES locations(id)`.

**`audit_events`**
- `id` UUID PK
- `location_id` UUID NOT NULL *(Location Scoping Column)*
- `actor_id` UUID NOT NULL
- `terminal_id` UUID NOT NULL
- `action` VARCHAR NOT NULL
- `aggregate_type` VARCHAR NOT NULL
- `aggregate_id` UUID NOT NULL
- `before_version` INTEGER
- `after_version` INTEGER
- `reason` VARCHAR
- `request_id` VARCHAR NOT NULL
- `created_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()
- *Constraints*: `FOREIGN KEY (location_id) REFERENCES locations(id)`.

---

## 3. Explicit State Machines

The following check constraints enforce valid transition states directly in the schema, mirroring the specification rules exactly.

**Table Status**
```sql
ALTER TABLE tables ADD CONSTRAINT chk_table_status 
  CHECK (status IN ('AVAILABLE', 'OCCUPIED', 'NEEDS_CLEANING', 'OUT_OF_ORDER'));
```

**Visit Status**
```sql
ALTER TABLE visits ADD CONSTRAINT chk_visit_status 
  CHECK (status IN ('OPEN', 'COMPLETED', 'CANCELLED'));
```

**Order Status**
```sql
ALTER TABLE orders ADD CONSTRAINT chk_order_status 
  CHECK (status IN ('DRAFT', 'CONFIRMED', 'HELD', 'SENT', 'PREPARING', 'READY', 'FULFILLED', 'COMPLETED', 'CANCELLED', 'REJECTED'));
```

**Order Line Status**
```sql
ALTER TABLE order_lines ADD CONSTRAINT chk_order_line_status 
  CHECK (status IN ('DRAFT', 'CONFIRMED', 'HELD', 'SENT', 'PREPARING', 'READY', 'FULFILLED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'VOIDED'));
```

**Account Status**
```sql
ALTER TABLE accounts ADD CONSTRAINT chk_account_status 
  CHECK (status IN ('OPEN', 'PARTIALLY_PAID', 'PAID', 'CLOSED', 'REFUNDED'));
```

---

## 4. Concurrency & Audit Strategy

**Optimistic Concurrency (Mutatable)**
The following operational aggregates include a `version` column. Client commands MUST supply the `If-Match` version they are acting upon; updates increment the version and fail `WHERE id = $id AND version = $expectedVersion`, yielding a `409 Conflict`.
- `staff`, `terminals`
- `products`, `location_price_overrides`, `availability_rules`
- `tables`, `visits`, `accounts`, `orders`, `order_lines`, `payments`

**Append-Only Logs (Immutable)**
The following tables are append-only. They never carry a `version` and must never be updated (excepting the `outbox_events.dispatched_at` internal mechanism):
- `cancellations_and_voids`
- `refunds`
- `outbox_events`
- `audit_events`
- `staff_sessions` (sessions expire naturally, revocation can be soft-delete or separate blacklist, but records shouldn't mutate deeply).

---

## 5. Row-Level Security (RLS) Structure

PostgreSQL RLS provides defense-in-depth against accidental data leakage across locations. Because a database connection handles multiple requests, the API sets the location scope dynamically in every transaction block.

```sql
-- Executed per location-scoped table
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- Creates a restrictive policy bound to a custom GUC variable set by the API
CREATE POLICY location_isolation_policy ON orders
  AS RESTRICTIVE
  FOR ALL
  TO application_runtime_role
  USING (location_id = current_setting('app.current_location_id', true)::UUID);
```

*Note: The API must execute `SET LOCAL app.current_location_id = 'xxx'` immediately upon acquiring a connection from the pool, after resolving policy authorization. Shared definition tables (`products`, `organizations`) do not use this RLS rule.*

---

## 6. Out of Scope

To prevent scope creep, the following domains are deliberately **NOT MODELED** in this Foundation schema. They will be handled in subsequent packages:
- **Inventory & Recipes**: No raw ingredients, stock counts, receiving, waste tracking, or bill-of-materials mappings.
- **Reservations**: No reservation schedules, waitlists, table allocations, or customer deposits.
- **Loyalty & Customer Profiles**: No customer database, points, tiers, or historical purchase clustering.
- **Self-Service & Kiosks**: No explicit device pairings or layout configurations specifically tailored for Kiosk/QR/Table-ordering contexts beyond base menu and terminal.
- **Delivery Management**: No driver dispatching, zone boundaries, external aggregator channel mappings, or delivery specific tracking states.
