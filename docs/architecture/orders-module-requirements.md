# Orders, Visits, and Accounts Module Requirements

This document is the precise, implementation-ready requirements reference for the core Orders/Visits/Accounts backend module of Restaurant Suite. It translates the product specification, data model foundation, permission catalog, and API contract review into concrete engineering requirements.

## 1. Explicit Commands

The module exposes explicit, intent-based commands (RPC-style over REST) rather than generic CRUD operations. The client must never dictate prices, financial amounts, or final payment status.

### Visit & Table Commands
* **Open a Visit / Seat a Table** (`POST /api/v1/locations/{loc_id}/visits`)
  * Starts a new table session. Sets `visits.status = 'OPEN'`.
  * *Permission:* `orders.visits.create`
* **Close a Visit** (`POST /api/v1/locations/{loc_id}/visits/{visit_id}/close`)
  * Sets `visits.status = 'COMPLETED'`. Allowed only if all associated accounts are `PAID` or `CLOSED`, and all order lines are in terminal states.
  * *Permission:* `orders.visits.close`

### Order & Line Commands
* **Add Order Line(s)** (`POST /api/v1/locations/{loc_id}/orders/{order_id}/lines`)
  * Adds multiple items to a draft/open order, linking each to a validated `account_id` (must belong to the same `visit_id`), specifying `seat_number`, `course_name`, `quantity`, and exact modifiers. The server computes all pricing authoritatively based on `products`, `modifiers`, and `location_price_overrides`.
  * *Permission:* `orders.lines.add`
* **Hold a Line** (`POST /api/v1/locations/{loc_id}/order-lines/{line_id}/hold`)
  * Changes a `DRAFT` line to `HELD` to delay firing to the kitchen.
  * *Permission:* `orders.lines.hold`
* **Send/Fire Lines** (`POST /api/v1/locations/{loc_id}/orders/{order_id}/send`)
  * Transitions specified `DRAFT` or `HELD` lines to `SENT`. Generates an `outbox_events` payload intended for the Kitchen Display System (KDS).
  * *Permission:* `orders.lines.send`
* **Transfer/Move Order Lines** (`POST /api/v1/locations/{loc_id}/orders/{order_id}/transfer-lines`)
  * Moves specified order lines to a different `order_id` (table transfer) or `account_id` (bill reassignment).
  * *Permission:* `orders.visits.transfer`

### Kitchen Fulfillment Commands (via Order Lines)
* **Mark Preparing** (`POST /api/v1/locations/{loc_id}/order-lines/{line_id}/mark-preparing`)
  * Acknowledged by kitchen. Transitions from `SENT` to `PREPARING`.
* **Mark Ready** (`POST /api/v1/locations/{loc_id}/order-lines/{line_id}/mark-ready`)
  * Transitions from `PREPARING` to `READY`.
* **Mark Fulfilled** (`POST /api/v1/locations/{loc_id}/order-lines/{line_id}/mark-fulfilled`)
  * Delivered to the table. Transitions from `READY` to `FULFILLED`.
  * *Permissions for all three:* `kitchen.tickets.update_status`

### Voids & Cancellations
* **Void a Line (Routine)** (`POST /api/v1/locations/{loc_id}/order-lines/{line_id}/void`)
  * Cancels a line that is `DRAFT`, `HELD`, or `SENT` (before preparation). No inventory waste. Server computes the financial amount from the line's quantity.
  * *Permission:* `orders.lines.void`
* **Void a Line (Override)** (`POST /api/v1/locations/{loc_id}/order-lines/{line_id}/void-override`)
  * Cancels a line that is `PREPARING`, `READY`, or `FULFILLED`. Represents food waste. Requires manager approval, creating an `audit_events` row logging both the actor and authorizing manager.
  * *Permission:* `orders.lines.void_override`
* **Cancel an Order (Routine)** (`POST /api/v1/locations/{loc_id}/orders/{order_id}/cancel`)
  * Cancels an entire order if all lines are pre-preparation.
  * *Permission:* `orders.orders.cancel`
* **Cancel an Order (Override)** (`POST /api/v1/locations/{loc_id}/orders/{order_id}/cancel-override`)
  * Cancels an entire order including lines already in progress. Requires manager authorization.
  * *Permission:* `orders.orders.cancel_override`

### Account & Payment Commands
* **Create an Account** (`POST /api/v1/locations/{loc_id}/visits/{visit_id}/accounts`)
  * Creates a new financial ledger for a visit.
  * *Permission:* `accounts.accounts.create`
* **Split an Account** (`POST /api/v1/locations/{loc_id}/accounts/{account_id}/split`)
  * *Permission:* `accounts.accounts.split`
  * Mechanics:
    1. **By Seat**: Server queries all order lines belonging to the source `account_id`, groups them by `seat_number`, and creates a new account per unique seat, reassigning the lines accordingly. Lines with `seat_number = NULL` remain on the original account.
    2. **By Item**: Client specifies an array of `order_line_id`s. Server creates one new account and moves those specific lines to it.
    3. **Equally**: No `order_lines` are reassigned — the original account keeps every line. The server creates `N` sibling accounts (client specifies `N`), each referencing the same `visit_id`, with no lines of its own and its `subtotal`/`tax`/`discount`/`total` fields set directly (not derived from lines) to `floor(original_total / N)`. Any remainder in cents from integer division is added to exactly one sibling account (the first one created), never split further or silently dropped — money must be traceable to the cent. The original account's own `total` is reduced to zero once fully distributed into siblings, so the sum of the original account (now 0) plus all `N` siblings always equals the pre-split total exactly. Each sibling is paid independently via its own `payments` rows.
* **Reopen a Closed Account** (`POST /api/v1/locations/{loc_id}/accounts/{account_id}/reopen`)
  * Reverts a `CLOSED` or `PAID` account to `OPEN` to allow payment adjustments.
  * *Permission:* `accounts.accounts.reopen`
* **Record a Payment** (`POST /api/v1/locations/{loc_id}/accounts/{account_id}/payments`)
  * Appends a payment record (e.g., Cash, Card). A single account can have multiple payments (mixed tender). The server authoritatively dictates the resulting account status (`PARTIALLY_PAID` vs `PAID`) based on the sum of payments against the account total, never relying on a client-supplied status.
  * *Permission:* `payments.payments.create`
* **Issue a Refund** (`POST /api/v1/locations/{loc_id}/payments/{payment_id}/refund`)
  * Refunds a previously completed payment. Logs an `audit_events` row.
  * *Permission:* `payments.refunds.create` (or `payments.refunds.override` for exceptions).

---

## 2. State Machine Tables

State changes must strictly follow these transitions, matching the schema's `CHECK` constraints. Note: `order_lines` transition independently of their parent `orders`. One line can be `READY` while another is `PREPARING`.

### `visits`
| From State | To State | Trigger / Command | Required Permission |
|------------|----------|-------------------|---------------------|
| (none) | `OPEN` | Open a Visit | `orders.visits.create` |
| `OPEN` | `COMPLETED` | Close Visit (when accounts paid) | `orders.visits.close` |
| `OPEN` | `CANCELLED` | Cancel Visit (if no payments made) | `orders.orders.cancel` |

### `orders` (Aggregate status — macro milestones only)
**Resolution of an ambiguity in the source material:** `orders.status` does NOT mirror `order_lines.status` through PREPARING/READY/FULFILLED. Those three states describe kitchen fulfillment of an individual line and are meaningless at the order level once lines diverge (idea.md section 78's explicit example: one line `Ready` while another is `Preparing`). The order aggregate only tracks macro milestones; a dashboard or KDS "all day" view derives an order's practical progress by looking at its lines, never at `orders.status` for that purpose.

| From State | To State | Trigger / Command | Required Permission |
|------------|----------|-------------------|---------------------|
| (none) | `DRAFT` | Create Order | `orders.orders.create` |
| `DRAFT` | `HELD` | Hold Order (all current lines held, none sent yet) | `orders.lines.hold` |
| `DRAFT`, `HELD` | `SENT` | Send/Fire at least one line (first round fired) | `orders.lines.send` |
| `DRAFT`, `HELD`, `SENT` | `CANCELLED` | Cancel (Routine) — only legal while no line has been sent | `orders.orders.cancel` |
| `SENT` | `CANCELLED` | Cancel (Override) — at least one line already sent/preparing/ready/fulfilled | `orders.orders.cancel_override` |
| `SENT` | `COMPLETED` | Every line has reached a terminal state (`FULFILLED`, `VOIDED`, or `CANCELLED`) and the visit's account(s) are settled | *(system-derived, not a direct client command)* |

### `order_lines` (Independent kitchen/fulfillment status)
| From State | To State | Trigger / Command | Required Permission |
|------------|----------|-------------------|---------------------|
| (none) | `DRAFT` | Add Order Line | `orders.lines.add` |
| `DRAFT` | `HELD` | Hold a Line | `orders.lines.hold` |
| `DRAFT`, `HELD` | `SENT` | Send/Fire Line | `orders.lines.send` |
| `SENT` | `PREPARING` | Mark Preparing (KDS) | `kitchen.tickets.update_status` |
| `PREPARING` | `READY` | Mark Ready (KDS) | `kitchen.tickets.update_status` |
| `READY` | `FULFILLED`| Mark Fulfilled | `kitchen.tickets.update_status` |
| `DRAFT`, `HELD`, `SENT` | `VOIDED` | Void (Routine) | `orders.lines.void` |
| `PREPARING`, `READY`, `FULFILLED` | `VOIDED` | Void (Override) | `orders.lines.void_override` |
| *Pre-Prep* | `CANCELLED` | Parent order cancelled | `orders.orders.cancel` |
| *Post-Prep*| `CANCELLED` | Parent order cancelled override | `orders.orders.cancel_override` |

### `accounts` (Financial status)
| From State | To State | Trigger / Command | Required Permission |
|------------|----------|-------------------|---------------------|
| (none) | `OPEN` | Create Account | `accounts.accounts.create` |
| `OPEN` | `PARTIALLY_PAID`| Record partial payment | `payments.payments.create` |
| `OPEN`, `PARTIALLY_PAID` | `PAID` | Record payment (meets/exceeds total) | `payments.payments.create` |
| `PAID` | `CLOSED` | Close Visit / Account finalizing | `orders.visits.close` |
| `CLOSED`, `PAID` | `OPEN` | Reopen closed account | `accounts.accounts.reopen` |
| `PAID`, `CLOSED` | `REFUNDED`| Issue full refund | `payments.refunds.create` |

---

## 3. Concrete Business Rules

1. **Rounds (Multiple Send/Fire Cycles):** A single `order` and `visit` will receive multiple `send` commands over its lifetime. Adding lines leaves them in `DRAFT`; the explicitly batched `send` command commits them to the kitchen.
2. **Hold vs. Send:** Adding a line to an order registers it for billing immediately. Holding it (`HELD`) explicitly tags it to *not* print or show on the KDS. Firing (`SENT`) is the only trigger that creates the outbox event for the kitchen.
3. **Seat and Course Association:** Order lines optionally carry `seat_number` and `course_name`. These are intrinsic to the line upon creation. Sorting by course is a presentation concern, but the data must persist accurately on the line level.
4. **Out of Stock Mid-Order:** If a product's `availability_rules` changes to `EXHAUSTED` *after* a line is added but *before* the line is sent (i.e. sitting in `DRAFT`), the `send` command must reject the firing of that specific line and return a 409 Conflict, forcing the waiter to address it.
5. **Splitting Bill by Seat with Null Seats:** When an account is split "By Seat", any `order_line` where `seat_number` is `NULL` (e.g., a shared appetizer) is left on the original primary account. It is not automatically fractioned. The staff must manually split the item if they wish to divide a shared plate.
6. **Cancellation Cascade:** If an entire order is cancelled, every child `order_line` transitions according to its own state, not a blanket choice: lines still `DRAFT`/`HELD`/`SENT`-but-not-yet-`PREPARING` become `CANCELLED` (no waste incurred); lines already `PREPARING`, `READY`, or `FULFILLED` become `VOIDED` instead (this is only reachable through `cancel-override`, since routine `cancel` is illegal once any line has entered preparation — see the state table above). If any line was `SENT` or later, dispatch an outbox event so the kitchen display removes or flags the affected tickets.
7. **Order vs. Account Divergence:** An "Order" is the kitchen-facing fulfillment aggregate; an "Account" is the financial/billing aggregate. One table visit might have 1 Order (3 rounds of drinks and food) but 2 Accounts (split bill), each with its own Payment(s). This is why `order_lines` point to both an `order_id` and an `account_id`.

---

## 4. Idempotency and Concurrency

### Optimistic Concurrency Control (`If-Match`)
Every mutating command on a mutable aggregate (`orders`, `visits`, `accounts`, `order_lines`) requires the `If-Match` HTTP header specifying the client's known `version`.
* The update logic runs: `UPDATE ... WHERE id = $1 AND version = $2`.
* If zero rows are updated, the command aborts and returns a `409 Conflict`.

**409 Conflict Payload Structure:**
```json
{
  "error": {
    "status": 409,
    "code": "OPTIMISTIC_CONCURRENCY_CONFLICT",
    "message": "Resource modified since last read.",
    "details": {
      "current_version": 5,
      "current_state": { /* Full JSON representation of the latest aggregate */ }
    }
  }
}
```

### Command Idempotency (`Idempotency-Key`)
Network retries require an `Idempotency-Key` header to prevent double-execution when the client loses the network after the server commits.
* **Payments:** `POST /api/v1/locations/{loc_id}/accounts/{account_id}/payments` MUST require an `Idempotency-Key` to prevent double-charging a customer.
* **Send/Fire Lines:** `POST /api/v1/locations/{loc_id}/orders/{order_id}/send` MUST require an `Idempotency-Key`. A blind retry of a "Fire" command without an idempotency key could double-fire tickets to the kitchen if the client's internal state didn't update to `SENT` yet.

*Behavior:* If a request is received with a previously seen `Idempotency-Key` and an identical payload, the server returns the cached successful response. If the payload differs, it returns `409 Conflict`.

---

## 5. Explicitly Out of Scope

To prevent scope creep, the implementing engineer must explicitly ignore the following in this module:
* **Kitchen Device UX:** We are exposing API endpoints (`mark-preparing`, `mark-ready`) and emitting `outbox_events`. Building the actual WebSocket fan-out and KDS UI is a separate task.
* **Payment Provider Integration:** The `payments` endpoints accept successful payment details (e.g., `reference_code` from Stripe). Actual tokenization, card reader protocols, and clearinghouse integrations are out of scope here.
* **Hardware Printing:** Do not build receipt or kitchen ticket ESC/POS printing queues.
* **Inventory Deduction:** Do not trigger recipe explosions or stock reductions when items are sold. Inventory is a future, separate module.
