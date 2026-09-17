# Loyalty Requirements

## 1. Overview and Design Decisions

The Loyalty module is a brand-new transversal domain allowing customers to accrue and redeem points or visit counts across all order channels (Staff, Kiosk, and Customer App). To ensure simplicity and align with `idea.md` (sections 25 and 75), the following core design decisions establish the boundaries of the feature:

*   **Automatic Enrollment vs. Opt-in**: Loyalty accounts are automatically linked to `customers` rows. A `loyalty_accounts` row is lazily created upon the first accrual or explicit lookup. Guest purchases before account creation do **not** retroactively earn points. This bounds historical data scope and simplifies the accrual logic.
*   **Organization-Scoped Settings**: Unlike reservations which are strictly per-location, the point-accrual formula (e.g., "$10 spent = 1 point") is a single global setting per organization (`loyalty_settings`). In a single-organization architecture (`organizations.unq_is_single_org`), loyalty programs are uniformly expected to span the entire brand. Module activations (`module_activations`) remain location-scoped, meaning a restaurant can choose *which locations* participate in the program, but the rules are governed globally.
*   **Rewards vs. Coupons**: These are treated as distinct, simple concepts to satisfy both use cases cleanly:
    *   **Rewards**: Unlocked by spending accrued points or visit counts tied to a specific `loyalty_account`.
    *   **Coupons**: One-off promotional codes (e.g., "SAVE20") not tied to points, usable by any guest.
*   **Reward Redemption Mechanism**: A reward is defined in a configurable catalog (`loyalty_rewards`). A reward costs points OR visits. When redeemed against an active visit, it atomically creates an `account_discounts` entry, applying a currency discount or percentage discount to the current account.
*   **State Machine**: No multi-step lifecycle is needed. Earning and redeeming are atomic, synchronous operations inserting a `loyalty_transactions` record and adjusting the balance.
*   **Kiosk / Guest Identification**: Kiosks operate on anonymous `guestSession` tokens. To accrue points, a new attach flow allows a guest to input their phone number. If a matching customer exists, their `customer_id` is stamped onto the `visit`. If not, a minimal customer row is created, satisfying the optional "Identificación" step from `idea.md`.
*   **Accrual Hook Point**: Points are awarded synchronously during `POST /api/v1/locations/:locationId/visits/:visitId/close`. This ensures the points are based on the final, settled `subtotal` across all fully-paid accounts on the visit, and prevents awarding points for refunded or voided orders.

## 2. Data Model

The following tables define the loyalty domain.

### 2.1 `loyalty_settings` (Organization-scoped)
A single row defining the global rules for the brand.
*   `id` (UUID, Primary Key, Default `gen_random_uuid()`)
*   `organization_id` (UUID, NOT NULL, UNIQUE, FK to `organizations`)
*   `spend_amount_for_one_point` (INTEGER, NOT NULL, DEFAULT 1000) — Amount in cents required to earn 1 point.
*   `version` (INTEGER, NOT NULL, DEFAULT 1)
*   `created_at`, `updated_at` (TIMESTAMPTZ, Default NOW, trigger `set_updated_at`)

### 2.2 `loyalty_accounts` (Organization-scoped)
Tracks a customer's current balances. Lazily provisioned.
*   `id` (UUID, Primary Key, Default `gen_random_uuid()`)
*   `organization_id` (UUID, NOT NULL, FK to `organizations`)
*   `customer_id` (UUID, NOT NULL, FK to `customers`)
*   `points_balance` (INTEGER, NOT NULL, DEFAULT 0)
*   `total_visits` (INTEGER, NOT NULL, DEFAULT 0) — Tracks purchase count for "5 compras = recompensa" rules.
*   `version` (INTEGER, NOT NULL, DEFAULT 1)
*   `created_at`, `updated_at` (TIMESTAMPTZ, Default NOW, trigger `set_updated_at`)
*   *Constraints*: `UNIQUE(organization_id, customer_id)`

### 2.3 `loyalty_rewards` (Organization-scoped)
Admin-configured catalog of available rewards.
*   `id` (UUID, Primary Key, Default `gen_random_uuid()`)
*   `organization_id` (UUID, NOT NULL, FK to `organizations`)
*   `name` (VARCHAR, NOT NULL)
*   `description` (TEXT)
*   `cost_in_points` (INTEGER) — Nullable.
*   `cost_in_visits` (INTEGER) — Nullable.
*   `discount_type` (VARCHAR, NOT NULL) — `PERCENTAGE` or `AMOUNT` only, matching the existing `account_discounts.discount_type` CHECK constraint (`012_account_discounts.js`) exactly, since every redemption ultimately writes an `account_discounts` row and that table's CHECK rejects any other value. A "free item" reward (idea.md: "100 puntos = producto gratuito") is modeled as `discount_type = 'PERCENTAGE'`, `discount_value = 100`, applied to the specific `order_line_id` the redeemer selects at redemption time — `account_discounts.order_line_id` is already nullable and already supports scoping a discount to one line, and `value <= 100` is already enforced by `chk_account_discount_percentage_value`, so this needs no schema alteration beyond the `applied_by` change noted below.
*   `discount_value` (INTEGER, NOT NULL) — a `PERCENTAGE` value must be `<= 100`, matching `account_discounts`' own constraint; enforce the same CHECK here.
*   `is_active` (BOOLEAN, NOT NULL, DEFAULT TRUE)
*   `version` (INTEGER, NOT NULL, DEFAULT 1)
*   `created_at`, `updated_at` (TIMESTAMPTZ, Default NOW, trigger `set_updated_at`)
*   *Constraints*: `CHECK (cost_in_points IS NOT NULL OR cost_in_visits IS NOT NULL)`

### 2.4 `loyalty_coupons` (Organization-scoped)
Promo codes not tied to a points balance.
*   `id` (UUID, Primary Key, Default `gen_random_uuid()`)
*   `organization_id` (UUID, NOT NULL, FK to `organizations`)
*   `code` (VARCHAR, NOT NULL, UNIQUE)
*   `discount_type` (VARCHAR, NOT NULL) — `PERCENTAGE` or `AMOUNT`, same constraint as `loyalty_rewards.discount_type` above (a coupon always applies to the whole account, not a single line, so `PERCENTAGE` here has no free-item use case).
*   `discount_value` (INTEGER, NOT NULL)
*   `is_active` (BOOLEAN, NOT NULL, DEFAULT TRUE)
*   `version` (INTEGER, NOT NULL, DEFAULT 1)
*   `created_at`, `updated_at` (TIMESTAMPTZ, Default NOW, trigger `set_updated_at`)

### 2.5 `loyalty_transactions` (Organization-scoped)
Append-only ledger of points and visit counts.
*   `id` (UUID, Primary Key, Default `gen_random_uuid()`)
*   `organization_id` (UUID, NOT NULL, FK to `organizations`)
*   `loyalty_account_id` (UUID, NOT NULL, FK to `loyalty_accounts`)
*   `transaction_type` (VARCHAR, NOT NULL) — `ACCRUAL`, `REDEMPTION`, `ADJUSTMENT`.
*   `points_delta` (INTEGER, NOT NULL)
*   `visit_count_delta` (INTEGER, NOT NULL, DEFAULT 0)
*   `reason` (VARCHAR, NOT NULL)
*   `reference_visit_id` (UUID, FK to `visits`) — Nullable.
*   `created_at` (TIMESTAMPTZ, NOT NULL, DEFAULT NOW())

### 2.6 `loyalty_redemptions` (Organization-scoped)
Links a reward/coupon to the concrete discount applied to an order.
*   `id` (UUID, Primary Key, Default `gen_random_uuid()`)
*   `organization_id` (UUID, NOT NULL, FK to `organizations`)
*   `loyalty_account_id` (UUID, FK to `loyalty_accounts`) — Nullable for coupons.
*   `reward_id` (UUID, FK to `loyalty_rewards`) — Nullable.
*   `coupon_id` (UUID, FK to `loyalty_coupons`) — Nullable.
*   `account_discount_id` (UUID, NOT NULL, FK to `account_discounts`)
*   `created_at` (TIMESTAMPTZ, NOT NULL, DEFAULT NOW())
*   *Constraints*: `CHECK (reward_id IS NOT NULL OR coupon_id IS NOT NULL)`

### 2.7 Required Schema Alterations
*   `account_discounts.applied_by`: Must be altered to `DROP NOT NULL` (or a `customer_id` column added) because rewards/coupons can be applied via self-service (Kiosk / Customer App) where no staff member is present.

## 3. RLS Scoping

Following the established precedents in `017_customer_accounts.js` and `020_inventory_and_recipes.js`:

*   **`loyalty_settings`, `loyalty_rewards`, `loyalty_coupons`**: No RLS (only standard `PERMISSIVE` for the runtime role). **Justification**: These are configuration tables managed by Admin and read globally. This matches the `ingredients` and `products` precedent where org-scoped configuration skips RLS to avoid unnecessary overhead.
*   **`loyalty_accounts`, `loyalty_transactions`, `loyalty_redemptions`**: Defense-in-depth RLS. Both `PERMISSIVE` and `RESTRICTIVE` policies enforcing `organization_id = app.current_organization_id`. **Justification**: These tables contain sensitive, customer-reachable PII and balance data. This strictly matches the `customers` and `customer_sessions` precedent, adding an extra layer of protection against cross-tenant data leaks.

## 4. API Surface

### 4.1 Staff & Admin Endpoints
*   **`GET /api/v1/loyalty-settings`**
    *   *Auth*: Staff session token (`${locationId}.${secret}`).
    *   *Permission*: `loyalty.settings.read`.
*   **`PUT /api/v1/loyalty-settings`**
    *   *Auth*: Staff session token.
    *   *Permission*: `loyalty.settings.write`.
*   **`GET /api/v1/loyalty-rewards`** and **`GET /api/v1/loyalty-coupons`**
    *   *Auth*: Staff session token.
    *   *Permission*: `loyalty.rewards.read`.
*   **`POST /api/v1/loyalty-rewards`** and **`PUT /api/v1/loyalty-rewards/{id}`**
    *   *Auth*: Staff session token.
    *   *Permission*: `loyalty.rewards.write`.
*   **`GET /api/v1/customers/{customerId}/loyalty`**
    *   *Auth*: Staff session token.
    *   *Permission*: `loyalty.accounts.read`.
    *   *Action*: View a customer's balance and transaction history.
*   **`POST /api/v1/customers/{customerId}/loyalty/adjust`**
    *   *Auth*: Staff session token.
    *   *Permission*: `loyalty.accounts.adjust`.
    *   *Action*: Manually grant or deduct points (e.g., for customer service appeasement).

### 4.2 Core Accrual Hook
*   **`POST /api/v1/locations/{loc_id}/visits/{visitId}/close`**
    *   *Action*: Synchronous side effect inside the existing transaction. After `visits` and `orders` transition to `COMPLETED`, if `visits.customer_id` is not null, query the `loyalty_settings`. Sum the `subtotal` of all `PAID`/`CLOSED` accounts on the visit, calculate `points_earned`, and insert into `loyalty_transactions`. Update `loyalty_accounts` by incrementing `points_balance` and `total_visits`.

### 4.3 Kiosk / Guest Endpoints
*   **`POST /api/v1/locations/{loc_id}/visits/{visitId}/attach-customer`**
    *   *Auth*: Dual-path (Staff session token OR exact `guestSession` token matching the visit).
    *   *Payload*: `{ phone: string }`.
    *   *Action*: Looks up `customers` by phone. If missing, creates a skeleton customer record. Updates `visits.customer_id` with the result, ensuring the visit will earn points upon closure.
*   **`POST /api/v1/locations/{loc_id}/visits/{visitId}/redeem-reward`**
    *   *Auth*: Dual-path (Staff session token OR exact `guestSession` token matching the visit).
    *   *Payload*: `{ reward_id: UUID, order_line_id?: UUID }` or `{ coupon_code: string }` — `order_line_id` is required when the target reward's `discount_type` is `PERCENTAGE` with `discount_value = 100` (a free-item reward), since that must scope to one line rather than the whole account; omitted otherwise.
    *   *Action*: Verifies the visit has a `customer_id` (for rewards). Deducts points, creates an `account_discounts` record (on the specified `order_line_id`, or unscoped on the primary open account otherwise), and logs a `loyalty_redemptions`.

### 4.4 Customer-Facing Endpoints
*   **`GET /api/v1/customers/me/loyalty`**
    *   *Auth*: Customer session token (`customer.${organizationId}.${secret}`).
    *   *Action*: Returns the current `points_balance`, `total_visits`, and the list of active rewards the user can currently afford.
*   **`GET /api/v1/customers/me/loyalty/history`**
    *   *Auth*: Customer session token.
    *   *Action*: Lists the user's `loyalty_transactions` ledger.

## 5. Permissions

The following permissions will be added to the IAM catalog.

| Permission Name | Description |
| :--- | :--- |
| `loyalty.settings.read` | View global loyalty accrual formulas and rules. |
| `loyalty.settings.write` | Update global loyalty rules. |
| `loyalty.rewards.read` | View the catalog of available rewards and coupons. |
| `loyalty.rewards.write` | Create or update rewards and coupons. |
| `loyalty.accounts.read` | View a specific customer's loyalty balance and history. |
| `loyalty.accounts.adjust` | Manually credit or debit points from a customer. |

## 6. Non-Goals

To keep the scope strictly bounded to `idea.md`, the following are explicitly out of scope:
*   **Tiered Memberships**: No Silver/Gold/Platinum tiers with multiplier effects.
*   **Point Expiration**: Points do not expire or decay over time.
*   **Third-Party Networks**: No integrations with external coalition loyalty programs.
*   **Referral Programs**: No "refer a friend" bonus point systems.
*   **Multi-Step Redemptions**: No complex state machine for claiming, holding, and later applying a reward; redemption is a single atomic act during an active visit.
*   **Retroactive Accrual**: Past orders made as a guest before account creation cannot be retroactively claimed for points.
