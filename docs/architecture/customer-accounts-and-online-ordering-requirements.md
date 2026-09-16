# Customer Accounts and Online Ordering Requirements

This document is the precise, implementation-ready requirements reference for the first phase of the Customer Accounts and Online Ordering backend capability. It translates the product requirements from `idea.md` (sections 67-76) into concrete mechanics, expanding on the existing Orders/Visits/Accounts data models.

**Note:** This document defines Phase 1. It explicitly scopes down delivery complexity, defers loyalty/reservations, and defers real payment provider integration to ensure the foundation is solidly built first.

## 1. Customer Accounts & Identity

A Customer account is a persistent, organization-wide identity that spans across multiple visits, online orders, and locations. It is fundamentally different from both staff sessions (which rely on PINs and terminal enrollment) and guest table sessions (which are ephemeral and bound to a specific table visit).

### 1.1 Authentication Model
* **Mechanism:** Email and password. This is the simplest viable mechanism for a self-hosted, single-organization deployment. It avoids the operational overhead of OAuth providers or full IAM systems while providing standard persistent login.
* **Hashing:** Passwords must be hashed using Argon2id, matching the exact codebase conventions established for staff PINs (`services/api/src/modules/identity/security.ts`).
* **Session Transport:** Bearer token (`Authorization: Bearer <token>`) passed in headers.
* **Authorization Scope:** A customer session provides authorization *only* to access records owned by that specific `customer_id`. Customers are not staff; they have no entry in the RBAC permission catalog. A dedicated `withCustomerSession` guard (analogous to `withGuestSession`) must enforce this boundary, explicitly blocking access to staff routes or other customers' data.

### 1.2 Guest Checkout
Per `idea.md` section 69, an online order must be placeable without creating a persistent account.
* **Representation:** A guest order is simply a standard `visits`/`orders`/`accounts` graph where `visits.customer_id` is `NULL` and `visits.table_id` is `NULL`.
* **Fulfillment Data:** To ensure the restaurant knows who the guest is and how to contact them, a new `order_fulfillments` table (detailed in section 5) stores the name, email, phone, and pickup/delivery details tied to the `order_id`. This table is populated for both guest and authenticated orders, but for guests, it is the sole source of contact info.

## 2. Online Ordering (Pickup)

Pickup ordering must reuse the exact same order, account, and payment model as in-store operations. An online order is a `visits` row with no `table_id`, an `orders` row with `order_type = 'PICKUP'`, and an associated `accounts` row.

### 2.1 Order Lifecycle Mapping
The product lifecycle defined in `idea.md` section 70 maps directly onto the existing `order_lines` state machine (`services/api/src/modules/orders/state.ts`):

* **Received (Pending Acceptance):** The customer submits the order. The order lines are created in the `HELD` state. This accurately reflects "Registrado pero aún no enviado a producción" — the order is in the system, but the kitchen cannot see it yet.
* **Accepted:** A staff member reviews the incoming order and clicks "Accept". This fires the `POST /api/v1/locations/{loc_id}/orders/{order_id}/send` command, transitioning the `HELD` lines to `SENT` and generating an outbox event for the Kitchen Display System (KDS).
* **Preparing:** The kitchen acknowledges the ticket (`PREPARING`).
* **Ready for pickup:** The kitchen finishes the order (`READY`).
* **Picked up:** Staff hands the order to the customer and marks the lines as `FULFILLED`, at which point the parent `orders` aggregate becomes `COMPLETED`.

*(Note: If auto-accept is enabled via location configuration, the checkout endpoint can bypass `HELD` and create the lines directly in `SENT` state.)*

### 2.2 Scheduled vs. ASAP Orders
`idea.md` section 69 mandates support for scheduled orders.
* **Representation:** A `scheduled_for` timestamp is added to the new `order_fulfillments` table.
* **Kitchen Interaction:** A scheduled order is created with lines in the `HELD` state. It remains `HELD` until a configurable lead time (e.g., 30 minutes before `scheduled_for`). The system (via a background cron/worker) or staff manually fires the order at that time, transitioning the lines to `SENT` so they appear on the KDS exactly when preparation should begin.

### 2.3 Phase 1 Payment Default
Online orders fundamentally need payment, but integrating a payment provider (Stripe, etc.) is a dedicated subsequent phase.
* **Phase 1 Constraint:** Online ordering will defer payment to pickup. The checkout endpoint creates the order and account, but does *not* accept payment details. The account remains `OPEN`.
* **Fulfillment:** When the customer arrives, staff use the standard Point of Sale (POS) UI to locate the order, verify the amount, and record a payment via the existing `POST /api/v1/locations/{loc_id}/accounts/{account_id}/payments` endpoint (e.g., `CASH` or `CARD` via terminal). This deliberately "fails closed" to a safe, proven operational model rather than faking an insecure online payment flow.

## 3. Delivery (Extension Scope)

Delivery is supported as a clearly scoped extension (`idea.md` sections 71-73). It does *not* include driver apps, live maps, route optimization, or GPS.

### 3.1 Delivery Mechanics
* **Zones & Fees:** The database requires a `delivery_zones` table (defining polygons or radius rules, minimum order amounts, and fees).
* **Fulfillment:** The `order_fulfillments` table captures the validated delivery address and any assigned driver name.
* **Delivery progress belongs on the order, not on each line.** "Out for delivery" and "Delivered" describe the whole order's journey once every item has left the kitchen together in one delivery run — they are not a kitchen-prep step, and per-line staging would let one line report `OUT_FOR_DELIVERY` while a sibling line is still `PREPARING`, which is incoherent for a single physical delivery. **Do not extend `order_lines.status`** (`DRAFT`/`HELD`/`SENT`/`PREPARING`/`READY`/`FULFILLED`/`CANCELLED`/`VOIDED`) or its `chk_order_line_status` constraint at all — every line still only ever reaches `READY` from the kitchen's perspective, exactly like a pickup order. Instead, add a `status` column directly to `order_fulfillments` (the table already created for exactly this kind of order-level fulfillment metadata): `CHECK IN ('PENDING', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED')`, defaulting to `PENDING`.
  * **Transition:** once staff confirm every line on the order is `READY`, they mark `order_fulfillments.status` as `OUT_FOR_DELIVERY` (a front-of-house/dispatch action — gate it with a permission scoped to that role, not `kitchen.tickets.update_status`, since this is not a kitchen action), then `DELIVERED` on confirmation. This is a separate, simple state column update with its own `version` column for optimistic concurrency, following the same `If-Match` convention as everything else — it does not touch the order/order-line state machine at all.

## 4. API Surface

To support consumer networks, order submission is composed into a single transactional endpoint rather than requiring the client to choreograph visits, accounts, and lines individually.

### 4.1 Customer Identity Endpoints
* **`POST /api/v1/organizations/{org_id}/customers`**
  * Registers a new customer account (email, password, name).
* **`POST /api/v1/organizations/{org_id}/customer-sessions`**
  * Authenticates email/password, mints a session token, and returns the bearer token.
* **`GET /api/v1/organizations/{org_id}/customer-sessions/current`**
  * Requires `withCustomerSession`. Returns the customer profile.

### 4.2 Reused Staff Endpoints (Dual Auth)
The following read-only endpoints must accept *either* a staff session, a guest session, or a customer session:
* **`GET /api/v1/categories`**
* **`GET /api/v1/products`**
  * The customer app must pass the order's `order_type` (`PICKUP` or `DELIVERY`) as query params, matching the existing convention already used elsewhere in `resolveAvailability` calls: the SAME value is passed for both `channel` and `serviceType` (see `services/api/src/modules/orders/route.ts`'s send-lines handler, which re-checks availability at send time the identical way) — passing only one of the two would let checkout accept a product that the send endpoint later rejects as unavailable, since a rule scoped on the other dimension wouldn't be checked.

### 4.3 Online Ordering Endpoints
* **`POST /api/v1/locations/{loc_id}/online-orders/checkout`**
  * *Auth:* Accepts `withCustomerSession` OR is Public (for guest checkout).
  * *Payload:* Items, modifiers, contact info (name/phone), fulfillment type (`PICKUP`/`DELIVERY`), and `scheduled_for` (if not ASAP).
  * *Action:* Transactionally creates a `visits` row (with nullable `customer_id`), an `orders` row (`order_type = 'PICKUP'` or `'DELIVERY'`), an `accounts` row, the `order_lines` (in `HELD` state), and the `order_fulfillments` row. Returns an `order_token` (for guests to poll status) and the `order_id`.
* **`GET /api/v1/locations/{loc_id}/online-orders/{order_id}`**
  * *Auth:* Requires `withCustomerSession` (must own the order) OR the `order_token` returned during guest checkout.
  * Returns the current aggregate state, line items, and `order_fulfillments.status` so the customer app can poll for `READY` (pickup) or `OUT_FOR_DELIVERY`/`DELIVERED` (delivery).
* **`POST /api/v1/locations/{loc_id}/orders/{order_id}/fulfillment/dispatch`**
  * *Auth:* Staff session, a dispatch-scoped permission (not `kitchen.tickets.update_status` — see 3.1), `If-Match` on `order_fulfillments.version`.
  * *Action:* `DELIVERY` orders only; transitions `order_fulfillments.status` from `PENDING` to `OUT_FOR_DELIVERY`. Reject with `409` if any order line isn't yet `READY`/`FULFILLED`, and reject for `PICKUP` orders (they have no dispatch step).
* **`POST /api/v1/locations/{loc_id}/orders/{order_id}/fulfillment/deliver`**
  * *Auth:* Staff session, same permission, `If-Match`.
  * *Action:* Transitions `order_fulfillments.status` from `OUT_FOR_DELIVERY` to `DELIVERED`.

## 5. Data Model

New tables must implement the standard `PERMISSIVE` + `RESTRICTIVE` Row-Level Security (RLS) pattern. Note that customers are scoped to the organization, while their orders are scoped to a specific location.

### 5.1 `customers`
* `id` (UUID, Primary Key)
* `organization_id` (UUID, NOT NULL) - *RLS scopes here.*
* `email` (VARCHAR, NOT NULL, UNIQUE within org)
* `password_hash` (VARCHAR, NOT NULL) - Argon2id hashed.
* `name` (VARCHAR, NOT NULL)
* `phone` (VARCHAR, Nullable)
* `created_at`, `updated_at` (TIMESTAMPTZ)

### 5.2 `customer_sessions`
* `id` (UUID, Primary Key)
* `organization_id` (UUID, NOT NULL)
* `customer_id` (UUID, NOT NULL, FK to customers)
* `token_hash` (VARCHAR, NOT NULL, UNIQUE) - Hashed session secret (e.g., SHA-256).
* `created_at` (TIMESTAMPTZ, Default NOW)
* `expires_at` (TIMESTAMPTZ, NOT NULL)
* `revoked_at` (TIMESTAMPTZ, Nullable)

### 5.3 `order_fulfillments`
Ties contact and logistical data to an order, essential for guest checkouts and delivery. Also the home for order-level delivery progress (see 3.1) — kept separate from `order_lines.status`, which remains kitchen-prep-only for every order type.
* `id` (UUID, Primary Key)
* `location_id` (UUID, NOT NULL) - *RLS scopes here, matching the order.*
* `order_id` (UUID, NOT NULL, UNIQUE, FK to orders)
* `fulfillment_type` (VARCHAR, NOT NULL) - `CHECK IN ('PICKUP', 'DELIVERY')`
* `status` (VARCHAR, NOT NULL, DEFAULT 'PENDING') - `CHECK IN ('PENDING', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED')`. For `PICKUP` orders this stays `PENDING` throughout; pickup completion is already fully represented by the order lines reaching `FULFILLED`.
* `scheduled_for` (TIMESTAMPTZ, Nullable) - ASAP if null.
* `customer_name` (VARCHAR, NOT NULL)
* `customer_email` (VARCHAR, NOT NULL)
* `customer_phone` (VARCHAR, NOT NULL)
* `delivery_address` (JSONB, Nullable)
* `delivery_driver_name` (VARCHAR, Nullable) - Populated manually by staff.
* `version` (INTEGER, NOT NULL, DEFAULT 1) - optimistic concurrency for `status` updates, same `If-Match` convention as everywhere else.
* `created_at`, `updated_at` (TIMESTAMPTZ)

### 5.4 `delivery_zones`
* `id` (UUID, Primary Key)
* `location_id` (UUID, NOT NULL)
* `name` (VARCHAR, NOT NULL)
* `fee` (INTEGER, NOT NULL)
* `minimum_order_amount` (INTEGER, NOT NULL DEFAULT 0)
* `active` (BOOLEAN, NOT NULL DEFAULT TRUE)
* `created_at`, `updated_at` (TIMESTAMPTZ)

### 5.5 Modifications to Existing Tables
* **`visits`**: Add `customer_id` (UUID, Nullable, FK to customers).
* **`order_lines`**: No changes. The existing status enum and `chk_order_line_status` constraint are untouched — delivery progress lives on `order_fulfillments` instead (see 3.1 and 5.3).

## 6. Explicitly Out of Scope

To prevent scope creep, the implementing engineer must explicitly ignore the following in this Phase 1 module:
* **Real Payment Provider Integration (Stripe, etc.):** Deferred. All payments default to in-person at fulfillment.
* **Loyalty & Rewards:** Points, coupons, and reward redemption logic (`idea.md` section 75).
* **Reservations:** The table booking flow (`idea.md` section 74).
* **Customer History Screen Specifics:** The API automatically provides historical queries via `customer_id`, but specific reorder/favorite UI endpoints are deferred until the frontend actually consumes them (`idea.md` section 76).
* **Advanced Delivery:** GPS tracking, live maps, automated route optimization, batch dispatching, driver marketplace integrations, or a separate driver app (`idea.md` section 73 explicitly rules these out).
