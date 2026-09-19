# Advanced Device Management Requirements

This document is the implementation-ready reference for the **Device management avanzado** enhancement. It turns an enrolled terminal's current inert free-text `device_profile` into a structured, server-authoritative application profile. The outcome is that a dedicated device opens and constrains the appropriate existing experience: Kitchen (all or selected menu categories), Self-Service (kiosk, one table, or the order-status board), or Staff Host.

The feature is application-level behavior, not a device-fleet product. Profiles are assigned after a terminal is enrolled and are resolved from the terminal credential/session that is already associated with that browser.

## 1. Current-State Constraints

* `terminals.device_profile` was introduced as nullable `VARCHAR` in `002_identity.js`. It is currently accepted only as free text by `POST /api/v1/terminals/enroll` and displayed by the Admin terminal list. No application reads it to select a route or behavior.
* Kitchen and Staff already enroll a browser once, persist `{ terminal_id, secret }` in `localStorage`, PIN-unlock through `POST /api/v1/auth/pin-unlock` with `x-terminal-credential`, then call `GET /api/v1/auth/me` under a staff session.
* Self-Service currently has no terminal credential or enrollment mechanism. Its existing user-facing routes are `/:locationId/kiosk`, `/:locationId/table/:tableId`, and `/:locationId/status-board`; reaching one is entirely URL-driven.
* `GET /api/v1/auth/me` exposes the session's `terminal_id`, but not the terminal row or profile. `terminalCredential(request)` plus the PIN-unlock handler is the existing credential-only terminal-authentication path.
* Kitchen's `TicketBoard` fetches the full location feed from `GET /api/v1/locations/:locationId/order-lines?status=HELD,SENT,PREPARING,READY`. It has a localStorage-backed, operator-selectable tag filter (`All Kitchen`, `Grill`, etc.), but that is not a terminal profile, does not use `categories`, and is not enforced for a dedicated device. The profile rules below replace that selector when a category-scoped Kitchen profile is active.

## 2. Data Model and Canonical Profile Contract

### 2.1 Storage decision

Extend the existing `terminals` row with these nullable columns:

* `app_target VARCHAR NULL`
* `profile_config JSONB NULL`

Add a database check limiting a non-null `app_target` to `KITCHEN`, `SELF_SERVICE`, or `STAFF`. `NULL` is the canonical `NONE` state. Add both fields to the Kysely `TerminalTable` type and to the terminal public representation.

Do **not** create a `terminal_profiles` table. A profile has exactly one owner, lifecycle, credential, active flag, and optimistic-concurrency version: the terminal. Keeping the one optional JSON configuration on that row makes reads for `/auth/me` and terminal-credential lookup single-row operations and follows the existing `terminals` per-row-field convention. `reservation_settings` is deliberately separate because it is an independently managed, location-wide settings aggregate with many fields; this is neither location-wide nor independently addressed.

`device_profile` becomes legacy read-only data. Do not use it for routing, filtering, validation, display of the configured purpose, or new enrollment writes. Do not attempt an automatic backfill: existing arbitrary strings such as `admin-pwa` cannot be mapped safely to the structured contract. Existing terminals start with `app_target = NULL` and `profile_config = NULL` until an authorized administrator explicitly configures them. It may be removed only in a later compatibility-cleanup migration after callers no longer depend on it; this enhancement does not repurpose it.

The two new columns are nullable so an enrolled general-purpose terminal retains today's behavior. Their values are updated atomically with `version = version + 1`; the standard `updated_at` trigger continues to apply.

### 2.2 Profile values

`app_target` and `profile_config` form one discriminated union. `profile_config` must be a JSON object when `app_target` is non-null; `NULL` is required when it is null.

| `app_target` | Exact `profile_config` | Meaning |
| --- | --- | --- |
| `NULL` (`NONE`) | `null` | No defined purpose; preserve the host app's current behavior. |
| `KITCHEN` | `{ "scope": "ALL" }` | Show all eligible Kitchen lines. |
| `KITCHEN` | `{ "scope": "CATEGORY", "category_ids": ["UUID", "..."] }` | Show only lines whose product's `category_id` is selected. |
| `SELF_SERVICE` | `{ "mode": "KIOSK" }` | Open `/:locationId/kiosk`. |
| `SELF_SERVICE` | `{ "mode": "TABLE", "table_id": "UUID" }` | Open `/:locationId/table/:tableId`. |
| `SELF_SERVICE` | `{ "mode": "ORDER_STATUS" }` | Open `/:locationId/status-board`. |
| `STAFF` | `{ "mode": "HOST" }` | Open the Staff app's existing `/host/*` route. |

No other keys are permitted. In particular, an `ALL` Kitchen scope has no `category_ids`, `CATEGORY` has a non-empty array of unique UUIDs, `KIOSK` and `ORDER_STATUS` have no extra keys, and `HOST` has no extra keys. A normal Staff terminal is represented by the `NULL`/`NULL` state, not by a second `STAFF` default mode. This keeps `STAFF` meaningful: it is a forced Host landing rather than a vague application label.

Kitchen scope intentionally reuses the existing organization-scoped `categories` table. A conceptual station such as **Grill** is the administrator-selected set of menu categories, and products already carry `products.category_id`; inventing a `kitchen_stations` aggregate would duplicate catalog grouping and require a second maintenance workflow. Categories need not be active at the moment a profile is saved: archived categories can remain configured and simply have no active products/lines. The Admin picker should normally show active categories.

## 3. API Requirements

All existing identity error envelopes and request IDs remain in use.

### 3.1 Session profile: extend `GET /api/v1/auth/me`

Keep the existing staff-session authentication and all existing response fields. Resolve the terminal row by `actor.terminalId` in the same location-scoped transaction and append these top-level fields:

```json
{
  "staff": { "id": "…" },
  "location_id": "…",
  "terminal_id": "…",
  "organization_id": "…",
  "roles": [],
  "permissions": [],
  "app_target": "KITCHEN",
  "profile_config": { "scope": "CATEGORY", "category_ids": ["…"] }
}
```

For an unconfigured terminal, both added fields are `null`. A missing terminal row is an invalid session invariant and must follow the repository's authenticated-session failure behavior; it must not be silently treated as a profile-less terminal. No new authentication mechanism is introduced for Kitchen or Staff.

### 3.2 Credential-only profile: `GET /api/v1/terminals/me`

Add a credential-only endpoint for an enrolled physical browser that has no staff session.

* **Request:** `GET /api/v1/terminals/me`; the client sends `x-terminal-credential: <credential>`. It sends no `Authorization` header, and a staff or guest token is never accepted as a substitute.
* **Authentication:** parse the header through the existing `terminalCredential(request)` helper, open `app.withLocationTransaction(presentedTerminal.locationId, ...)`, load the terminal by the parsed terminal ID, require `is_active`, and verify the presented credential against `credential_hash` with the same `secretMatchesHash` comparison used by PIN unlock.
* **Success (`200`):**

```json
{
  "terminal_id": "UUID",
  "location_id": "UUID",
  "app_target": "SELF_SERVICE",
  "profile_config": { "mode": "TABLE", "table_id": "UUID" }
}
```

  `app_target` and `profile_config` are both `null` for an unconfigured terminal.
* **Errors:** an absent, malformed, or unparsable credential, an unknown terminal, inactive terminal, location/terminal mismatch embedded in the credential, or hash mismatch returns `401 TERMINAL_UNAUTHENTICATED` with the existing message, `A valid enrolled terminal credential is required.` Do not reveal which validation failed. This endpoint has no body and no permission check; possession of a valid terminal credential is its authorization boundary.

This is intentionally separate from `/auth/me`: a Self-Service kiosk, table tablet, or status display has no staff user to authenticate but still needs a trustworthy terminal identity before it can choose its route.

### 3.3 Admin terminal APIs

Retain and extend the current terminal management surface:

* **`GET /api/v1/terminals`** remains staff-session authenticated and requires `iam.terminals.read`. Each terminal item returns `id`, `location_id`, `name`, `is_active`, `version`, `app_target`, and `profile_config`. It must not expose `credential_hash` or the one-time credential. Omit the legacy `device_profile` from the new public contract.
* **`POST /api/v1/terminals/enroll`** remains staff-session authenticated and requires `iam.terminals.enroll`. Its request is `{ "location_id": "UUID", "name": "string" }`; remove `device_profile` from the accepted body. It creates a profile-less terminal (`app_target` and `profile_config` null) and continues to return the credential exactly once.
* **`PUT /api/v1/terminals/:terminalId/profile`** is staff-session authenticated, requires `iam.terminals.enroll`, and requires `If-Match` with the terminal's current positive integer `version`. `iam.terminals.enroll` is reused rather than creating a new permission: assigning a terminal's application purpose is part of authorizing/provisioning that physical terminal, while `iam.terminals.read` stays read-only.

The PUT body has exactly these required properties:

```json
{
  "app_target": "SELF_SERVICE",
  "profile_config": { "mode": "ORDER_STATUS" }
}
```

`app_target` may be `null` only when `profile_config` is `null`. On success return the updated public terminal and its incremented version. Return `404 NOT_FOUND` when the terminal is not in the actor's current RLS-scoped location. Return `428 PRECONDITION_REQUIRED` for a missing `If-Match`, `400 INVALID_IF_MATCH` for an invalid version, and the project's standard `409 OPTIMISTIC_CONCURRENCY_CONFLICT` with the current public terminal for a stale version.

Validate profile configuration before the update:

* The union in section 2.2 must match exactly; otherwise return `400 VALIDATION_ERROR`.
* For `KITCHEN/CATEGORY`, every distinct `category_id` must exist in `categories` and have `organization_id = actor.organizationId`; otherwise return `400 INVALID_CATEGORY`.
* For `SELF_SERVICE/TABLE`, `table_id` must exist in `tables` and have `location_id = terminal.location_id`; otherwise return `400 INVALID_TABLE`. Do not restrict the saved profile to a table's transient occupancy/cleanliness status.
* The update must use the terminal row's own `location_id` for validation, never a location supplied by the request body.

The existing terminal table RLS and the target-location transaction pattern used by enrollment remain responsible for location isolation. No new permission is added to `permission-catalog.md`.

## 4. Frontend Behavior

### 4.1 Self-Service: enrollment and direct launch

Add terminal support to `apps/self-service` without changing guest URL access.

1. Add `getTerminalCredential()` and `setTerminalCredential()` helpers equivalent to Kitchen's, backed by a dedicated Self-Service `localStorage` key and storing `{ terminal_id, secret }`. Keep guest-session tokens in `sessionStorage` as they are today; do not conflate them with terminal credentials.
2. Add an `EnrollmentScreen` following Kitchen's existing screen and call to `POST /api/v1/terminals/enroll`: an authorized administrator supplies a valid staff session token, location ID, and terminal name; the response credential is stored locally once. Make this setup screen available at the explicit Self-Service route `/enroll-terminal`. It is provisioning UI, not a guest fallback screen.
3. At app bootstrap, when a stored credential exists, call `GET /api/v1/terminals/me` with **only** `x-terminal-credential`. The Self-Service API helper currently automatically adds its guest bearer token, so this lookup must use a terminal-specific fetch helper (or an explicit no-auth option) that does not attach `Authorization`.
4. On a successful response with `app_target = SELF_SERVICE`, replace the current URL with exactly one of:
   * `/${location_id}/kiosk` for `KIOSK`;
   * `/${location_id}/table/${table_id}` for `TABLE`;
   * `/${location_id}/status-board` for `ORDER_STATUS`.
   Use router replacement so Back cannot return a dedicated device to an arbitrary manually entered route.
5. If the credential is absent, retain today's routes and behavior unchanged, including QR/manual table links and the NotFound screen. Do not redirect a guest user to terminal setup. If lookup returns `401`, show a terminal-unavailable/re-enrollment screen on a browser that claimed a stored credential; do not silently fall back to a different location or route. If the valid profile is `NULL` or has a non-`SELF_SERVICE` target, show a non-guest configuration-mismatch screen and do not choose a route.

This makes kiosk, table, and order-status terminals first-class outcomes; the three Self-Service variants receive equal routing support.

### 4.2 Kitchen: category-scoped ticket display

After PIN unlock, Kitchen already fetches `/api/v1/auth/me`. Extend its typed response to consume `app_target` and `profile_config`.

* Continue fetching the existing full ticket feed from `GET /api/v1/locations/:locationId/order-lines?status=HELD,SENT,PREPARING,READY`; do not add an API query parameter or a server-side routing feature.
* Continue fetching `GET /api/v1/products`; its existing representation already includes each product's `category_id`. Add that field to Kitchen's local `Product` type.
* When the resolved profile is `KITCHEN` with `scope = CATEGORY`, filter the fetched lines client-side before grouping tickets, computing All Day, and rendering cards: retain a line only when `productsById.get(line.product_id)?.category_id` is in `category_ids`. Lines for a missing product are excluded rather than leaking into a category-scoped display.
* While this dedicated scope is active, hide/disable the current manual tag-based station selector and disregard its `kitchen_station` value. Category scoping is deterministic configuration, not an operator override. When the profile is `{ scope: "ALL" }`, absent, malformed, or targeted to a different app, preserve the current unfiltered/default Kitchen behavior and existing manual selector exactly.

Client-side filtering is the correct initial boundary: the existing feed already supplies the relevant lines, Kitchen already retrieves the product catalog, and this enhancement is a display-scope feature rather than ticket dispatch. It avoids a new server query contract and preserves other Kitchen consumers. It does not authorize status changes outside the device scope; that is explicitly out of scope below.

### 4.3 Staff: Host automatic landing

After Staff's existing `/auth/me` request succeeds, inspect the added profile fields. When they are exactly `STAFF` plus `{ "mode": "HOST" }`, navigate with replacement to the existing Staff route `/host` (whose route declaration is `/host/*` and renders `HostMode`). Apply this before the normal multiple-mode selector/default selection.

This landing override does not grant reservation access. `HostMode` continues to enforce its existing permission-driven data access; a malformed or unauthorized profile does not bypass staff permissions. For every other profile, retain the present `ModeSwitcher` or single-mode default behavior unchanged.

### 4.4 Admin terminal management UI

Extend the existing **Staff & Roles → Terminals** panel rather than introducing a separate device-management area. Continue using its terminal list and enroll form conventions.

* Display the structured purpose (`No purpose`, `Kitchen / All`, selected categories, `Self-Service / Kiosk`, `Self-Service / <table>`, `Self-Service / Order Status`, or `Staff / Host`) rather than `device_profile` text.
* For users with `iam.terminals.enroll`, provide an edit form for each terminal: app-target selector; Kitchen scope selector and category multi-select; Self-Service mode selector with a table picker only for `TABLE`; and Staff's Host selector. Provide an explicit clear-purpose action that submits null/null.
* Populate categories from the existing category listing and tables from the existing floor/table listing for the active location. Submit the terminal's displayed `version` as `If-Match`, then refresh the terminals query and show the standard conflict/error UI.
* Users with only `iam.terminals.read` can see profile status but cannot change it.

The current enrollment form no longer contains the free-text Device profile input. Profile configuration happens after the one-time credential has been copied, which also makes reconfiguration possible without re-enrollment.

## 5. Acceptance Criteria

1. An administrator can enroll a terminal, assign each profile shape in section 2.2, later change it with optimistic concurrency, or clear it; invalid cross-organization categories and cross-location tables are rejected.
2. `/auth/me` returns the profile associated with the session's terminal, and a staff session on an unconfigured terminal observes null/null without a behavior regression.
3. `GET /api/v1/terminals/me` accepts a valid terminal credential without a staff session and returns only that terminal's location/profile; invalid or inactive credentials uniformly receive `401 TERMINAL_UNAUTHENTICATED`.
4. A configured Self-Service kiosk, table, or order-status browser routes itself to the correct existing screen after credential lookup. A normal QR/manual guest browser without a stored terminal credential behaves as before.
5. A Kitchen category-profile device renders and counts only lines whose products are in its configured categories; `KITCHEN/ALL` and no profile leave today's Kitchen behavior intact.
6. A Staff `STAFF/HOST` terminal lands at `/host`; all other Staff terminals retain their current landing behavior.
7. Profile changes take effect on the next application bootstrap or next authenticated `/auth/me`/`/terminals/me` fetch; no cache, remote command, or forced refresh mechanism is required in this enhancement.

## 6. Non-Goals

* Remote/mobile-device-management fleet operations, device inventory agents, remote wipe, or device-health management.
* Hardware or operating-system provisioning: kiosk lockdown, browser policy, screen brightness, peripheral configuration, auto-start, or physical-display settings.
* Kitchen ticket routing, reassignment, load balancing, or exclusivity across multiple devices. Category scope is display filtering only; it does not send a ticket to a Grill tablet or prevent another terminal from seeing/updating it.
* Changes to terminal enrollment credential generation/storage, credential hashing, staff PIN unlock, PIN backoff, staff session issuance, or existing authorization. The feature only layers profile lookup on the established mechanisms.
* A generic cross-PWA launcher. The installed/opened PWA remains responsible for applying the relevant target; a profile does not install, start, or switch another application.

## 7. Open Questions

None. The current routes, terminal credential security path, catalog/category ownership, table location ownership, and Staff Host route provide enough information to make the above decisions without deferring implementation choices.
