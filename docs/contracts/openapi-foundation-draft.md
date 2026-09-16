# OpenAPI 3.1 Contract Draft: Foundation

This document designs the REST over HTTPS endpoints for Restaurant Suite's Foundation tier (versioned under `/api/v1`). It strictly adheres to the shapes defined in `docs/architecture/data-model-foundation.md` and the behavioral rules from the architecture ADR and product spec.

## 1. Shared Conventions

### 1.1 Pagination & List Query
Every list endpoint (e.g., categories, products, tables, visits) uses a consistent cursor-based pagination strategy.

**Query Parameters:**
- `limit` (integer, default: 50, max: 100)
- `cursor` (string, optional)

**Response Shape:**
```json
{
  "data": [ ... ],
  "meta": {
    "next_cursor": "string|null",
    "has_more": true,
    "total_count": 150
  }
}
```

### 1.2 Error Responses & Optimistic Concurrency
Mutating commands on aggregates (e.g., tables, visits, orders, accounts) require optimistic concurrency control via the `If-Match` HTTP header, which must contain the aggregate's expected `version`.

All errors, including conflicts, share a unified response shape. When a `409 Conflict` occurs because the `If-Match` version does not match the database version, the response includes the latest state so the client can rebase/retry.

**Shared Error Shape (409 Example):**
```json
{
  "error": {
    "status": 409,
    "code": "OPTIMISTIC_CONCURRENCY_CONFLICT",
    "message": "The resource has been modified since it was last read. Please refresh and try again.",
    "request_id": "req-12345-uuid",
    "details": {
      "current_version": 4,
      "current_state": {
        "id": "uuid",
        "status": "OCCUPIED",
        "version": 4
        // ... full current representation
      }
    }
  }
}
```

### 1.3 Idempotency and Retries
- **Read-Only / Safe:** `GET` endpoints are read-only and always safe to retry.
- **Idempotent by Design:** `PUT` and `DELETE` endpoints, as well as concurrency-guarded commands (via `If-Match`), are safe to retry. If the state already moved forward, the retry safely fails with `409 Conflict`.
- **Idempotency Keys:** Commands that cause external side effects or critical financial ledgers (e.g., `POST /accounts/{id}/payments`) **must** provide an `Idempotency-Key` HTTP header. The system will track this to prevent double-charging or duplicate external webhooks upon network failure.

---

## 2. Identity & Auth

| Method | Path | Purpose | Required Permission |
| --- | --- | --- | --- |
| `POST` | `/api/v1/terminals/enroll` | Enroll a terminal to a location | `terminals.enroll` |
| `GET`  | `/api/v1/terminals` | List enrolled terminals | `terminals.read` |
| `POST` | `/api/v1/auth/pin-unlock` | Unlock terminal (create staff session) | (Public) |
| `POST` | `/api/v1/auth/refresh` | Refresh an active session | (Authenticated) |
| `POST` | `/api/v1/auth/logout` | Terminate session | (Authenticated) |
| `GET`  | `/api/v1/auth/me` | "Who am I" (Session, permissions, roles) | (Authenticated) |
| `GET`  | `/api/v1/staff` | List staff | `staff.read` |
| `POST` | `/api/v1/staff` | Create staff member | `staff.write` |
| `PUT`  | `/api/v1/staff/{id}` | Update staff member | `staff.write` |
| `GET`  | `/api/v1/roles` | List roles | `roles.read` |
| `PUT`  | `/api/v1/roles/{id}/permissions`| Grant/update permissions for a role | `permissions.grant` |

**Command Example: `POST /api/v1/auth/pin-unlock`**
- **Request Body:** `{ "terminal_id": "uuid", "pin": "string" }`
- **Response:** `{ "token": "string", "expires_at": "datetime", "staff_id": "uuid", "location_id": "uuid" }`

---

## 3. Menu & Catalog

| Method | Path | Purpose | Required Permission |
| --- | --- | --- | --- |
| `GET`  | `/api/v1/categories` | List categories | `menu.read` |
| `POST` | `/api/v1/categories` | Create category | `menu.write` |
| `GET`  | `/api/v1/products` | List products (w/ variants/modifiers) | `menu.read` |
| `POST` | `/api/v1/products` | Create product | `menu.write` |
| `PUT`  | `/api/v1/locations/{loc_id}/price-overrides/{product_id}` | Override location price | `menu.price.update` |
| `POST` | `/api/v1/locations/{loc_id}/products/{product_id}/mark-unavailable` | Explicit command to mark exhausted | `menu.availability.update` |
| `POST` | `/api/v1/locations/{loc_id}/products/{product_id}/mark-available` | Explicit command to mark available | `menu.availability.update` |

**Command Example: `POST /api/v1/locations/{loc_id}/products/{id}/mark-unavailable`**
- **Header:** `If-Match: "2"` (Refers to `availability_rules.version`)
- **Request Body:** `{ "channel_scope": "string|null", "service_type_scope": "string|null" }`
- **Response:**
  ```json
  {
    "id": "uuid",
    "location_id": "uuid",
    "product_id": "uuid",
    "status": "EXHAUSTED",
    "version": 3
  }
  ```

---

## 4. Floor & Tables

| Method | Path | Purpose | Required Permission |
| --- | --- | --- | --- |
| `GET`  | `/api/v1/areas` | List areas | `floor.read` |
| `GET`  | `/api/v1/tables` | List tables | `floor.read` |
| `GET`  | `/api/v1/sections` | List sections | `floor.read` |
| `POST` | `/api/v1/sections` | Create section | `floor.write` |
| `PUT`  | `/api/v1/sections/{id}` | Update section | `floor.write` |
| `POST` | `/api/v1/tables/{id}/mark-needs-cleaning` | Command: Flag for cleaning | `tables.status.update` |
| `POST` | `/api/v1/tables/{id}/mark-available` | Command: Flag available | `tables.status.update` |
| `POST` | `/api/v1/tables/{id}/mark-out-of-service` | Command: Flag out of order | `tables.status.update` |

**Command Example: `POST /api/v1/tables/{id}/mark-needs-cleaning`**
- **Header:** `If-Match: "1"`
- **Request Body:** `{}`
- **Response:**
  ```json
  {
    "id": "uuid",
    "location_id": "uuid",
    "area_id": "uuid",
    "name": "Table 4",
    "status": "NEEDS_CLEANING",
    "version": 2
  }
  ```

---

## 5. Orders, Visits & Accounts

| Method | Path | Purpose | Required Permission |
| --- | --- | --- | --- |
| `POST` | `/api/v1/visits` | Open a visit (seat a table) | `visits.create` |
| `POST` | `/api/v1/visits/{id}/close` | Close a visit | `visits.close` |
| `POST` | `/api/v1/accounts` | Create an account for a visit | `accounts.create` |
| `POST` | `/api/v1/accounts/{id}/split` | Split an account | `accounts.split` |
| `POST` | `/api/v1/orders` | Create an order | `orders.create` |
| `POST` | `/api/v1/orders/{id}/lines` | Add order lines | `orders.add_lines` |
| `POST` | `/api/v1/order-lines/{id}/hold` | Hold a line | `orders.update_status` |
| `POST` | `/api/v1/orders/{id}/send` | Send/fire an order's lines | `orders.send` |
| `POST` | `/api/v1/order-lines/{id}/mark-preparing` | Mark line preparing | `kitchen.update_status` |
| `POST` | `/api/v1/order-lines/{id}/mark-ready` | Mark line ready | `kitchen.update_status` |
| `POST` | `/api/v1/order-lines/{id}/mark-fulfilled` | Mark line fulfilled | `kitchen.update_status` |
| `POST` | `/api/v1/order-lines/{id}/void` | Void a line | `orders.void` |
| `POST` | `/api/v1/orders/{id}/cancel` | Cancel an order entirely | `orders.cancel` |
| `POST` | `/api/v1/accounts/{id}/payments` | Record a payment | `payments.create` |
| `POST` | `/api/v1/payments/{id}/refund` | Refund a payment | `payments.refund` |

**Command Example: `POST /api/v1/orders/{id}/lines`**
- **Header:** `If-Match: "1"` (Order aggregate version)
- **Request Body:**
  ```json
  {
    "account_id": "uuid",
    "lines": [
      {
        "product_id": "uuid",
        "variant_id": "uuid",
        "seat_number": 1,
        "course_name": "Main",
        "quantity": 1,
        "unit_price": 1500,
        "modifiers": [
          { "modifier_id": "uuid", "unit_price": 200 }
        ]
      }
    ]
  }
  ```
- **Response:**
  ```json
  {
    "id": "order-uuid",
    "location_id": "uuid",
    "visit_id": "uuid",
    "order_type": "DINE_IN",
    "status": "DRAFT",
    "version": 2,
    "lines": [
      {
        "id": "line-uuid",
        "status": "DRAFT",
        "product_id": "uuid",
        "quantity": 1,
        "unit_price": 1500,
        "version": 1
      }
    ]
  }
  ```

**Command Example: `POST /api/v1/order-lines/{id}/void`**
- **Header:** `If-Match: "2"` (Order Line aggregate version)
- **Request Body:**
  ```json
  {
    "reason": "Customer changed mind",
    "amount": 1700
  }
  ```
- **Response:** The updated order line object with `"status": "VOIDED"` and incremented version, triggering an `audit_events` row downstream.

**Command Example: `POST /api/v1/accounts/{id}/payments`**
- **Headers:** 
  - `If-Match: "2"` (Account version)
  - `Idempotency-Key: "unique-client-generated-uuid"`
- **Request Body:**
  ```json
  {
    "method": "CREDIT_CARD",
    "amount": 2000,
    "tip_amount": 300,
    "reference_code": "stripe-ch_12345",
    "status": "COMPLETED"
  }
  ```
- **Response:** 
  ```json
  {
    "id": "payment-uuid",
    "location_id": "uuid",
    "account_id": "uuid",
    "method": "CREDIT_CARD",
    "amount": 2000,
    "tip_amount": 300,
    "status": "COMPLETED",
    "reference_code": "stripe-ch_12345",
    "idempotency_key": "unique-client-generated-uuid",
    "version": 1
  }
  ```

## Security & Correctness Review Notes

- **blocker** - `POST /api/v1/accounts/{id}/payments`: The request body allows the client to set `"status": "COMPLETED"`. A client must never dictate the final payment status; the server must derive this authoritatively from a payment provider's response, webhook, or internal processing. **Fix:** Remove `"status"` from the request body.
- **blocker** - `POST /api/v1/orders/{id}/lines`: The request body allows the client to send `"unit_price": 1500` (and `"unit_price": 200` for modifiers). A malicious client could set arbitrary prices for items, effectively stealing inventory. **Fix:** Remove pricing fields from the request body. The server must compute prices authoritatively based on the product catalog and location-specific overrides.
- **blocker** - `POST /api/v1/order-lines/{id}/void`: The request body includes an arbitrary `"amount": 1700`. A malicious client could void a larger financial amount than the line is actually worth. **Fix:** Remove the financial `"amount"` from the void request. If partial voids are supported, accept a `quantity` instead, and let the server compute the monetary value.
- **blocker** - `POST /api/v1/orders/{id}/lines`: The request body requires `"account_id"`. A malicious client could supply an `account_id` belonging to a completely different visit/table, maliciously charging another party. **Fix:** The server must rigorously validate that the supplied `account_id` belongs to the same `visit_id` as the `order_id` in the URL, or implicitly resolve the account if only one exists.
- **blocker** - `POST /api/v1/auth/pin-unlock`: This public endpoint lacks rate-limiting definitions, violating ADR 0001 (which mandates per-terminal backoff). An attacker could brute-force staff PINs without penalty. **Fix:** Explicitly document the `429 Too Many Requests` response and `Retry-After` header behavior based on per-terminal and per-credential backoff.
- **should-fix** - `POST /api/v1/auth/pin-unlock`: Relies on a `terminal_id` string in the request body. If there is no cryptographic proof of terminal identity, an attacker could spoof random `terminal_id`s to evade the per-terminal rate limits. **Fix:** Require a secure device token/cookie (issued during `/api/v1/terminals/enroll`) to authenticate the terminal, rather than trusting a self-asserted ID.
- **should-fix** - Location Context Ambiguity: Top-level creation endpoints for location-scoped resources (e.g., `POST /api/v1/sections`, `POST /api/v1/visits`, `POST /api/v1/accounts`) do not include a location context in the URL or body. This is ambiguous for administrators managing multiple locations. **Fix:** Change to `POST /api/v1/locations/{loc_id}/sections` or strictly require `location_id` in the request body for top-level scoped creations.
- **should-fix** - Idempotency Key Reuse: Section 1.3 mandates the `Idempotency-Key` header but is silent on what happens if a key is reused with a *different* request payload. **Fix:** Specify that reusing an `Idempotency-Key` with a mismatched payload must return a `400 Bad Request` or `409 Conflict` to prevent accidental collisions or payload swapping.
- **should-fix** - Missing Endpoints & Concurrency Headers: The data model implies fetching single aggregates and sub-collections, but they are absent. Also, `PUT /api/v1/staff/{id}` lacks the required concurrency control header, and the customer QR session initialization endpoint described in ADR 0001 is missing entirely. **Fix:** Add missing read endpoints (`GET /api/v1/orders/{id}`, `GET /api/v1/orders/{id}/lines`, `GET /api/v1/accounts/{id}/payments`), specify that `PUT /api/v1/staff/{id}` requires `If-Match`, and add the table scan session endpoint (e.g., `POST /api/v1/auth/table-scan`).
- **minor** - Permission Naming Consistency: Names like `permissions.grant` and `kitchen.update_status` do not align coherently with others like `roles.read` and `orders.update_status`, making role configuration brittle. **Fix:** Standardize permissions to a strict `<domain>.<resource>.<action>` format (e.g., `iam.roles.update`, `orders.lines.update_status`).
