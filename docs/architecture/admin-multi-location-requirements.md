# Admin Multi-Location Support Requirements

This document is the precise, implementation-ready requirements reference for supporting multi-location management within the Restaurant Admin application, fulfilling the capabilities described in `idea.md` section 29. It translates the product requirement into concrete, secure mechanics that align with the existing Foundation session architecture.

## 1. Data Model Alignment (Shared vs. Varies)

Section 29 of `idea.md` requires that certain elements are shared across the organization while others can vary per location, without forcing the whole business to be duplicated. 

This requirement is **already largely satisfied** by the existing Foundation schema:
*   **Shared (Organization-Scoped):** `products`, `categories`, `modifier_groups`, `modifiers`, `staff`, and `roles` are all organization-wide. A product created once exists for the entire organization.
*   **Varies (Location-Scoped):** `location_price_overrides` and `availability_rules` already provide the mechanism for a shared catalog to have location-specific pricing and availability. `tables`, `delivery_zones`, and `ingredient_stock` (inventory) are inherently location-scoped.

No major data model redesign is required to support this. The challenge is entirely about how a manager with organization-wide access interacts with this data across multiple locations from a single Admin UI, given the strict location-binding of backend sessions.

## 2. Recommended Mechanism: Hybrid Read-Aggregation & Client-Side Context Switching

Given the complexity and security implications of altering the established three-session architecture (staff/guest/customer) and the `actor.locationId` enforcement model, we will adopt the narrowest approach that delivers the required value (Option D + Client-Side Option A).

### 2.1 Multi-Location for Reads & Reporting (Option D)
For pure reporting and read-only cross-location aggregation (e.g., the Reports module or a future organization dashboard), we will **not** change the session model. The admin's session remains bound to a single "home" location.
*   **Mechanics:** Reporting endpoints will accept a list of `location_ids` (or an `all` flag) as query parameters.
*   **Required validation — organization membership:** `app.withLocationTransaction(locationId, ...)` (`services/api/src/shared/database.ts`) performs **no validation whatsoever** that `locationId` exists or belongs to any particular organization — it only sets the `app.current_location_id` RLS session variable and runs the transaction. It is not a security boundary by itself. Before looping the aggregation, the endpoint MUST first resolve `SELECT id FROM locations WHERE organization_id = actor.organizationId` and intersect it with the requested `location_ids` (or substitute that full list when `all` is requested), rejecting or silently dropping any requested id that isn't in that set. Skipping this step would let a caller request an arbitrary location id belonging to a completely different organization and have it silently included in the aggregation, since most location-scoped RLS policies in this codebase check `location_id` alone with no accompanying `organization_id` check.
*   **Execution:** Instead of issuing a single cross-location SQL query, the backend will iterate over the validated location IDs, executing `app.withLocationTransaction(locId)` for each one sequentially or in parallel. The results will be aggregated in application code before being returned to the client.
*   **Benefits:** This perfectly preserves the integrity of `withLocationTransaction` and Row-Level Security, prevents leaking data across isolation boundaries (once the organization-membership check above is in place), and requires zero changes to the `staff_sessions` or `terminals` schema.

### 2.2 Multi-Location for Writes (Client-Side "Virtual Terminals")
For write operations (e.g., editing `location_price_overrides`, delivery zones, or inventory), we will defer any backend concept of a "stateless org-level session" or "session location switching." The backend endpoints for these entities will remain strictly single-location.
*   **Mechanics:** The Admin PWA will be enhanced to manage multiple terminal credentials in `localStorage` (a mapping of `locationId -> terminalCredential`).
*   **Execution:** When a manager needs to switch the Admin app to manage Location B while logged into Location A, the frontend will prompt them to enter their PIN. It will then call `POST /api/v1/auth/pin-unlock` using Location B's saved terminal credential, effectively replacing their active `Bearer` token with a new session bound to Location B. This part requires no backend change — `pin-unlock` is already terminal-scoped, not session-scoped.
*   **Required backend change — cross-location enrollment:** `POST /api/v1/terminals/enroll` currently rejects any `location_id` other than the caller's own `actor.locationId` (`services/api/src/modules/identity/route.ts`, the `LOCATION_SCOPE_DENIED` check right after `requirePermission(actor, 'iam.terminals.enroll')`). As written today, a session bound to Location A **cannot** enroll a terminal for Location B at all — the "seamless background enrollment" this document originally proposed does not work against the real endpoint. This must change: relax that check so a staff member holding `iam.terminals.enroll` may enroll a terminal for **any location in their own organization** (`SELECT 1 FROM locations WHERE id = body.location_id AND organization_id = actor.organizationId`), not only their session's current location. This is a real, deliberate loosening of an existing security boundary — call it out explicitly in the implementation PR, not as an incidental side effect. It is consistent with, not beyond, the existing gap noted in section 3 (`effectivePermissions` already grants a permission org-wide the moment any `staff_roles` row confers it, with no location filtering) — this document is not introducing a new class of over-broad access, only making the one that already exists usable for enrollment.
*   **Enrollment UX:** If the manager does not yet have a virtual terminal enrolled for Location B on their browser, the Admin UI calls the now-relaxed `POST /api/v1/terminals/enroll` for Location B using their *current* session (still bound to Location A), saves the returned credential locally, and immediately prompts for the PIN to unlock it via `pin-unlock`.
*   **Benefits:** Aside from the one relaxation above, this leverages the existing, battle-tested terminal enrollment and PIN-unlock flows without inventing new auth paradigms or weakening the security of PIN re-authentication.

## 3. The Role of `staff_roles.location_id`

Currently, `staff_roles.location_id` has no effect on permission resolution (`effectivePermissions` and `effectiveRoles` do not filter by it). A manager granted a role effectively holds those permissions organization-wide.

*   **Decision:** We explicitly declare the enforcement of `staff_roles.location_id` as **out of scope** for this iteration. 
*   **Justification:** Given that the system relies on physical/virtual terminal isolation (you can only act on Location B if you have a terminal credential for Location B) and that true multi-location operators currently treat managers as org-wide trusted actors, introducing granular per-location permission filtering now is unnecessary complexity. We accept this as a known gap. When Reports aggregate "all" locations, they will aggregate across all locations belonging to `staff.organization_id`.

## 4. Admin App UI Impact

The `apps/admin/src/App.tsx` shell will introduce a persistent **Location Switcher** component in the global sidebar, driven by the user's effective access (all locations in their organization).

Its behavior will diverge based on the active screen:
*   **Read-Aggregating Screens (Reports):** The switcher allows selecting "All Locations", "Several Selected", or "One Location". Changing the selection updates the query parameters sent to the Reports API, triggering a refetch and re-render without a session change.
*   **Single-Location Write Screens (Menu, Inventory, Delivery Zones, etc.):** The switcher operates in a strictly single-location mode. Selecting "All Locations" is disabled or hides write controls. If the user selects a *different* single location from the dropdown, the app intercepts the navigation, clears the active session token, and presents the PIN Unlock screen for the target location's virtual terminal.

## 5. Non-Goals

To satisfy the `idea.md` section 130 simplicity test, the following are explicitly out of scope and must not be built as part of this effort:
*   **True Real-Time Cross-Location Inventory Transfers:** Moving stock directly between locations requires complex double-entry accounting and transit states.
*   **Org-Wide Bulk Edit Endpoints:** E.g., updating prices across 50 locations in a single API call. If a manager needs to update prices everywhere, they will use the UI to switch locations and update them one by one, or update the shared `base_price` on the product itself. Building a bulk-management ERP is turning Restaurant Suite into a different product.
*   **Stateless Organization-Level Admin Sessions:** We will not introduce a fourth session type (Option C) that bypasses `locationId` enforcement.

## 6. Resolved Design Questions

1.  **Terminal limits (resolved):** `terminals` (`services/api/migrations/002_identity.js`) has no unique constraint or cap on how many rows may exist per `location_id`. A manager accumulating one virtual terminal per location they administer is not a schema concern. No change needed.
2.  **Aggregation performance (resolved):** Iterating `N` sequential/parallel single-location transactions for Reports is accepted as sufficient for this V1 Foundation iteration — idea.md does not scope this project for organizations with dozens of locations, and this is a straightforward place to optimize later (e.g., a single query with `location_id = ANY($1)` under a relaxed RLS policy) if it ever becomes a real bottleneck. Not a blocker now.
3.  **Cross-location conflict / version isolation (resolved, not actually ambiguous):** `products.version` and `location_price_overrides.version` already live on two separate tables with two separate rows and are never conflated in any existing endpoint response (`services/api/src/modules/menu/route.ts` returns them as distinct fields on distinct resources). Admin A editing a location's price override and Admin B editing the shared product name are already fully independent, optimistic-concurrency-protected operations under the current schema — no UI or backend change is required for this beyond what already exists.
