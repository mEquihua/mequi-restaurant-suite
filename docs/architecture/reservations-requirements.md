# Reservations Requirements

This document is the precise, implementation-ready requirements reference for the "Reservations" backend capability within Restaurant Suite. It translates the product requirements from `idea.md` (specifically sections 26, 27, 74, and 113) into concrete mechanics, providing an essential, streamlined table booking flow without the complexity of a full table-management ERP.

## 1. Core Mechanics & Design Decisions

This is an "essential version" of reservations. It explicitly does **not** attempt to reconstruct OpenTable or Toast Tables' integrated floor-plan seating optimizer.

### 1.1 No Advance Table Blocking
A core design decision is that **tables are only assigned at the moment of arrival**, not at the time of booking. The system records that a party of 4 is coming at 8:00 PM, but does not pre-block Table 12. This eliminates the need for complex, time-series availability computation and collision detection on specific tables.

### 1.2 The Auto-Confirm Policy
To fulfill the `idea.md` requirement that reservations are confirmed "según política" (per policy) without introducing complex capacity-computation algorithms, the location configuration includes a simple `auto_confirm` flag.
* If `true`, new reservations bypass the `REQUESTED` state and are created directly as `CONFIRMED`, assuming the location simply accepts all requests within their max party size and lead time limits.
* If `false`, new reservations are created as `REQUESTED` and require a staff member to manually transition them to `CONFIRMED`.

### 1.3 Waitlist Deferred
The `WAITLISTED` state mentioned as optional in `idea.md` is **excluded** from this initial release. A true waitlist feature implies queue management, position estimation, and SMS paging—which represent significant scope creep for a v1 essential reservations module.

## 2. Data Model

All location-scoped tables must implement the `PERMISSIVE` + `RESTRICTIVE` Row-Level Security (RLS) pattern based on `location_id` used throughout the foundation database schema, matching `services/api/migrations/011_orders_row_level_security.js`.

### 2.1 `reservations` (Location-scoped)
The core record of a booking request and its lifecycle.
* `id` (UUID, Primary Key)
* `location_id` (UUID, NOT NULL, FK to locations) — *RESTRICTIVE RLS applied here.*
* `customer_id` (UUID, Nullable, FK to customers) — Null for guest bookings.
* `party_size` (INTEGER, NOT NULL)
* `requested_at` (TIMESTAMPTZ, NOT NULL, Default NOW) — When the booking was made.
* `reservation_time` (TIMESTAMPTZ, NOT NULL) — The actual date and time being booked.
* `status` (VARCHAR, NOT NULL) — Enum: `REQUESTED`, `CONFIRMED`, `ARRIVED`, `SEATED`, `COMPLETED`, `CANCELLED`, `NO_SHOW`.
* `customer_name` (VARCHAR, NOT NULL)
* `customer_email` (VARCHAR, Nullable)
* `customer_phone` (VARCHAR, Nullable)
* `special_requests` (TEXT, Nullable)
* `visit_id` (UUID, Nullable, FK to visits) — Set during the `SEATED` transition.
* `guest_token_hash` (VARCHAR, Nullable) — SHA-256 hash of a random token minted at creation time for a GUEST booking (`customer_id IS NULL`), mirroring the exact mechanism already established for guest online orders (`order_fulfillments.guest_token_hash`, `services/api/src/modules/orders/online-ordering.ts`). idea.md section 74 requires that a customer be able to check status and cancel — this applies to guests too, not only authenticated customers, and without a token a guest booking would otherwise be permanently unreachable after creation. `NULL` for a reservation made by an authenticated customer.
* `confirmed_by_staff_id` (UUID, Nullable, FK to staff)
* `cancelled_by_staff_id` (UUID, Nullable, FK to staff)
* `version` (INTEGER, NOT NULL, DEFAULT 1) — Optimistic concurrency.
* `created_at`, `updated_at` (TIMESTAMPTZ, Default NOW, trigger `set_updated_at`)

### 2.2 `reservation_settings` (Location-scoped)
Configuration dictating how and when a location accepts reservations.
* `id` (UUID, Primary Key)
* `location_id` (UUID, NOT NULL, UNIQUE, FK to locations) — *RESTRICTIVE RLS applied here.*
* `accepts_reservations` (BOOLEAN, NOT NULL, DEFAULT false)
* `operating_hours` (JSONB, NOT NULL, DEFAULT `[]`) — **Correction**: `location_operating_config` (`services/api/migrations/001_foundation.js`) exists in the schema but is read/written by zero code anywhere in this codebase today — there is no existing operating-hours format to reuse, and this document should not claim otherwise. Define a self-contained shape instead: an array of `{day_of_week: 1-7 (ISO weekday, matching the convention already used by `availability_rules.days_of_week`), open_time: "HH:MM", close_time: "HH:MM"}` objects, one entry per open day; a day with no entry is closed for reservations. This is intentionally simple JSONB rather than a normalized table, since it's a single low-write-frequency settings row, not a queried/joined dataset.
* `estimated_visit_duration_minutes` (INTEGER, NOT NULL, DEFAULT 90)
* `minimum_lead_time_minutes` (INTEGER, NOT NULL, DEFAULT 60)
* `maximum_party_size` (INTEGER, NOT NULL, DEFAULT 8)
* `auto_confirm` (BOOLEAN, NOT NULL, DEFAULT false)
* `version` (INTEGER, NOT NULL, DEFAULT 1)
* `created_at`, `updated_at` (TIMESTAMPTZ, Default NOW, trigger `set_updated_at`)

## 3. State Machine

The following defines the strict, legal lifecycle of a reservation.

| Current Status | Target Status | Triggered By | Side Effects & Mechanics |
| :--- | :--- | :--- | :--- |
| `REQUESTED` | `CONFIRMED` | System, Staff | If `auto_confirm` is true, system triggers immediately. Otherwise, staff triggers. Sets `confirmed_by_staff_id`. |
| `REQUESTED` / `CONFIRMED` | `CANCELLED` | Customer (authenticated or guest, via their own reservation only — section 4.1's cancel endpoint), Staff | Sets `cancelled_by_staff_id` if by staff, left `NULL` if by the customer/guest themselves. Terminal state. |
| `CONFIRMED` | `ARRIVED` | Staff | Marks the party as physically present and waiting in the lobby. |
| `CONFIRMED` / `ARRIVED` | `NO_SHOW` | Staff | Terminal state for parties that never arrived. |
| `ARRIVED` | `SEATED` | Staff | **Combined action**: The Host assigns a physical `table_id`. This executes the equivalent of `POST /api/v1/locations/:locationId/visits` to open a new `visit` and set the table to `OCCUPIED`. The resulting `visit_id` is saved to the reservation. |
| `SEATED` | `COMPLETED` | System | **Mechanism (must be specified precisely, not left as "triggered automatically")**: this is a direct, synchronous side effect added to the EXISTING `POST /api/v1/locations/:locationId/visits/:visitId/close` handler (`services/api/src/modules/orders/route.ts`) — inside that same transaction, after the visit closes successfully, check for a `reservations` row with `visit_id` equal to the closed visit and, if found, update its status to `COMPLETED` in the same transaction. This is a plain in-process database update, not an outbox-published event — this codebase's outbox/Valkey pub-sub pattern is reserved for cross-service realtime notifications (e.g., kitchen ticket updates), and a reservation's historical status does not need that. Terminal state. |

## 4. API Surface

These endpoints utilize standard `withAuthenticatedSession` guards.

### 4.1 Customer-Facing Endpoints
* **`POST /api/v1/locations/{loc_id}/reservations/request`**
  * *Auth*: Dual-path (Public for guests, Bearer token for authenticated customers) — identical convention to `POST /online-orders/checkout`.
  * *Action*: Validates lead time, party size, and hours against `reservation_settings`. Creates the reservation. Applies `auto_confirm` logic to set initial status. For a guest booking, mints a random token, stores its hash as `guest_token_hash`, and returns the plaintext token once in the response (`{reservation_id, guest_token}`, `guest_token: null` for an authenticated customer) — exactly mirroring `POST /online-orders/checkout`'s `{order_id, order_token}` shape.
* **`GET /api/v1/locations/{loc_id}/reservations/{id}`** — shared with the staff-facing route of the same path/method in section 4.2 (a single registered route, branching internally by token shape, same as the shared `cancel` endpoint below).
  * *Auth*: For a non-staff caller — an authenticated customer may fetch their own reservation (`customer_id` matches the session) with no extra param; a guest must supply the exact token from creation via `?guest_token=...` (rejecting the reservation's own `id` as a substitute, matching the online-ordering guest-token hardening) — `403 FORBIDDEN` otherwise.
  * *Action*: Returns the reservation's current status and details.
* **`GET /api/v1/customers/me/reservations`**
  * *Auth*: Bearer token (Authenticated customers only).
  * *Action*: Returns the user's historical and upcoming reservations. Guest reservations are never returned here (an authenticated customer session has no way to enumerate a guest booking it didn't itself make) — a guest relies entirely on the `guest_token` they were given at creation, via the two endpoints above.

### 4.2 Staff & Admin Endpoints
* **`GET /api/v1/locations/{loc_id}/reservations`** — requires `reservations.reservations.read`.
  * *Action*: Lists reservations, typically filtered by date for the Host stand.
* **`GET /api/v1/locations/{loc_id}/reservations/{id}`** — the staff branch of the shared route from section 4.1; requires `reservations.reservations.read` when a staff token is presented.
* **`POST /api/v1/locations/{loc_id}/reservations`** — requires `reservations.reservations.write`.
  * *Action*: Staff creating a manual reservation (e.g., over the phone).
* **`PUT /api/v1/locations/{loc_id}/reservations/{id}`** — requires `reservations.reservations.write`.
  * *Action*: Updates details (party size, time, notes) using `If-Match` for optimistic concurrency.
* **Status transitions as separate, action-named endpoints** — matching this codebase's established convention for multi-action state machines (order lines' `hold`/`send`/`void`, module-center's `activate`/`pause`/`deactivate`, fulfillment's `dispatch`/`deliver`) rather than one generic endpoint that branches its required permission at runtime based on body content:
  * **`POST /api/v1/locations/{loc_id}/reservations/{id}/confirm`** — requires `reservations.reservations.update_status`.
  * **`POST /api/v1/locations/{loc_id}/reservations/{id}/arrive`** — requires `reservations.reservations.update_status`.
  * **`POST /api/v1/locations/{loc_id}/reservations/{id}/no-show`** — requires `reservations.reservations.update_status`.
  * **`POST /api/v1/locations/{loc_id}/reservations/{id}/seat`** — requires `reservations.reservations.seat`. *Payload*: `{ table_id: UUID }`. All take `If-Match` for optimistic concurrency, matching every other status-changing endpoint in this codebase.
* **`POST /api/v1/locations/{loc_id}/reservations/{id}/cancel`** — a SINGLE shared endpoint for both audiences, not two separately-registered routes (registering the same path/method twice would conflict). Detects which caller it is by bearer token shape, the same way `services/api/src/modules/orders/online-ordering.ts`'s GET handler already distinguishes a `Bearer customer.*` token from a guest request (that existing code only branches customer-vs-guest, not staff — this endpoint additionally checks for a staff-shaped token first): if a staff `Authorization: Bearer` token is present, require `reservations.reservations.cancel` and record `cancelled_by_staff_id`; otherwise, fall back to the customer/guest dual-path rule from section 4.1 (session match or exact `guest_token`) and leave `cancelled_by_staff_id` null. Same state-machine effect either way.
* **`GET /api/v1/locations/{loc_id}/reservation-settings`** — requires `reservations.settings.read`.
* **`PUT /api/v1/locations/{loc_id}/reservation-settings`** — requires `reservations.settings.write`.

## 5. Permissions

The following permissions will be added to the catalog, following the strict `<domain>.<resource>.<action>` convention and matching the risk profile of the actions.

| Permission Name | Description |
| :--- | :--- |
| `reservations.reservations.read` | View the location's upcoming and historical reservations. |
| `reservations.reservations.write` | Create manual reservations or edit details of existing ones. |
| `reservations.reservations.update_status` | Confirm, mark as arrived, or mark as no-show (low financial risk). |
| `reservations.reservations.seat` | Seat a reservation at a table (high risk: implicitly opens a visit and locks a physical table, invoking `orders.visits.create` logic). |
| `reservations.reservations.cancel` | Cancel an existing reservation. |
| `reservations.settings.read` | View the location's reservation configuration. |
| `reservations.settings.write` | Update the location's reservation settings (hours, auto-confirm, capacity). |

*(Note: The actual addition of these into `docs/architecture/permission-catalog.md` is deferred to a follow-up implementation task.)*

## 6. User Interface Scope

### 6.1 Admin App Configuration
A simple settings form managing the fields in `reservation_settings`:
* Toggle to accept reservations.
* Hours of operation for booking.
* Standard configuration numbers (lead time, duration, max party).
* Auto-confirm toggle.

### 6.2 Staff App "Host" UI
The **Staff App** (`apps/staff`) hosts the reservation management screen, as it is the operational tool for Hosts and Waiters.
* Shows a list of today's reservations.
* Provides quick-action buttons calling the separate `confirm`/`arrive`/`no-show`/`cancel` endpoints (section 4.2) to progress the state.
* The "Seat" action opens a modal to select an `AVAILABLE` table from the floor plan (a table `NEEDS_CLEANING` or `OUT_OF_ORDER` must not be offered — seating onto one would contradict the entire purpose of that status) and calls `POST .../reservations/{id}/seat`, the single combined action that both transitions the reservation to `SEATED` and opens the visit on that table.

### 6.3 Customer App UI
* **Booking Form**: A clean interface asking for Location, Date, Time, Party Size, Name, Contact, and Optional Comment. On success for a guest booking, persist `{reservation_id, location_id, guest_token}` to `localStorage`, mirroring exactly how `apps/customer` already tracks guest online orders (see `StoredOrder`/`storeOrder` in `apps/customer/src/App.tsx`), since that token is a guest's only way to look up or cancel the booking afterward.
* **Status View**: A "My Reservations" list showing upcoming (Requested/Confirmed) and past (Cancelled/Completed) bookings — for an authenticated customer via `GET /api/v1/customers/me/reservations`, and for a guest by re-fetching each locally-stored `{location_id, reservation_id, guest_token}` entry via `GET /api/v1/locations/{loc_id}/reservations/{id}?guest_token=...`, exactly matching the existing guest online-order history pattern.

## 7. Explicitly Out of Scope (Non-Goals)

To prevent scope creep and adhere to the "Simplicity Test" (idea.md section 130), the following are strictly out of scope:
* **Floor-plan-based advance table blocking**: Tables are not reserved in advance.
* **Waitlist management**: No queuing, estimated wait times, or SMS/notification paging.
* **Complex capacity algorithms**: No automatic reject logic beyond simple lead-time and max-party-size validation.
* **Financial guarantees**: No deposit collection or credit-card holds for reservations.
* **Advanced booking types**: No recurring reservations or dedicated group-event workflows.
* **External sync**: No calendar synchronization or ICS export.
* **Seating optimization**: No algorithms attempting to pack the floor plan efficiently.
