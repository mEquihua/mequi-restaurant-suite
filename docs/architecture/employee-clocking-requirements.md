# Employee Clocking Requirements

This document is the precise, implementation-ready requirements reference for the "Employee Clocking" (time and attendance) backend capability within Restaurant Suite. It translates the product requirements from `idea.md` (specifically section 21 "EMPLEADOS") into concrete mechanics, providing basic shift tracking and an activity log without the complexity of a full Human Resources Information System (HRIS).

## 1. Core Mechanics & Design Decisions

### 1.1 Simple Shift Lifecycle
A staff member "clocks in" to open a work period and later "clocks out" to close it, producing one row per shift. There is no break tracking, schedule enforcement, or complex overtime calculation. The lifecycle is strictly `OPEN` -> `CLOSED`.

### 1.2 Authentication & Session Interaction
Clock-in and clock-out actions **ride on top of an already-unlocked staff session**. They do not require a separate PIN prompt. A restaurant terminal is either already unlocked for a cashier's duration, or unlocked on demand by a waiter to access the POS. Since `withAuthenticatedSession` has already verified their identity, requiring them to type their PIN again just to press "Clock In" is redundant. 

Furthermore, clocking is **independent of session expiry**. An open shift does not prevent a POS session token from expiring, and a session expiring does not automatically clock the staff member out. The two lifecycles remain decoupled for simplicity.

### 1.3 Module Gating
This feature is gated behind `module_activations` using the module key `timeclock`. `idea.md` specifies "Clock-in / clock-out cuando el restaurante utilice esa capacidad", meaning a restaurant must explicitly activate this feature to use it, preventing clutter for organizations that manage payroll and attendance entirely externally.

## 2. Data Model

All tables must implement the `PERMISSIVE` + `RESTRICTIVE` Row-Level Security (RLS) pattern based on `location_id` used throughout the foundation database schema, matching `011_orders_row_level_security.js`.

### 2.1 `timeclock_shifts` (Location-scoped)
The core record of a work period.
* `id` (UUID, Primary Key, Default `gen_random_uuid()`)
* `location_id` (UUID, NOT NULL, FK to locations) — *RESTRICTIVE RLS applied here.*
* `staff_id` (UUID, NOT NULL, FK to staff) — The employee working the shift.
* `status` (VARCHAR, NOT NULL, DEFAULT 'OPEN') — Enum: `OPEN`, `CLOSED`.
* `clocked_in_at` (TIMESTAMPTZ, NOT NULL, Default NOW())
* `clocked_out_at` (TIMESTAMPTZ, Nullable)
* `clocked_in_by_staff_id` (UUID, NOT NULL, FK to staff) — The actor who opened the shift (usually matches `staff_id`, but could be a manager).
* `clocked_out_by_staff_id` (UUID, Nullable, FK to staff) — The actor who closed the shift.
* `version` (INTEGER, NOT NULL, DEFAULT 1) — Optimistic concurrency.
* `created_at`, `updated_at` (TIMESTAMPTZ, Default NOW, trigger `set_updated_at`)

## 3. RLS Scoping

**Decision**: The `timeclock_shifts` table uses location-scoped RLS (`location_id = app.current_location_id`).
**Justification**: Shifts are operational data tied to a physical location, just like `visits`, `orders`, and `cash_drawer_sessions`. They are not organization-scoped configuration like `loyalty_settings` or `roles`. Additionally, this data is purely internal and not reachable by public/guest bearer tokens. Therefore, the standard location-scoped dual RLS (`PERMISSIVE` for access, `RESTRICTIVE` for tenant isolation) is the exact match for this domain.

## 4. API Surface

These endpoints utilize standard `withAuthenticatedSession` guards.

### 4.1 Staff Self-Service Endpoints
* **`GET /api/v1/staff/me/shifts`**
  * *Auth*: Staff session token.
  * *Action*: Returns the authenticated staff member's own recent shifts for the current location. No special permission is required beyond a valid staff session.
* **`POST /api/v1/locations/{loc_id}/shifts/clock-in`**
  * *Auth*: Staff session token.
  * *Permission*: `timeclock.shifts.clock`.
  * *Action*: Creates a new `timeclock_shifts` row in `OPEN` status for the `actor.staffId`. (Optionally fails if the staff member already has an `OPEN` shift at this location).

### 4.2 Manager & Admin Endpoints
* **`GET /api/v1/locations/{loc_id}/shifts`**
  * *Auth*: Staff session token.
  * *Permission*: `timeclock.shifts.read`.
  * *Action*: Lists all shifts for the location, with optional query parameters to filter by date range and/or `staff_id`.
* **`POST /api/v1/locations/{loc_id}/shifts`**
  * *Auth*: Staff session token.
  * *Permission*: `timeclock.shifts.write`.
  * *Action*: Manual creation of a historical shift (e.g., manager adding a missed shift).
* **`PUT /api/v1/locations/{loc_id}/shifts/{id}`**
  * *Auth*: Staff session token.
  * *Permission*: `timeclock.shifts.write`.
  * *Action*: Manual edit of an existing shift (e.g., correcting `clocked_in_at` or `clocked_out_at`). Expects `If-Match` for optimistic concurrency.
* **`POST /api/v1/locations/{loc_id}/shifts/{id}/clock-out`**
  * *Auth*: Staff session token.
  * *Permission*: Requires `timeclock.shifts.clock` if `shift.staff_id === actor.staffId` (self-service). Requires `timeclock.shifts.write` if clocking out a different staff member (manager action).
  * *Action*: Transitions the shift to `CLOSED`, sets `clocked_out_at` to now, and records `clocked_out_by_staff_id`. Expects `If-Match`.

## 5. Permissions

The following permissions will be added to the catalog, following the strict `<domain>.<resource>.<action>` convention:

| Permission Name | Description |
| :--- | :--- |
| `timeclock.shifts.read` | View the location's shift activity for all employees. |
| `timeclock.shifts.write` | Manually create, edit, or clock out other employees' shifts. |
| `timeclock.shifts.clock` | Clock oneself in and out. |

## 6. Non-Goals

To keep the scope strictly bounded to `idea.md`, the following are explicitly out of scope:
* **Payroll & HRIS Integration**: No calculation of wages, taxes, benefits, or direct integrations with external payroll providers.
* **Scheduling & Rostering**: No advance creation of work schedules, shift trades, or optimization algorithms to manage labor cost.
* **Overtime Calculation**: The system logs timestamps but does not compute daily/weekly overtime rules or penalty pay.
* **Break Tracking**: No distinct states for "Meal Break" or "Rest Break"; shifts are a simple single continuous block.
* **Contract Management**: No tracking of employment contracts, insurance, or international labor law compliance.
