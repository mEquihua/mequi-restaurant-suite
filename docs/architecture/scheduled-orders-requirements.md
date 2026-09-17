# Scheduled Orders Requirements

This document is the precise, implementation-ready requirements reference for the "Scheduled Orders" feature within Restaurant Suite. It translates the product requirements from `idea.md` (specifically sections 69 and 114) into concrete mechanics.

## 1. Core Mechanics & Design Decisions

Scheduled Ordering allows a customer to choose a future pickup or delivery time instead of ASAP. As an "Enhancements-tier" item, the scope is kept intentionally small and tightly integrated with the existing online ordering flow.

### 1.1 Applies to Both Pickup and Delivery
Section 69 of `idea.md` lists Pickup, Delivery, ASAP, and "Pedido programado" as siblings. Therefore, scheduled ordering is a cross-cutting modifier that applies equally to both fulfillment types.

### 1.2 No New Order Lifecycle State
A scheduled order does not require a novel state machine. The `order_fulfillments` table already has a nullable `scheduled_for` column. When a scheduled order is placed, it follows the exact same lifecycle as an ASAP online order: the `orders` and `order_lines` rows are created and immediately advanced to `HELD` status. The order remains `HELD` until a staff member manually transitions it or the kitchen display queries it.

### 1.3 Kitchen Visibility
The only genuinely novel business logic is ensuring the kitchen does not see scheduled orders hours or days in advance. Rather than introducing a complex cron job or delayed Valkey task to "auto-fire" scheduled orders to `SENT`, we rely on a simpler read-time filter:
The Kitchen Display endpoint will optionally exclude order lines whose `scheduled_for` timestamp is too far in the future (e.g., > 60 minutes from now). The front-of-house "Online Orders" view will still see all `HELD` orders and can manually manage them if needed.

## 2. Data Model

A new location-scoped settings table is required to manage whether a location accepts scheduled orders and what their valid hours are. Following the codebase's precedent, this is its own table rather than adding columns to the unused `location_operating_config`.

### 2.1 `scheduled_order_settings` (Location-scoped)
Configuration dictating how and when a location accepts scheduled orders.
* `id` (UUID, Primary Key, Default `gen_random_uuid()`)
* `location_id` (UUID, NOT NULL, UNIQUE, FK to `locations`) — *RESTRICTIVE RLS applied here.*
* `accepts_scheduled_orders` (BOOLEAN, NOT NULL, DEFAULT false)
* `minimum_lead_time_minutes` (INTEGER, NOT NULL, DEFAULT 60) — How much advance notice is required.
* `maximum_lead_time_days` (INTEGER, NOT NULL, DEFAULT 7) — Sensible default bound to prevent scheduling months into the future.
* `operating_hours` (JSONB, NOT NULL, DEFAULT `[]`) — Exact same schema as `reservation_settings`: array of `{day_of_week: 1-7, open_time: "HH:MM", close_time: "HH:MM"}` objects.
* `version` (INTEGER, NOT NULL, DEFAULT 1)
* `created_at`, `updated_at` (TIMESTAMPTZ, Default NOW, trigger `set_updated_at`)

## 3. RLS Scoping

Following the precedent of `reservation_settings` (in `021_reservations.js`), the `scheduled_order_settings` table must implement the `PERMISSIVE` + `RESTRICTIVE` Row-Level Security (RLS) pattern based on `location_id`.
* The restrictive policy must enforce `USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid)`.

## 4. API Surface

These endpoints follow the standard `withAuthenticatedSession` and `withCustomerSession` guards.

### 4.1 Customer-Facing Checkout Changes
* **`POST /api/v1/locations/{loc_id}/online-orders/checkout`**
  * *Change*: The `scheduled_for` field is already in the request schema. Inside the handler, if `scheduled_for` is provided, query `scheduled_order_settings` synchronously before creating the order.
  * *Validation Rule*: Modeled exactly after `reservations/route.ts`'s `validateRequest`.
    1. Reject if `accepts_scheduled_orders` is false.
    2. Reject if the time is in the past.
    3. Reject if the time is < `now + minimum_lead_time_minutes`.
    4. Reject if the time is > `now + maximum_lead_time_days`.
    5. Reject if the time falls outside the location's `operating_hours` for that `day_of_week`.

### 4.2 Kitchen Display Query Changes
* **`GET /api/v1/locations/:locationId/order-lines`** (real param name is `:locationId`, not `:loc_id` — this specific endpoint's existing schema names it that way; do not rename it)
  * *Change*: Add an optional query parameter `exclude_future_scheduled` (boolean). This endpoint's existing `querystring` schema has `additionalProperties: false` with only `status` currently declared — the new property must be added there explicitly, or Fastify/AJV will reject any request that includes it.
  * *Action*: When `exclude_future_scheduled=true`, the query must `LEFT JOIN order_fulfillments as of ON of.order_id = ol.order_id` and append a `WHERE of.scheduled_for IS NULL OR of.scheduled_for <= NOW() + INTERVAL '60 minutes'`. The 60-minute hardcoded threshold ensures the order only appears on the kitchen's live queue when it is time to start prepping it.

### 4.3 Admin Settings Endpoints
* **`GET /api/v1/locations/{loc_id}/scheduled-order-settings`**
  * *Auth*: Staff session token.
  * *Permission*: `online_ordering.settings.read`.
* **`PUT /api/v1/locations/{loc_id}/scheduled-order-settings`**
  * *Auth*: Staff session token.
  * *Permission*: `online_ordering.settings.write`.

## 5. Permissions

The following permissions will be added to the IAM catalog:

| Permission Name | Description |
| :--- | :--- |
| `online_ordering.settings.read` | View the location's scheduled online ordering configuration. |
| `online_ordering.settings.write` | Update the location's scheduled online ordering configuration. |

## 6. User Interface Scope

### 6.1 Admin App Configuration
A new "Scheduled Orders" page under the Admin navigation (similar to the existing Reservations settings screen) that manages `scheduled_order_settings`:
* Toggle to accept scheduled orders.
* Configuration numbers (`minimum_lead_time_minutes`, `maximum_lead_time_days`).
* Operating hours picker (reusing the exact component pattern from the Reservations screen).

### 6.2 Customer App Checkout Form
The checkout flow will include a radio button or toggle for "ASAP" vs. "Scheduled".
* When "Scheduled" is selected, present a date and time picker.
* The UI should ideally fetch `scheduled-order-settings` to disable dates/times that violate the lead time or operating hours.

## 7. Explicitly Out of Scope (Non-Goals)

To prevent scope creep, the following are explicitly out of scope:
* **Recurring/Subscription Orders**: No support for automatically repeating orders.
* **Automatic Staff Reminders**: No new push notifications, SMS alerts, or Valkey background jobs for staff beyond the existing order flow.
* **Capacity-based Scheduling Limits**: No algorithms attempting to reject scheduled orders because the kitchen is "too busy" beyond the static lead-time and hours checks.
* **Complex Calendar UI**: No interactive calendar view for staff; scheduled orders just appear in standard list views.
