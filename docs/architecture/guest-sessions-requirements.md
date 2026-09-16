# Guest Sessions and Table Self-Service Requirements

This document is the precise, implementation-ready requirements reference for the Guest Sessions backend capability within Restaurant Suite's Foundation scope. It translates the architectural decisions (ADR 0001), product requirements (`idea.md`), and existing domain models into concrete mechanics for table-based customer self-ordering.

## 1. Core Mechanics & Session Lifecycle

### 1.1 QR Code Definition
The physical QR code placed on a table encodes a stable, non-secret public identifier (e.g., `https://order.restaurant.local/qr/{location_id}/{table_id}`). It is **not** a signed JWT or a single-use token. It contains no state, secrets, or expiration, and can be permanently printed and adhered to the table.

### 1.2 Session Creation & Visit Association
Scanning the QR code triggers the client to call the public endpoint `POST /api/v1/locations/{loc_id}/tables/{table_id}/guest-session`.
*   **Mechanics:** The server inspects the `tables` record.
    *   If the table currently has an `OPEN` visit, the server mints a new `guest_sessions` record linked to that exact `visit_id`.
    *   If the table does not have an `OPEN` visit and its status is `AVAILABLE`, the server automatically executes the same visit-open logic as `POST /visits` (creating a new `OPEN` visit and transitioning the table to `OCCUPIED`, per the existing table-status side effect) and then links the new guest session to it.
    *   If the table's status is `NEEDS_CLEANING` or `OUT_OF_ORDER`, the endpoint rejects with a guest-appropriate `409 TABLE_NOT_READY` (a distinct code from the staff-facing `TABLE_NOT_AVAILABLE`, since a guest cannot act on this the way staff can — the response should suggest they ask a staff member for help, not retry).
*   **Concurrency (Multiple Phones):** If multiple guests at the same table scan the QR code concurrently, the API mints multiple distinct, independent `guest_sessions` records. All of these sessions will reference the **same** `visit_id` and `order_id`. This correctly allows a party of 4 to browse the menu and add items into a single shared table order, fulfilling `idea.md` section 64 ("no debe crearse una operación paralela separada de la mesa").

### 1.3 Session Revocation & Expiry
Guest sessions are strictly short-lived and bound to the lifecycle of the table visit.
*   **Explicit Revocation (Visit Close):** When staff close a visit via `POST /api/v1/locations/{loc_id}/visits/{visit_id}/close`, the transaction **must** explicitly delete or invalidate (e.g., set `revoked_at`) all `guest_sessions` where `visit_id = {visit_id}`. This prevents a guest from retaining ordering access after their meal is paid and the table is turned over.
*   **Timeout Expiry:** Sessions have a hard expiration (e.g., 12 hours) to guard against stale state if a visit is left open accidentally.
*   **Mid-flight Revocation:** If a guest attempts any action while their session has been revoked (e.g., they left the browser tab open after paying or staff force-closed the visit), the API must return `401 Unauthorized` and prompt the client to clear local state.

---

## 2. Permitted Guest Actions & Restrictions

### 2.1 The Guest Auth Model
Guests are **not staff**. They have no `staff_id`, no `iam.roles`, and no entry in the permission catalog at all — the permission-catalog's `<domain>.<resource>.<action>` model is a staff-only concept and does not apply here. Guest operations must bypass the standard RBAC `requirePermission(actor, ...)` checks entirely and instead rely on a dedicated `withGuestSession(request, ...)` guard, mirroring `withAuthenticatedSession`'s bearer-token-parsing shape (see 4.0) but resolving a `guest_sessions` row instead of a `staff_sessions` row. This guard enforces strict scoping: a guest session can only ever read or mutate records that belong to its assigned `visit_id` and `table_id`. Guest-specific route handlers (4.3) simply never implement void/cancel/hold logic at all — there is no permission to lack, the capability doesn't exist on these routes.

### 2.2 Allowed Actions
A valid guest session is explicitly authorized to:
*   **Read the Menu:** View the catalog and real-time availability (inheriting the same rules as staff reads).
*   **Add Order Lines:** Append new `DRAFT` order lines to the visit's existing open order.
*   **View Order Status:** Read the aggregate status and line-item fulfillment states (`PREPARING`, `READY`, etc.) of their specific visit's order.
*   **Submit Service Requests:** Fire typed events to the staff (e.g., Call Waiter, Request Bill, Need Water, Need Utensils).

### 2.3 Prohibited Actions
A guest session MUST NOT be able to:
*   Read or interact with any data belonging to other tables or visits.
*   View staff-only catalog fields (e.g., cost prices).
*   View other guests' private payment method details beyond the shared account total.
*   **Modify, Hold, Void, or Cancel Lines:** Once a guest adds a line, any removal or voiding must be performed by staff. No guest-facing route exists for void/cancel/hold actions — the capability doesn't exist on the guest surface at all, rather than being denied by a permission check.
*   Fire orders directly to the kitchen (changing `DRAFT` to `SENT`) *unless* the location's configuration explicitly enables guest auto-firing. By default, guests add to `DRAFT` and staff review/fire.

### 2.4 Payment Configuration
Per `idea.md` section 65, self-service payment is configurable per location.
*   The configuration is stored as a location-level Module Center flag or setting (e.g., `guest_payment_mode: 'ORDER_ONLY' | 'REQUEST_BILL' | 'ORDER_AND_PAY'`).
*   If `ORDER_AND_PAY` is active, the guest session may execute payment commands. These commands reuse the underlying domain logic of `accounts/{id}/payments`, but must be exposed via a guest-specific endpoint that strictly limits the payload (e.g., preventing guests from arbitrarily declaring a payment successful without a verified payment provider token) and uses the guest session guard.

---

## 3. Data Model

All new tables must implement the `PERMISSIVE` + `RESTRICTIVE` Row-Level Security (RLS) pattern based on `location_id` used throughout the foundation database schema.

### 3.1 `guest_sessions`
Tracks active device sessions tied to a visit.
*   `id` (UUID, Primary Key)
*   `location_id` (UUID, NOT NULL, FK to locations)
*   `visit_id` (UUID, NOT NULL, FK to visits)
*   `table_id` (UUID, NOT NULL, FK to tables)
*   `token_hash` (VARCHAR, NOT NULL, Unique) — Hashed session secret (e.g., SHA-256), never stored in plaintext.
*   `device_info` (VARCHAR, Nullable) — User agent or device hint for debugging.
*   `created_at` (TIMESTAMPTZ, Default NOW)
*   `expires_at` (TIMESTAMPTZ, NOT NULL)
*   `revoked_at` (TIMESTAMPTZ, Nullable)

### 3.2 `table_service_requests`
A minimal typed event table for guest-to-staff notifications. This is intentionally not a full ticketing system.
*   `id` (UUID, Primary Key)
*   `location_id` (UUID, NOT NULL, FK to locations)
*   `visit_id` (UUID, NOT NULL, FK to visits)
*   `table_id` (UUID, NOT NULL, FK to tables)
*   `request_type` (VARCHAR, NOT NULL) — `CHECK IN ('CALL_WAITER', 'REQUEST_BILL', 'NEED_WATER', 'NEED_UTENSILS')`
*   `status` (VARCHAR, NOT NULL, Default 'PENDING') — `CHECK IN ('PENDING', 'RESOLVED')`
*   `created_at` (TIMESTAMPTZ, Default NOW)
*   `resolved_at` (TIMESTAMPTZ, Nullable)
*   `resolved_by_staff_id` (UUID, Nullable, FK to staff)

---

## 4. API Surface

To enforce the strict guest scope without polluting the generic staff endpoints with complex `if (isGuest)` branching, the API exposes dedicated `/guest-sessions/current/...` routes.

### 4.0 Token Transport
Guest sessions use the exact same bearer-token convention as staff sessions (`Authorization: Bearer <token>`, parsed the same way `parseSessionToken` does for staff), not a cookie. This is a deliberate consistency choice, not an open question: the Self-Service PWA reuses the same `apiFetch` wrapper, `sessionStorage`-token-storage convention, and — critically — the same `Sec-WebSocket-Protocol` subprotocol workaround already built and verified for the Staff and Kitchen apps' realtime connections (see `apps/staff/src/realtime.ts` and the fix in `services/api/src/modules/realtime/route.ts`). A cookie-based approach would require a second, parallel auth mechanism throughout the frontend shared patterns and the realtime gateway for no real benefit, since this is a PWA making its own fetch/WebSocket calls, not server-rendered pages relying on browser-managed cookies.

### 4.1 Unauthenticated / Session Minting
*   **`POST /api/v1/locations/{loc_id}/tables/{table_id}/guest-session`**
    *   *Auth:* Public (Rate-limited by IP).
    *   *Action:* Resolves the table, finds-or-opens a visit per 1.2, and mints a `guest_sessions` row. Returns the bearer token in the JSON response body (`{ token, visit_id, table_id, expires_at }`), for the client to store in `sessionStorage` exactly like a staff session.

### 4.2 Reused Staff Endpoints (Dual Auth)
The following existing read-only endpoints (`services/api/src/modules/menu/route.ts`) must be updated to accept *either* a valid staff session *or* a valid guest session:
*   **`GET /api/v1/categories`**
*   **`GET /api/v1/products`** (already accepts `channel`/`service_type`/`at` query params for availability resolution — a guest request should default `channel` to a value representing self-service ordering, e.g. `TABLE_SELF_ORDER`, matching the existing `order_type` enum on orders)

### 4.3 Guest-Specific Endpoints (Requires valid guest session)
These routes implicitly extract `visit_id` and `table_id` from the session token and cannot be manipulated to target another visit.
*   **`GET /api/v1/locations/{loc_id}/guest-sessions/current`**
    *   Returns the active visit ID, table details, and the location's self-service configuration (e.g., allowed payment modes).
*   **`GET /api/v1/locations/{loc_id}/guest-sessions/current/order`**
    *   Returns a read-only view of the visit's aggregate order, including all lines, their fulfillment statuses, and the account subtotal.
*   **`POST /api/v1/locations/{loc_id}/guest-sessions/current/lines`**
    *   Adds items to the visit's existing order. Reuses the underlying domain command for adding lines but ignores any payload fields related to custom prices, forced states, or arbitrary seat manipulation not suited for guests.
*   **`POST /api/v1/locations/{loc_id}/guest-sessions/current/service-requests`**
    *   Creates a `table_service_requests` row. Emits an `outbox_events` payload for staff real-time notification.
*   **`POST /api/v1/locations/{loc_id}/guest-sessions/current/payments`**
    *   If `guest_payment_mode` permits, accepts a verified provider payment token (e.g., Stripe PaymentIntent) and records the payment against the visit's account.

### 4.4 Realtime Updates
A guest waiting on their order needs to know when it moves to `PREPARING`/`READY` without polling. The realtime WebSocket gateway (`services/api/src/modules/realtime/route.ts`) must accept a guest session token through the same `Sec-WebSocket-Protocol` subprotocol mechanism already built for staff (browsers cannot set an `Authorization` header on a WebSocket handshake — see the fix history in that file). `withGuestSession`'s token-resolution logic must be reachable from the same code path `withAuthenticatedSession` uses there, so the gateway can authenticate either kind of session and scope the connection's `location:*:events` subscription to the guest's own `visit_id` (never forwarding events for other visits/tables to a guest connection, unlike a staff connection which legitimately sees the whole location).

### 4.5 Order Status Display Mode (No Guest Session)
Per `idea.md` section 66, this is a **public screen**, not a per-guest experience — a shared display (e.g., a TV near the counter) showing anonymized order identifiers grouped by state (Preparing / Ready), explicitly avoiding personal information. This does not need a `guest_sessions` row at all: it needs a new, separate public read endpoint, e.g. `GET /api/v1/locations/{loc_id}/order-status-board`, returning only an order-facing identifier (order number or alias — not table number if that would be considered identifying in the restaurant's configuration, not guest name, not totals) and its aggregate state, for orders whose `order_type` indicates counter/pickup service. This is a distinct, simpler capability from table/QR guest sessions and should not be built on top of the guest-session auth model — keep it a genuinely public, read-only, non-session endpoint.

---

## 5. Explicitly Out of Scope

To prevent scope creep, the implementing engineer must explicitly ignore the following in this module:
*   **Customer Tier Concepts:** Loyalty points, online ordering (pickup/delivery), reservations, and coupons are Customer-app tier features (`idea.md` section 67) and are excluded from this table/QR flow.
*   **Kiosk Mode Specifics:** While Kiosk mode will likely reuse the guest-session payment mechanism, physical kiosk hardware pairing, welcome screens, and receipt printing are out of scope for this document.
*   **Payment Provider Integration:** The exact mechanism of digital wallet tokenization (Apple Pay, Google Pay) is deferred to the payment processor integration phase.
*   **Staff UI Implementation:** The frontend React components for waiters to see "Call Waiter" requests or KDS screens are not designed here, only the backend requirements to emit the data.
