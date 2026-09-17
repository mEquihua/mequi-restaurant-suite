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
* `confirmed_by_staff_id` (UUID, Nullable, FK to staff)
* `cancelled_by_staff_id` (UUID, Nullable, FK to staff)
* `version` (INTEGER, NOT NULL, DEFAULT 1) — Optimistic concurrency.
* `created_at`, `updated_at` (TIMESTAMPTZ, Default NOW, trigger `set_updated_at`)

### 2.2 `reservation_settings` (Location-scoped)
Configuration dictating how and when a location accepts reservations.
* `id` (UUID, Primary Key)
* `location_id` (UUID, NOT NULL, UNIQUE, FK to locations) — *RESTRICTIVE RLS applied here.*
* `accepts_reservations` (BOOLEAN, NOT NULL, DEFAULT false)
* `operating_hours` (JSONB, NOT NULL) — Reuses the existing format for location operating hours, defining when reservations can be booked.
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
| `REQUESTED` / `CONFIRMED` | `CANCELLED` | Customer, Staff | Sets `cancelled_by_staff_id` if by staff. Terminal state. |
| `CONFIRMED` | `ARRIVED` | Staff | Marks the party as physically present and waiting in the lobby. |
| `CONFIRMED` / `ARRIVED` | `NO_SHOW` | Staff | Terminal state for parties that never arrived. |
| `ARRIVED` | `SEATED` | Staff | **Combined action**: The Host assigns a physical `table_id`. This executes the equivalent of `POST /api/v1/locations/:locationId/visits` to open a new `visit` and set the table to `OCCUPIED`. The resulting `visit_id` is saved to the reservation. |
| `SEATED` | `COMPLETED` | System | Triggered automatically when the linked `visit` is closed via `POST /api/v1/locations/:locationId/visits/:visitId/close`. Terminal state. |

## 4. API Surface

These endpoints utilize standard `withAuthenticatedSession` guards.

### 4.1 Customer-Facing Endpoints
* **`POST /api/v1/locations/{loc_id}/reservations/request`**
  * *Auth*: Dual-path (Public for guests, Bearer token for authenticated customers).
  * *Action*: Validates lead time, party size, and hours against `reservation_settings`. Creates the reservation. Applies `auto_confirm` logic to set initial status.
* **`GET /api/v1/customers/me/reservations`**
  * *Auth*: Bearer token (Authenticated customers only).
  * *Action*: Returns the user's historical and upcoming reservations. Note: Guest reservations have no ongoing lookup mechanism and are not returned here, matching the established online-ordering token limitation.

### 4.2 Staff & Admin Endpoints
* **`GET /api/v1/locations/{loc_id}/reservations`** — requires `reservations.reservations.read`.
  * *Action*: Lists reservations, typically filtered by date for the Host stand.
* **`GET /api/v1/locations/{loc_id}/reservations/{id}`** — requires `reservations.reservations.read`.
* **`POST /api/v1/locations/{loc_id}/reservations`** — requires `reservations.reservations.write`.
  * *Action*: Staff creating a manual reservation (e.g., over the phone).
* **`PUT /api/v1/locations/{loc_id}/reservations/{id}`** — requires `reservations.reservations.write`.
  * *Action*: Updates details (party size, time, notes) using `If-Match` for optimistic concurrency.
* **`POST /api/v1/locations/{loc_id}/reservations/{id}/status`** — requires corresponding status permission.
  * *Payload*: `{ status: 'CONFIRMED' | 'ARRIVED' | 'SEATED' | 'CANCELLED' | 'NO_SHOW', table_id?: UUID }`.
  * *Action*: Executes the state machine transitions.
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
* Provides quick-action buttons to progress the state: Confirm, Arrive, Cancel, No-Show.
* The "Seat" action opens a modal to select an `AVAILABLE` or `NEEDS_CLEANING` table from the floor plan, executing the single, combined API call that both transitions the reservation to `SEATED` and opens the visit on that table.

### 6.3 Customer App UI
* **Booking Form**: A clean interface asking for Location, Date, Time, Party Size, Name, Contact, and Optional Comment.
* **Status View**: A "My Reservations" list showing upcoming (Requested/Confirmed) and past (Cancelled/Completed) bookings for authenticated users.

## 7. Explicitly Out of Scope (Non-Goals)

To prevent scope creep and adhere to the "Simplicity Test" (idea.md section 130), the following are strictly out of scope:
* **Floor-plan-based advance table blocking**: Tables are not reserved in advance.
* **Waitlist management**: No queuing, estimated wait times, or SMS/notification paging.
* **Complex capacity algorithms**: No automatic reject logic beyond simple lead-time and max-party-size validation.
* **Financial guarantees**: No deposit collection or credit-card holds for reservations.
* **Advanced booking types**: No recurring reservations or dedicated group-event workflows.
* **External sync**: No calendar synchronization or ICS export.
* **Seating optimization**: No algorithms attempting to pack the floor plan efficiently.
