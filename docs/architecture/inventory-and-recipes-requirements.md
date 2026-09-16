# Inventory and Recipes Requirements

This document is the precise, implementation-ready requirements reference for the "Inventory & Recipes" backend capability within Restaurant Suite. It translates the product requirements from `idea.md` (specifically regarding theoretical consumption and multi-location variance) into concrete mechanics, extending the existing Menu and Orders data models.

## 1. Core Mechanics

This is a lightweight theoretical-inventory module designed to answer "how much should we have left?" and "what are we running low on?" It is deliberately not a full Enterprise Resource Planning (ERP) system. 

### 1.1 Organizational vs. Location Scoping
Per `idea.md` section 29, the business definitions of recipes and ingredients can be shared across the organization, while the actual physical stock counts vary per location. To satisfy relational database constraints (so a shared recipe can link to a valid ingredient), the concept of an "ingredient" is split:
* **Catalog (`ingredients`)**: Organization-scoped. Defines the name and unit of measure (e.g., "Flour", "kg").
* **Stock (`ingredient_stock`)**: Location-scoped. Tracks the on-hand quantity and low-stock threshold for a specific location.

### 1.2 Recipe Resolution
A recipe maps a catalog product (and optionally a specific variant or modifier) to the ingredients and quantities it consumes. When an order line is sold, the system queries `recipe_lines` matching the line's `product_id`, `variant_id`, and `modifier_id`(s) to compute the total theoretical consumption.

## 2. Consumption Mechanics

### 2.1 Trigger Point: Transition to `SENT`
Ingredient stock is decremented at the exact moment an `order_lines` row transitions to the `SENT` state (or bypasses it directly to a later state like `FULFILLED`). 

**Justification**: The `SENT` state represents the moment the ticket appears on the Kitchen Display System (`PREPARING` follows shortly after). From an inventory perspective, this is when the physical ingredients are removed from the shelves and committed to the dish.

### 2.2 Voids and Cancellations
If an order line is `VOIDED` or `CANCELLED` *after* it has been `SENT` (a `void_override`), the decremented stock is **NOT** restored automatically.
* **Reasoning**: Once an item reaches the kitchen, voiding it typically implies the food was made incorrectly, dropped, or otherwise wasted—the physical inventory is gone. 
* **Correction**: If the item was actually perfectly salvageable (e.g., an unopened bottled beverage), staff must perform a manual stock adjustment to add it back. This ensures physical waste is accounted for correctly and avoids silently hiding food cost discrepancies.

## 3. Data Model

Location-scoped tables (`ingredient_stock`, `stock_adjustments`) implement the standard `PERMISSIVE` + `RESTRICTIVE` Row-Level Security (RLS) pattern using `location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid`, matching `services/api/migrations/011_orders_row_level_security.js`.

Organization-scoped tables (`ingredients`, `recipe_lines`) do **not** get RLS at all — this matches the existing precedent set by `products`, `categories`, `modifiers`, `staff`, and `roles` (see `services/api/migrations/007_row_level_security.js`, which only ever enables RLS on location-scoped tables). Organization isolation for these purely staff-facing, internal catalog tables is enforced entirely at the application layer via `WHERE organization_id = actor.organizationId` on every query, exactly like the existing menu catalog. (Note: `customers`/`customer_sessions` are a deliberate exception to this — they get organization-scoped RLS as defense-in-depth specifically because they're reachable via a customer's own bearer token, a different actor class with a different risk profile than internal staff-only data. `ingredients`/`recipe_lines` have no customer or guest access path at all, so that exception does not apply here.)

*Quantities use `DECIMAL(12,4)` to support precise fractional recipe measurements.*

### 3.1 `ingredients` (Organization-scoped, no RLS)
The shared catalog of trackable items.
* `id` (UUID, Primary Key)
* `organization_id` (UUID, NOT NULL, FK to organizations)
* `name` (VARCHAR, NOT NULL)
* `unit_of_measure` (VARCHAR, NOT NULL) — e.g., 'g', 'ml', 'unit'
* `created_at`, `updated_at` (TIMESTAMPTZ, Default NOW, trigger `set_updated_at`)

### 3.2 `ingredient_stock` (Location-scoped)
The physical count at a specific location.
* `id` (UUID, Primary Key)
* `location_id` (UUID, NOT NULL, FK to locations) — *RESTRICTIVE RLS applied here.*
* `ingredient_id` (UUID, NOT NULL, FK to ingredients)
* `quantity_on_hand` (DECIMAL(12,4), NOT NULL, DEFAULT 0)
* `low_stock_threshold` (DECIMAL(12,4), Nullable)
* `version` (INTEGER, NOT NULL, DEFAULT 1) — Optimistic concurrency.
* `created_at`, `updated_at` (TIMESTAMPTZ, Default NOW, trigger `set_updated_at`)
* *Constraints*: `UNIQUE(location_id, ingredient_id)`

### 3.3 `recipe_lines` (Organization-scoped, no RLS)
The bill of materials linking a menu item OR a modifier to its ingredients. A recipe line represents EITHER a product's own base consumption OR a modifier's own additional consumption — never both at once, since modifiers are shared across many products (via `product_modifier_groups`) and must define their own ingredient cost exactly once rather than being duplicated per product they're attached to.
* `id` (UUID, Primary Key)
* `organization_id` (UUID, NOT NULL, FK to organizations)
* `product_id` (UUID, Nullable, FK to products) — set for a product's own base recipe line; `NULL` for a modifier-only line.
* `variant_id` (UUID, Nullable, FK to product_variants) — only meaningful when `product_id` is set; a variant belongs to exactly one product, unlike modifiers, so this stays paired with `product_id`.
* `modifier_id` (UUID, Nullable, FK to modifiers) — set for a modifier's own recipe line; `NULL` for a product's base line.
* `ingredient_id` (UUID, NOT NULL, FK to ingredients)
* `quantity_per_unit` (DECIMAL(12,4), NOT NULL)
* `created_at`, `updated_at` (TIMESTAMPTZ, Default NOW, trigger `set_updated_at`)
* *Constraint*: `CHECK ((product_id IS NOT NULL) <> (modifier_id IS NOT NULL))` — exactly one of `product_id`/`modifier_id` must be set per row.

**Consumption calculation**: when an order line is sold, total ingredient consumption = the sum of the base product's own recipe lines (`recipe_lines` where `product_id` matches, `modifier_id IS NULL`) PLUS, for each modifier actually selected on that line, the sum of that modifier's own recipe lines (`recipe_lines` where `modifier_id` matches). This lets "Extra Cheese" define its ingredient cost once and have it apply correctly to every product it's attached to.

### 3.4 `stock_adjustments` (Location-scoped)
Immutable audit trail of staff-initiated physical counts and corrections.
* `id` (UUID, Primary Key)
* `location_id` (UUID, NOT NULL, FK to locations) — *RESTRICTIVE RLS applied here.*
* `ingredient_id` (UUID, NOT NULL, FK to ingredients)
* `staff_id` (UUID, NOT NULL, FK to staff)
* `quantity_delta` (DECIMAL(12,4), NOT NULL) — Positive (found more) or negative (waste/missing).
* `reason` (VARCHAR, NOT NULL)
* `created_at` (TIMESTAMPTZ, Default NOW)
* *(Note: No `updated_at` or `version` as this is an append-only audit table).*

## 4. API Surface

These endpoints utilize the standard `withAuthenticatedSession` guard and enforce the new inventory permissions.

### 4.1 Ingredients & Recipes (Org-level CRUD)
* **`GET /api/v1/ingredients`** — requires `inventory.ingredients.read`.
* **`POST /api/v1/ingredients`** — requires `inventory.ingredients.write`.
* **`PUT /api/v1/ingredients/{id}`** — requires `inventory.ingredients.write`.
* **`GET /api/v1/recipes`** (Can filter by `?product_id=`) — requires `inventory.recipes.read`.
* **`POST /api/v1/recipes`** — requires `inventory.recipes.write`.
* **`DELETE /api/v1/recipes/{id}`** — requires `inventory.recipes.write`.

### 4.2 Location Stock Management
* **`GET /api/v1/locations/{loc_id}/inventory`** — requires `inventory.stock.read`.
  * *Action*: Returns joined `ingredients` and `ingredient_stock` data.
* **`GET /api/v1/locations/{loc_id}/inventory/low-stock`** — requires `inventory.stock.read`.
  * *Action*: Returns only ingredients where `quantity_on_hand <= low_stock_threshold`. Used to power the Health Center dashboard tile.
* **`POST /api/v1/locations/{loc_id}/inventory/{ingredient_id}/adjust`** — requires `inventory.stock.adjust`.
  * *Payload*: `{ new_quantity, reason }` and `If-Match` header containing the current `ingredient_stock.version`.
  * *Action*: Calculates `quantity_delta = new_quantity - quantity_on_hand`. Updates `ingredient_stock` (incrementing version), and writes an immutable record to `stock_adjustments`. Returns `409 Conflict` if the `If-Match` version is stale.

## 5. Permissions

The following permissions must be added to the catalog, following the strict `<domain>.<resource>.<action>` convention:

| Permission Name | Description |
| :--- | :--- |
| `inventory.ingredients.read` | View the organization's ingredient catalog. |
| `inventory.ingredients.write` | Create and edit ingredients in the catalog. |
| `inventory.recipes.read` | View recipe mapping lines for products and modifiers. |
| `inventory.recipes.write` | Create, edit, and delete recipe mapping lines. |
| `inventory.stock.read` | View location stock levels, thresholds, and adjustment histories. |
| `inventory.stock.adjust` | Perform manual inventory counts, adjusting on-hand quantities and logging waste. |

## 6. Non-Goals

Per `idea.md` section 130 ("Prueba Fundamental de Simplicidad"), building accounts payable converts Inventory into an ERP. To strictly prevent scope creep, the following are **explicitly out of scope**:

* **Purchasing & Vendors:** No purchase orders, supplier management, receiving workflows, or accounts payable integration.
* **Dedicated Waste Tracking:** Waste is not a distinct subsystem. A "waste" event is simply a manual stock adjustment utilizing the `reason` string.
* **Multi-Location Transfers:** No workflows for moving physical stock between locations.
* **Hardware Integration:** No barcode or scanner support.
* **Recipe Costing:** Computing food-cost percentages is a future Reports-module concern once this foundation yields enough data; it is not part of this module.
* **Advanced Valuation:** No lot/batch tracking, expiry dates, or FIFO/LIFO financial valuation.

## 7. Open Questions / Judgement Calls

1. **Scoping Conflict Resolution (resolved):** The prompt requested `ingredients` be location-scoped, but also requested `recipe_lines` be organization-scoped with a foreign key to the ingredient. In a relational database, a shared organization-level recipe cannot safely hold a foreign key to a location-specific ingredient ID without duplicating the recipe per location. To resolve this and remain faithful to `idea.md` section 29 (which states recipes are shared while inventory varies), the data is modeled like `products` (org-scoped catalog) plus `location_price_overrides` (location-scoped attributes): `ingredients` is the shared catalog, `ingredient_stock` holds each location's quantity.
2. **Restocking on Void (resolved):** A voided line does NOT automatically return ingredients to stock, as post-send voids usually represent physical food waste in the kitchen. No special "Restock items?" UI is added to the void flow for this — the existing manual stock-adjustment capability (section 4.2) already covers the rare salvageable-item case without adding conditional complexity to the void action itself, consistent with keeping this module lightweight per section 6's Non-Goals.
