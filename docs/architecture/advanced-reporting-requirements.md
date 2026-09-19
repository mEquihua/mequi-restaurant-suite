# Advanced Reporting Requirements

This document defines the implementation requirements for the `Advanced Reporting` ENHANCEMENTS backlog item in Restaurant Suite. It extends, rather than replaces, [Reports Module Requirements (Foundation Scope)](./reports-module-requirements.md).

**Constraint on scope**: Restaurant Suite reporting remains a deliberately small set of fixed, parameterized REST read models. It is not a BI platform, analytical warehouse, or generic query-builder.

## 1. What Is Newly Buildable

The Foundation document deferred Inventory Costing, Labor Cost & Hours, Customer-Level Reporting, and Complex Multi-Location BI. Since then, Inventory & Recipes and Employee Clocking shipped. The resulting scope is:

| Formerly deferred item | Decision | Reason |
| --- | --- | --- |
| Labor hours | Build now | `timeclock_shifts` supplies location, staff, `clocked_in_at`, `clocked_out_at`, and closed-shift status. |
| Labor cost | Do not build | No migration or `staff` field stores a wage, hourly rate, or pay rate. |
| Inventory costing / COGS | Do not build | `ingredients`, `recipe_lines`, `ingredient_stock`, and `stock_adjustments` contain quantities only; none has a unit cost. |
| Customer-level reporting | Do not build here | The necessary analytics belongs to Loyalty/CRM product scope, not this operational reports increment. |
| Complex multi-location BI | Do not build | The existing organization routes already provide the intended bounded per-location aggregate response; no cross-location BI model is introduced. |

Sales by Channel and Covers are also included here. They were explicit minimum requirements in `idea.md` section 28 but were neither implemented nor listed as intentionally deferred by the Foundation document.

---

## 2. Advanced Reports

Each report is a discrete REST endpoint and has both the established location-scoped and organization-aggregate forms.

### 2.1 Sales by Channel

* **Reads tables**: `orders`, `order_lines`, `accounts`, `account_discounts`, `payments`, `refunds`, `locations`.
* **Groups by**: `orders.order_type`, emitting the canonical enum value: `DINE_IN`, `TAKEOUT`, `PICKUP`, `DELIVERY`, or `TABLE_SELF_ORDER`. Do not derive channel from a UI surface or fulfillment row; `orders.order_type` is the authoritative classification.
* **Filters**: `location_id`, `from`/`to` against `orders.created_at`; include only orders with at least one eligible line. Exclude order lines where `order_lines.status IN ('VOIDED', 'CANCELLED', 'REJECTED')`; exclude cancelled orders. An absent channel has no row rather than a fabricated zero row.
* **Value definitions**:
  * *Order Count*: `COUNT(DISTINCT orders.id)` after the eligibility rules above.
  * *Gross Sales*: `SUM(order_lines.quantity * order_lines.unit_price)` across eligible lines, in the existing integer minor-currency unit.
  * *Discounts*: Account-level discounts allocated deterministically to the eligible order lines for their account in proportion to each line's gross value. Allocate in integer minor units with a deterministic remainder rule (largest fractional remainder, then `order_lines.id` ascending) so child allocations always equal the source discount exactly. `account_discounts.computed_amount` is the source value; its own report-time filter is unchanged.
  * *Refunds*: Keep refunds as a distinct column, never silently netting them out. A refund is recognized by `refunds.created_at` in the requested range, joined through its payment's account, then allocated across that account's eligible non-void/non-cancelled lines using the same gross-value and deterministic-remainder rule. This intentionally permits a refund row for a channel whose originating order was outside the selected order-created range: refunds are events, just as in Sales by Day.
  * *Net Sales*: `Gross Sales - Discounts - Refunds` after those allocations.
* **Allocation boundary**: For account-level discounts and refunds, the allocation denominator is every eligible line on that account, not only lines whose order was created in the current report range. This prevents a split account containing multiple order types from double-counting an account-level amount when reports are run for different date ranges.
* **Ordering**: descending `net_sales`, then the enum channel value ascending.

### 2.2 Covers / Guest Count by Day

* **Reads tables**: `visits`, `locations`.
* **Settlement decision**: A cover is counted only when its visit has actually completed: `visits.status = 'COMPLETED'` and `visits.closed_at IS NOT NULL`. `closed_at` is the report's settlement moment. The visit-close workflow permits this only after all accounts are paid/closed and all lines are terminal, so counting visits merely opened in the period would overstate covers for abandoned or cancelled tables.
* **Groups by**: local day `DATE(visits.closed_at AT TIME ZONE locations.timezone)`, using the same location-timezone business-day convention as Sales by Day.
* **Filters**: `location_id`; `visits.closed_at >= from AND visits.closed_at < to`; completed visits only. A visit with `guest_count IS NULL` remains in `completed_visit_count` but is excluded from cover totals and the cover average, because missing is not zero guests. Ignore a negative `guest_count` defensively if legacy/bad data exists; the implementation must not turn it into negative covers.
* **Value definitions**:
  * *Completed Visit Count*: count of qualifying completed visits.
  * *Visits with Guest Count*: count of qualifying visits whose `guest_count >= 0` is recorded.
  * *Total Covers*: `SUM(guest_count)` over qualifying visits with a recorded non-negative guest count; return `0` when none is recorded.
  * *Average Covers per Visit*: `Total Covers / Visits with Guest Count`; return `null`, not zero, when no qualifying visit recorded a guest count.
* **Ordering**: local day ascending.

### 2.3 Labor Hours

* **Reads tables**: `timeclock_shifts`, `staff`, `locations`.
* **Groups by**: `staff.id`, `staff.first_name`, `staff.last_name`, with a required aggregate location-total row or field in the same response. The per-staff rows and aggregate must be generated from the identical eligible-shift set.
* **Filters**: `location_id`; `clocked_in_at >= from AND clocked_in_at < to`; only `timeclock_shifts.status = 'CLOSED'` with a real `clocked_out_at`. Exclude open shifts and malformed rows where `clocked_out_at < clocked_in_at`.
* **Value definitions**:
  * *Shift Count*: count of eligible shifts.
  * *Hours Worked*: `SUM(EXTRACT(EPOCH FROM (clocked_out_at - clocked_in_at))) / 3600`. Return sufficient precision for the API (decimal hours); the Admin app may display a rounded value but must not alter the underlying calculation.
  * *Location Total Hours*: the same duration sum over all eligible staff shifts at that location and period.
* **Boundary rule**: A shift is wholly included or excluded by `clocked_in_at`; do not prorate a shift spanning a report boundary. This exactly follows the requested filter convention and makes the result reproducible.
* **No money field**: This report must not expose, estimate, or label any labor-cost dollar value.

---

## 3. Endpoints and Shared Query-Parameter Convention

Add these exact routes using the existing `report(...)` and `orgReport(...)` helper patterns in `services/api/src/modules/reports/route.ts`.

| Report | Per-location | Organization aggregate |
| --- | --- | --- |
| Sales by Channel | `GET /api/v1/locations/:locationId/reports/sales/by-channel` | `GET /api/v1/organizations/:orgId/reports/sales/by-channel` |
| Covers / Guest Count | `GET /api/v1/locations/:locationId/reports/covers/by-day` | `GET /api/v1/organizations/:orgId/reports/covers/by-day` |
| Labor Hours | `GET /api/v1/locations/:locationId/reports/labor/hours` | `GET /api/v1/organizations/:orgId/reports/labor/hours` |

All six endpoints reuse the Foundation shared convention:

* **`from` and `to`**: required ISO 8601 DateTime range, interpreted as `[from, to)`.
* **Location route**: `:locationId` is the session location and is enforced by the existing location-scoping guard.
* **Organization route**: requires exactly one of `all=true` or `location_ids=<comma-separated UUIDs>` and returns the established per-location grouping, rather than collapsing locations into a new BI roll-up.
* **`limit` / `offset`**: accepted by the shared schemas but unused by these bounded groupings; the report queries must not paginate them.
* **`format`**: supports `json` (default) and `csv` for all three reports on both route variants.

The last point intentionally closes the current inconsistency for these new reports: the location helper already converts `format=csv` via `toCsv(data)`, while the existing organization helper allows JSON only. Extend the organization CSV path for these reports by flattening its established location groups into rows prefixed with `location_id` and `location_name`, then passing that flat array through the same `toCsv` mechanism and response headers. JSON keeps the current `{ data: [{ location_id, location_name, data }] }` shape. This does not retroactively alter existing organization reports; their CSV gap is pre-existing and remains outside this backlog item.

### 3.1 Permissions

* Sales by Channel and Covers require **`reports.sales.read`**. The catalog already defines this permission for sales summaries, channel breakdowns, and end-of-day metrics; Sales by Employee already exposes staff-attributed financial data under it.
* Labor Hours requires **`reports.audit.read`**. Hours reveal internal staff attendance and manager activity, not a sales metric. This permission already protects sensitive operational/audit data such as voids, refunds, and manager overrides. No new permission is needed, and `reports.sales.read` must not grant Labor Hours.

---

## 4. Core Correctness Rules

The Foundation correctness rules apply unchanged, with these report-specific requirements:

* **Location timezones**: Covers-by-day must bucket with `locations.timezone`, never UTC. Sales by Channel and Labor Hours do not time-bucket their results, but their range comparisons retain timestamp semantics.
* **Voids and cancellations**: Sales by Channel must exclude voided/cancelled/rejected order lines from quantity and monetary bases. Cancelled orders must not count as orders.
* **Refunds vs. net/gross**: Sales by Channel returns Refunds separately and calculates Net Sales as Gross Sales minus Discounts minus Refunds. Refunds must be attributed with the deterministic allocation described above, never discarded.
* **Location isolation**: All reads execute in the existing location transaction/RLS context. Organization aggregation must invoke the query separately for each authorized selected location, matching `orgReport(...)`; it must not issue a cross-location query that bypasses that boundary.
* **Currency**: Sales values remain integer minor-currency amounts, matching existing report responses. Do not introduce floating-point money values.

---

## 5. Admin App UI

Keep the existing `/reports` screen and its report-card/table pattern in `apps/admin/src/App.tsx`; do not create a separate reporting screen. Add these entries to the existing `reportEndpoints` list so they inherit its shared date controls, selected-location/all-locations behavior, query execution, and `ReportTable` rendering:

* **Sales by channel** — beside the current sales report cards, visible with `reports.sales.read`.
* **Covers by day** — beside the sales/operational summary cards, visible with `reports.sales.read`.
* **Labor hours** — an operational staff-activity card, visible only with `reports.audit.read`.

For the organization routes, retain the existing nested table per `location_name`. The Labor Hours card must render staff rows plus the prescribed per-location aggregate using the same list/table presentation, without introducing a payroll dashboard.

---

## 6. Non-Goals

* **Dollar-figure Labor Cost**: The data model has no wage, hourly-rate, or pay-rate field in `staff`, `timeclock_shifts`, or any migration. Adding one would be a real HR/payroll product decision, not a reporting inference. It requires explicit product sign-off and is not authorized by this item.
* **Dollar-figure theoretical COGS / inventory costing**: `ingredients`, `recipe_lines`, `ingredient_stock`, and `stock_adjustments` have no cost-per-unit or purchase-price data. Further, Inventory & Recipes already provides its own theoretical-versus-actual **consumption** comparison in ingredient units. This report must neither duplicate that existing feature nor invent dollar values from quantity-only data.
* **Preparation Time**: `order_lines` stores only the current `status` and generic `created_at`/`updated_at`; it has no `sent_at`/`ready_at` pair. `audit_events` only holds generic action/version/reason metadata and is not a per-status-transition timestamp history. Preparation-time reporting therefore needs new status-transition instrumentation as a separately approved future feature, not a retrospective query in this item.
* **Customer-level reporting**: Top spenders, purchase history, loyalty behavior, and recurring-customer analytics remain Loyalty/CRM analytics. The Foundation document explicitly deferred them, and the presence of customer/loyalty tables does not make them an appropriate expansion of this reports increment.
* **Generic BI or query builder**: No arbitrary dimensions, saved queries, analytical warehouse, charting engine, or broad cross-location dashboard is introduced. The bounded organization endpoints above are the only multi-location behavior.
* **Changes to existing report semantics**: This item does not revise existing Foundation report formulas, routes, permissions, or their organization-CSV behavior.

---

## 7. Open Questions

None. The current schema, route conventions, and product requirements are sufficient to resolve the implementation decisions above. Future requests for wage tracking, ingredient valuation, preparation-event timestamps, or CRM analytics are separate product-scope decisions, not open implementation questions for this item.
