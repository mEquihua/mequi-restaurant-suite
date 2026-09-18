# Promotions Requirements

## 1. Overview and Design Decisions

The Promotions module introduces admin-configured, rule-based, automatic discounts that apply without any staff action or customer-entered code. This capability fills the gap identified in `idea.md` (section 82) for automatic, scheduled markdowns (e.g., Happy Hours, daily specials, or category-wide sales), clearly distinct from manual manager overrides (`account_discounts`) and one-off promo codes (`loyalty_coupons`).

To align with the "essential version" philosophy of Restaurant Suite, the following core design decisions establish the boundaries of this feature:

*   **Organization-Scoped Rules**: Like `products` and `loyalty_rewards`, promotions are configuration data and are scoped globally to the organization. This ensures a consistent brand experience across all locations.
*   **Evaluation at Order-Line-Add Time**: Promotions are evaluated and applied at the exact moment an item is added to an order (e.g., inside the `addOrderLines` command). This locks in the time-sensitive price (like a 6:59 PM Happy Hour order) regardless of when the ticket is finally closed or paid.
*   **No Stacking (Single Best Rule)**: To prevent complex priority engines and accidental deep-discounting, automatic promotions **do not stack** on the same item. The system evaluates all eligible promotions for an order line and applies only the single promotion that yields the highest discount amount.
*   **Interaction with Manual / Loyalty Discounts**: 
    * If a staff member applies a manual line-level discount via `account_discounts`, or a loyalty reward targets that specific line, it overrides and removes the automatic promotion for that line.
    * If a manual discount or loyalty coupon is applied to the *entire account*, it applies normally to the post-promotion subtotal (stacking at the account level, but not double-dipping at the item level).
*   **Invisible Configuration**: There is no dedicated customer-facing "Promotions Viewer" endpoint. Promotions are purely a backend pricing effect. The customer and staff simply see the reduced price and the promotion's name reflected on the ticket/receipt data returned by existing order endpoints.

## 2. Data Model

The following tables define the promotions domain.

### 2.1 `promotions` (Organization-scoped)
Admin-configured catalog of automatic discount rules.
*   `id` (UUID, Primary Key, Default `gen_random_uuid()`)
*   `organization_id` (UUID, NOT NULL, FK to `organizations`)
*   `name` (VARCHAR, NOT NULL)
*   `description` (TEXT)
*   `discount_type` (VARCHAR, NOT NULL) — `PERCENTAGE` or `AMOUNT` only, matching the exact vocabulary of `account_discounts` and `loyalty_coupons`.
*   `discount_value` (INTEGER, NOT NULL) — Amount in cents, or percentage (0-100).
*   `category_id` (UUID, Nullable, FK to `categories`) — If set, limits the promotion to products in this category.
*   `product_id` (UUID, Nullable, FK to `products`) — If set, limits the promotion to this specific product.
*   `is_active` (BOOLEAN, NOT NULL, DEFAULT TRUE)
*   `starts_at` (TIMESTAMPTZ, Nullable) — Start date of the promotion campaign.
*   `ends_at` (TIMESTAMPTZ, Nullable) — End date of the promotion campaign.
*   `days_of_week` (INTEGER[], Nullable) — Array of ISO weekdays (1-7) the promotion is active (e.g., `[1,2,3,4,5]` for Mon-Fri).
*   `start_time` (TIME, Nullable) — Time of day the promotion starts (e.g., `'17:00:00'`).
*   `end_time` (TIME, Nullable) — Time of day the promotion ends (e.g., `'19:00:00'`).
*   `version` (INTEGER, NOT NULL, DEFAULT 1)
*   `created_at`, `updated_at` (TIMESTAMPTZ, Default NOW, trigger `set_updated_at`)
*   *Constraints*: 
    * `CHECK (discount_type IN ('PERCENTAGE', 'AMOUNT'))`
    * `CHECK (discount_type <> 'PERCENTAGE' OR discount_value <= 100)`
    * `CHECK (category_id IS NULL OR product_id IS NULL)` — A promotion cannot target both a specific category AND a specific product simultaneously. If both are null, it applies to all products.

### 2.2 `order_line_promotions` (Location-scoped)
Records the system-applied automatic discount for audit purposes (satisfying the Qué/Cuánto/Quién/Cuándo requirement of section 82, where "Quién" is the system via the promotion).
*   `id` (UUID, Primary Key, Default `gen_random_uuid()`)
*   `location_id` (UUID, NOT NULL, FK to `locations`)
*   `order_line_id` (UUID, NOT NULL, UNIQUE, FK to `order_lines`)
*   `promotion_id` (UUID, NOT NULL, FK to `promotions`)
*   `computed_amount` (INTEGER, NOT NULL) — The exact currency amount reduced from the line.
*   `created_at` (TIMESTAMPTZ, NOT NULL, DEFAULT NOW())

## 3. RLS Scoping

Following the established precedents in `007_row_level_security.js` and module design:

*   **`promotions`**: No RLS (only standard `PERMISSIVE` for the runtime role). **Justification**: This is an organization-scoped configuration table managed by Admin and read globally to evaluate rules. This strictly matches the `loyalty_rewards`, `loyalty_coupons`, and `products` precedent where org-scoped configuration skips RLS to avoid overhead.
*   **`order_line_promotions`**: Defense-in-depth RLS. Both `PERMISSIVE` and `RESTRICTIVE` policies enforcing `location_id = app.current_location_id`. **Justification**: This table records operational, location-specific transaction data. This strictly matches the `order_lines` and `account_discounts` precedent, protecting tenant transaction data.

## 4. API Surface

### 4.1 Admin Configuration Endpoints
These endpoints utilize standard `withAuthenticatedSession` guards and are used by the Admin App.

*   **`GET /api/v1/promotions`**
    *   *Auth*: Staff session token.
    *   *Permission*: `promotions.promotions.read`.
    *   *Action*: Lists all promotions for the organization.
*   **`POST /api/v1/promotions`**
    *   *Auth*: Staff session token.
    *   *Permission*: `promotions.promotions.write`.
    *   *Action*: Creates a new promotion rule.
*   **`GET /api/v1/promotions/{id}`**
    *   *Auth*: Staff session token.
    *   *Permission*: `promotions.promotions.read`.
*   **`PUT /api/v1/promotions/{id}`**
    *   *Auth*: Staff session token.
    *   *Permission*: `promotions.promotions.write`.
    *   *Action*: Updates a promotion using `If-Match` header for optimistic concurrency.

### 4.2 Core Application Hook
*   **`POST /api/v1/locations/{loc_id}/orders/{orderId}/lines`**
    *   *Action*: During the execution of `addOrderLines`, the system queries all active `promotions` where the current time falls within `starts_at`/`ends_at`, `days_of_week`, and `start_time`/`end_time`. For each added line, it filters rules matching the line's `product_id` (or the product's `category_id`, or global rules).
    *   It computes the discount amount for each eligible rule, selects the single rule providing the highest discount, subtracts that amount when updating the account `subtotal`, and synchronously inserts a row into `order_line_promotions` within the same transaction.

### 4.3 Customer / Staff Endpoints
*   **No dedicated read endpoints**.
    *   *Action*: Active promotions are not exposed via a dedicated marketing or query endpoint. The existing order and visit retrieval endpoints (`GET /api/v1/locations/.../orders/...`) will simply join or include the `order_line_promotions` data so the Kiosk, Staff App, or Customer App can display the discounted price and the promotion name (e.g., "Happy Hour - $2.00") directly on the ticket.

## 5. Permissions

The following permissions will be added to the IAM catalog (`docs/architecture/permission-catalog.md` section 4.x) in a follow-up implementation task.

| Permission Name | Description |
| :--- | :--- |
| `promotions.promotions.read` | View the organization's catalog of automatic promotions and schedules. |
| `promotions.promotions.write` | Create, edit, and activate/deactivate automatic promotion rules. |

## 6. Admin App Configuration UI

The Admin App requires a straightforward management interface for promotions, matching the CRUD conventions of the Menu or Delivery Zones sections:
*   A **List View** showing all promotions with their active status, discount value, and target scope.
*   A **Create/Edit Form** managing the `promotions` table fields:
    *   Basic info: Name, Description, Active toggle.
    *   Discount: Type (Percentage/Amount) and Value.
    *   Target Scope: Dropdowns to optionally select a specific Category or Product (mutually exclusive).
    *   Schedule: Start/End dates (optional), Days of the week checkboxes, and Time-of-day pickers.

## 7. Non-Goals

To maintain the "essential version" product scope and adhere to the project's strict non-goals framing, the following are explicitly excluded:
*   **Stacking / Complex Priorities**: No configuration for promotion priority weights or multi-promotion stacking on a single item. The single best discount always wins.
*   **Coupon Codes**: Handled entirely by `loyalty_coupons`. The Promotions module is strictly for automatic, invisible rules.
*   **BOGO / Free Items**: Mechanics like "Buy One Get One" or "Spend $50 Get a Free Dessert" belong to the Loyalty module (`loyalty_rewards`).
*   **Customer Segmentation**: No targeted promotions for specific user groups (e.g., "VIP customers only" or A/B testing).
*   **Marketing / Notifications**: No integration with email, SMS, or push notification systems to announce promotions to customers.
