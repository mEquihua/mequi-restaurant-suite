# Foundation Permission Catalog

This document establishes the authoritative, canonical permission catalog for Restaurant Suite's **Foundation** scope. It unifies functional requirements from `idea.md` (sections 22–23), entity models from `docs/architecture/data-model-foundation.md`, and API contracts from `docs/contracts/openapi-foundation-draft.md`.

All permissions defined herein replace earlier draft names and MUST be strictly enforced across Fastify API endpoints, policy decision checks, UI visibility rules, and seed data role assignments.

---

## 1. Naming Standard & Principles

Every permission name in Restaurant Suite strictly adheres to a three-segment namespace:

$$\text{\texttt{<domain>.<resource>.<action>}}$$

### Structure Rules
1. **`<domain>`**: The primary operational module (`iam`, `menu`, `floor`, `module_center`, `orders`, `accounts`, `payments`, `kitchen`, `reports`).
2. **`<resource>`**: The specific aggregate or target noun in plural form (`staff`, `roles`, `terminals`, `catalog`, `products`, `prices`, `availability`, `layout`, `tables`, `sections`, `visits`, `orders`, `lines`, `accounts`, `discounts`, `payments`, `refunds`, `cash`, `tickets`, `sales`, `audit`).
3. **`<action>`**: The specific capability or lifecycle verb (`read`, `create`, `update`, `write`, `enroll`, `apply`, `hold`, `send`, `void`, `cancel`, `transfer`, `split`, `reopen`, `reconcile`, `update_status`, `assign`, `read_all`, `override`, `void_override`, `cancel_override`, `apply_override`).

---

## 2. Key Architectural Decisions & Naming Rationale

### 2.1 Resolution of Draft Inconsistencies
The initial OpenAPI contract draft (`openapi-foundation-draft.md`) contained inconsistent permission names such as `permissions.grant` (missing domain/resource context), `kitchen.update_status` (resource implicit), and mixed verb/noun structures like `tables.status.update`.

These have been standardized to predictable, domain-first keys (e.g. `iam.roles.update`, `kitchen.tickets.update_status`, `floor.tables.update_status`). This prevents rule collision, simplifies RBAC policy matching in `services/api`, and ensures reliable code generation.

### 2.2 Manager Override Separation (ADR 0001 §7 & `idea.md` §23)
In restaurant operations, baseline actions and exception actions carry fundamentally different risk profiles:
- **Routine Line Void (`orders.lines.void`)**: A waiter or cashier voiding a line *before* it has been sent to the kitchen (e.g., misclick during order entry). This carries no inventory loss or waste.
- **Post-Fulfillment Void / Override (`orders.lines.void_override`)**: Voiding an order line *after* it has entered `PREPARING`, `READY`, or `FULFILLED` states. This incurs food cost and physical stock variance.

Rather than granting low-tier roles blanket void or cancellation rights, or elevating user roles dynamically, Restaurant Suite separates routine actions from override actions:
- Base roles (Waiter, Cashier) hold routine permissions (`orders.lines.void`, `accounts.discounts.apply`).
- When an operation exceeds policy thresholds (e.g. voiding a cooked item, applying a 50% discount, issuing a historical refund), the PWA prompts for a Manager PIN.
- The backend validates the approving staff member's credentials against the corresponding override permission (`orders.lines.void_override`, `accounts.discounts.apply_override`, `payments.refunds.override`).
- The operation commits under the original session while writing an immutable record to `audit_events` linking both the operating staff member and the authorizing manager.

---

## 3. Foundation Permission Catalog

### 3.1 IAM — Identity & Access Management (`iam`)
Manages staff profiles, system/custom roles, permission grants, and physical device enrollment.

| Permission Name | Description |
| --- | --- |
| `iam.terminals.enroll` | Authorize and enroll a new physical hardware terminal into a location. |
| `iam.terminals.read` | View the list and operational status of enrolled hardware terminals. |
| `iam.staff.read` | View staff member profiles, shift statuses, and role assignments. |
| `iam.staff.create` | Create new staff accounts and set initial PIN credentials. |
| `iam.staff.update` | Update staff profiles, PINs, active statuses, and assigned roles. |
| `iam.roles.read` | List system role templates and custom role definitions with their granted permissions. |
| `iam.roles.update` | Create or update role definitions and modify role permission mappings. |

### 3.2 Menu & Catalog (`menu`)
Manages products, categories, variants, modifiers, location pricing overrides, and real-time item stock availability (86ing).

| Permission Name | Description |
| --- | --- |
| `menu.catalog.read` | View categories, products, variants, modifier groups, and combo configurations. |
| `menu.products.write` | Create, edit, duplicate, and archive catalog categories, products, variants, and modifiers. |
| `menu.prices.update` | Create and modify location-specific price overrides for products and modifiers. |
| `menu.availability.update` | Change real-time item availability status (Available, Exhausted / 86'd, Hidden, Scheduled). |

### 3.3 Floor & Tables (`floor`)
Manages physical layout, dining areas, table arrangements, seating section assignments, and cleanliness status.

| Permission Name | Description |
| --- | --- |
| `floor.layout.read` | View floor maps, dining areas, table locations, and active seating layouts. |
| `floor.layout.write` | Create, edit, position, or archive dining areas, physical tables, and layout geometry. |
| `floor.tables.update_status` | Update real-time table occupancy/readiness state (Needs Cleaning, Available, Out of Service). |
| `floor.sections.assign` | Assign waiters and staff members to floor sections and table groups. |

### 3.4 Module Center (`module_center`)
Manages the owner-facing, per-location registry of active Restaurant Suite capabilities.

| Permission Name | Description |
| --- | --- |
| `module_center.modules.read` | View the fixed capability catalog and its current status for a location. |
| `module_center.modules.write` | Activate, pause, deactivate, or flag a location capability for attention. |

### 3.5 Orders & Visits (`orders`)
Manages table visits, guest seating, order draft creation, line additions, kitchen firing, item voids, and order cancellations.

| Permission Name | Description |
| --- | --- |
| `orders.visits.create` | Open a new visit session for a table or direct channel and record guest party size. |
| `orders.visits.close` | Close an active visit session following full account settlement. |
| `orders.visits.read_all` | View visits, open orders, and table states assigned to other staff members or sections. |
| `orders.visits.transfer` | Move or transfer a visit, table, or order lines to another table or server. |
| `orders.orders.create` | Create a new order aggregate for an active visit or direct channel. |
| `orders.lines.add` | Add item lines, variants, modifiers, seat assignments, and course notes to an order. |
| `orders.lines.hold` | Place order lines on hold to delay kitchen firing. |
| `orders.lines.send` | Fire/send held or draft order lines to kitchen display stations. |
| `orders.lines.void` | Void draft or un-sent order lines before kitchen preparation has started. |
| `orders.lines.void_override` | Authorize manager override to void sent, preparing, or fulfilled order lines. |
| `orders.orders.cancel` | Cancel an un-fired draft order aggregate. |
| `orders.orders.cancel_override` | Authorize manager override to cancel an active, sent, or partially prepared order aggregate. |

### 3.6 Accounts (`accounts`)
Manages financial guest accounts, seat/check splitting, account reopening, and promotional discounts.

| Permission Name | Description |
| --- | --- |
| `accounts.accounts.create` | Create guest sub-accounts for an active visit session. |
| `accounts.accounts.split` | Split accounts by seat, item, or equal monetary fractions. |
| `accounts.accounts.reopen` | Reopen a closed or settled account for adjustments or corrections. |
| `accounts.discounts.apply` | Apply standard item-level or account-level discounts and promotions. |
| `accounts.discounts.apply_override` | Authorize manager override for custom discounts or discounts exceeding standard staff caps. |

### 3.7 Payments & Cash (`payments`)
Manages payment recording (card/cash), refunds, manual cash drawer opening, and shift cash reconciliation.

| Permission Name | Description |
| --- | --- |
| `payments.payments.create` | Process and record cash, card, or external payments against an open account. |
| `payments.refunds.create` | Issue standard payment refunds on recent open transactions within cashier limits. |
| `payments.refunds.override` | Authorize manager override for high-value, unlinked, or historical payment refunds. |
| `payments.cash.open_drawer` | Trigger manual cash drawer kick outside a completed payment transaction. |
| `payments.cash.reconcile` | Perform cash float verification, cash drops, shift close counts, and drawer reconciliation. |

### 3.8 Kitchen Display (`kitchen`)
Manages ticket queues and fulfillment state transitions on Kitchen Display System (KDS) terminals.

| Permission Name | Description |
| --- | --- |
| `kitchen.tickets.read` | View kitchen display station queues, order line tickets, and prep timers. |
| `kitchen.tickets.update_status` | Transition order line fulfillment states (Preparing, Ready, Fulfilled, Recalled). |

### 3.9 Reports (`reports`)
Manages read access to operational, financial, shift, and security audit reports.

| Permission Name | Description |
| --- | --- |
| `reports.sales.read` | View sales summaries, channel breakdowns, revenue metrics, tax tallies, and end-of-day reports. |
| `reports.audit.read` | View immutable security audit logs, void/cancellation logs, refund histories, and manager override reports. |

---

## 4. Default Seed Data Permission Matrix

The table below defines the canonical default permission assignments seeded into system role templates (`Owner`, `Manager`, `Waiter`, `Cashier`, `Host`, `Kitchen`) upon initial database bootstrap.

$$\text{\textbf{Legend: }}\mathbf{X} = \text{Granted by default} \quad \vert \quad \text{Blank} = \text{Not granted by default}$$

| Domain | Permission Name | Owner | Manager | Waiter | Cashier | Host | Kitchen |
| --- | --- | :---: | :---: | :---: | :---: | :---: | :---: |
| **IAM** | `iam.terminals.enroll` | **X** | **X** | | | | |
| | `iam.terminals.read` | **X** | **X** | | | | |
| | `iam.staff.read` | **X** | **X** | | | | |
| | `iam.staff.create` | **X** | **X** | | | | |
| | `iam.staff.update` | **X** | **X** | | | | |
| | `iam.roles.read` | **X** | **X** | | | | |
| | `iam.roles.update` | **X** | **X** | | | | |
| **Menu** | `menu.catalog.read` | **X** | **X** | **X** | **X** | **X** | **X** |
| | `menu.products.write` | **X** | **X** | | | | |
| | `menu.prices.update` | **X** | **X** | | | | |
| | `menu.availability.update` | **X** | **X** | | | | **X** |
| **Floor** | `floor.layout.read` | **X** | **X** | **X** | **X** | **X** | |
| | `floor.layout.write` | **X** | **X** | | | | |
| | `floor.tables.update_status` | **X** | **X** | **X** | **X** | **X** | |
| | `floor.sections.assign` | **X** | **X** | | | **X** | |
| **Module Center** | `module_center.modules.read` | **X** | **X** | | | | |
| | `module_center.modules.write` | **X** | **X** | | | | |
| **Orders** | `orders.visits.create` | **X** | **X** | **X** | **X** | **X** | |
| | `orders.visits.close` | **X** | **X** | **X** | **X** | **X** | |
| | `orders.visits.read_all` | **X** | **X** | | **X** | **X** | |
| | `orders.visits.transfer` | **X** | **X** | **X** | **X** | | |
| | `orders.orders.create` | **X** | **X** | **X** | **X** | | |
| | `orders.lines.add` | **X** | **X** | **X** | **X** | | |
| | `orders.lines.hold` | **X** | **X** | **X** | **X** | | |
| | `orders.lines.send` | **X** | **X** | **X** | **X** | | |
| | `orders.lines.void` | **X** | **X** | **X** | **X** | | |
| | `orders.lines.void_override` | **X** | **X** | | | | |
| | `orders.orders.cancel` | **X** | **X** | **X** | **X** | | |
| | `orders.orders.cancel_override` | **X** | **X** | | | | |
| **Accounts**| `accounts.accounts.create` | **X** | **X** | **X** | **X** | | |
| | `accounts.accounts.split` | **X** | **X** | **X** | **X** | | |
| | `accounts.accounts.reopen` | **X** | **X** | | **X** | | |
| | `accounts.discounts.apply` | **X** | **X** | **X** | **X** | | |
| | `accounts.discounts.apply_override`| **X** | **X** | | | | |
| **Payments**| `payments.payments.create` | **X** | **X** | **X** | **X** | | |
| | `payments.refunds.create` | **X** | **X** | | **X** | | |
| | `payments.refunds.override` | **X** | **X** | | | | |
| | `payments.cash.open_drawer` | **X** | **X** | | **X** | | |
| | `payments.cash.reconcile` | **X** | **X** | | **X** | | |
| **Kitchen** | `kitchen.tickets.read` | **X** | **X** | | | | **X** |
| | `kitchen.tickets.update_status` | **X** | **X** | | | | **X** |
| **Reports** | `reports.sales.read` | **X** | **X** | | **X** | | |
| | `reports.audit.read` | **X** | **X** | | | | |

---


### 4.7 Fulfillment (New)
| Permission | Description |
| :--- | :--- |
| `orders.fulfillment.dispatch` | Dispatch a delivery order |
| `orders.fulfillment.deliver` | Mark a delivery order as delivered |

### 4.8 Delivery Zones (New)
| Permission | Description |
| :--- | :--- |
| `delivery.zones.read` | View a location's delivery zones (name, fee, minimum order amount, active state). |
| `delivery.zones.write` | Create, edit, and activate/deactivate a location's delivery zones. |
### 4.9 Inventory
| Permission Name | Description |
| :--- | :--- |
| `inventory.ingredients.read` | View the organization's ingredient catalog. |
| `inventory.ingredients.write` | Create and edit ingredients in the catalog. |
| `inventory.recipes.read` | View recipe mapping lines for products and modifiers. |
| `inventory.recipes.write` | Create, edit, and delete recipe mapping lines. |
| `inventory.stock.read` | View location stock levels, thresholds, and adjustment histories. |
| `inventory.stock.adjust` | Perform manual inventory counts, adjusting on-hand quantities and logging waste. |

## 5. Out-of-Scope Domains & Deferred Modules

To preserve modular architectural boundaries and prevent premature schema complexity, permissions for domains outside the Foundation scope are **deliberately omitted** from this document:

- **`inventory`** (Receiving, vendor management, multi-location transfers, and advanced costing — theoretical inventory and stock adjustments are now built, see section 4.9)
- **`loyalty`** (Customer rewards, points accumulation, coupon validation)
- **`reservations`** (Table booking schedules, waitlist management, deposit collection)
- **`delivery`** (Driver dispatching, aggregator channel integration — zone rules and minimum-order enforcement are now built, see section 4.8)
- **`self-service` / `kiosk`** (Kiosk hardware pairing, QR customer session parameters)

When these modules are built in subsequent development phases, each module will define its own permission catalog following the strict `<domain>.<resource>.<action>` naming standard established here.
