# Integrations & Webhooks Requirements

This document defines the essential-version architecture for supporting integrations (Accounting, BI, custom workflows) and hardware printing in Restaurant Suite. 

In alignment with the principle that *“integrations should enrich Restaurant Suite, not force a basic restaurant to depend on them,”* this design intentionally avoids embedding vendor-specific SDKs (e.g., QuickBooks, Stripe, SendGrid) or storing third-party API secrets. Instead, it provides a strictly vendor-neutral **Outbound Webhook Framework** that allows operators to route domain events to their own middleware (Zapier, Make, custom functions), alongside a native, dependency-free **Browser-Based Printing** solution.

---

## 1. Data Model

We will introduce a new configuration table to store webhook subscriptions.

### `webhook_subscriptions`
- `id`: `UUID PRIMARY KEY DEFAULT gen_random_uuid()`
- `organization_id`: `UUID NOT NULL REFERENCES organizations(id)`
- `url`: `VARCHAR NOT NULL` (The destination HTTPS URL)
- `event_types`: `VARCHAR[] NOT NULL` (Array of subscribed events, e.g., `['account.paid', 'payment.received']`)
- `secret`: `VARCHAR NOT NULL` (HMAC signing secret, generated once at creation)
- `is_active`: `BOOLEAN NOT NULL DEFAULT TRUE`
- `version`: `INTEGER NOT NULL DEFAULT 1`
- `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at`: `TIMESTAMPTZ NOT NULL DEFAULT NOW()`

### RLS & Scope Decision
**Decision:** `webhook_subscriptions` is strictly scoped to the `organization_id` and will have **no Row Level Security (RLS)** applied, matching the precedent set by the `promotions` and `loyalty_coupons` tables. 

**Justification:** Webhooks represent external IT infrastructure. An operator routing data to their accounting software (e.g., QuickBooks) or an analytics warehouse will almost universally want a single organizational receiver rather than managing duplicate webhook configurations per-location. Security and isolation are enforced in application code (API layer) rather than through Postgres RLS.

### Outbox Schema Extension
We must add a new tracking column to the existing `outbox_events` table via a new migration:
- `webhook_dispatched_at`: `TIMESTAMPTZ` (Nullable)
This allows the new Webhook Dispatcher to consume the same events independently of the KDS Redis Dispatcher, without destructive interference.

---

## 2. Event Catalog & Emission Points

The following critical domain events will be actively recorded in the `outbox_events` table to power external integrations.

| Event Type | Aggregate | Emission Point (`orders/route.ts`) | Payload Shape |
| --- | --- | --- | --- |
| `account.paid` | `account` | `POST /accounts/:id/payments` <br/> (When `account.status` reaches `PAID`) | `{ account_id, total, paid_amount, visit_id, location_id }` |
| `payment.received` | `payment` | `POST /accounts/:id/payments` | `{ payment_id, account_id, method, amount, tip_amount, reference_code }` |
| `payment.refunded` | `refund` | `POST /payments/:id/refund` | `{ refund_id, payment_id, amount, reason, authorized_by }` |
| `order.cancelled` | `order` | `POST /orders/:id/cancel` and `/cancel-override` | `{ order_id, visit_id, location_id, reason, authorized_by }` |
| `order_line.voided` | `order_line` | `POST /order-lines/:id/void` and `/void-override` | `{ order_line_id, product_id, reason, authorized_by }` |

*Note: `order_line` state transitions (created, sent) are already emitted by the `outbox()` helper in `orders/route.ts`.*

---

## 3. Delivery Mechanism

To prevent slow external HTTP requests from degrading the sub-millisecond latency required by the KDS websocket feed, webhook delivery will be handled by a dedicated background process.

### The Webhook Dispatcher
A new worker class (`WebhookDispatcher`) will be added to `services/worker/src/`, running alongside the existing `OutboxDispatcher`.
- **Polling:** It queries `outbox_events` where `webhook_dispatched_at IS NULL`, grouped by `location_id`.
- **Subscription Resolution:** It joins the event's `location_id` to `locations` to find the `organization_id`, then queries active `webhook_subscriptions` for that organization where the `event_type` is included in the subscription's array.
- **Delivery:** Sends an `HTTP POST` to the configured `url`. 
- **Payload Wrapping:**
  ```json
  {
    "event_id": "uuid",
    "event_type": "payment.received",
    "occurred_at": "2023-10-01T12:00:00Z",
    "payload": { ... }
  }
  ```
- **Security:** Computes an HMAC-SHA256 signature of the raw JSON body using the subscription's `secret`. Passed via a standardized header: `X-Webhook-Signature: sha256=<hex_string>`.

### Error Handling & Retries
**Decision:** Fire-and-forget (0 retries). The worker will attempt the POST exactly once with a rigid 5-second timeout. Regardless of success, failure, or timeout, it will immediately mark `webhook_dispatched_at = NOW()` on the event.

**Justification:** For the "essential version," implementing backoff queues, dead-letter tables, and replay UIs constitutes a massive scope increase. Fire-and-forget is acceptable for Zapier/Make integrations. If strict delivery guarantees are needed, they belong in a future enterprise module.

---

## 4. Admin API & UI

### Permissions
Two new permissions will be added to the catalog and seed data (assigned to Owner/Manager roles by default):
- `integrations.webhooks.read`: View organization webhook subscriptions.
- `integrations.webhooks.write`: Create, edit, and delete webhook subscriptions.

### API Endpoints
- `GET /api/v1/organizations/:organizationId/webhooks`: List subscriptions.
- `POST /api/v1/organizations/:organizationId/webhooks`: Create a subscription. **Returns the generated plaintext `secret` once in the response.**
- `PUT /api/v1/organizations/:organizationId/webhooks/:id`: Update URL or events.
- `POST /api/v1/organizations/:organizationId/webhooks/:id/rotate-secret`: Regenerate the HMAC secret (returns it once).

### UI Integration
A new settings screen will be added to the Admin app (`apps/admin/src/Webhooks.tsx`), modeled after `DeliveryZones`. It will display a list of active subscriptions, an "Add Webhook" form, and a one-time alert modal to display the generated secret upon creation.

---

## 5. Printer / Receipt Support

Given the absence of existing printing functionality, we will implement the simplest, most universal solution: **Browser-Native Printing (`window.print()`) via Print Stylesheets**. This requires zero external dependencies, no PDF generation overhead, and supports any standard thermal or desktop printer registered with the host OS.

### User Actions
1. **Kitchen TicketBoard:** A new "Print Ticket" button on individual ticket cards.
2. **Customer Settlement / Accounts:** A "Print Receipt" action in the payment confirmation modal and on closed account details.

### Implementation Strategy
Instead of rendering invisible IFrames or generating PDFs, we will rely exclusively on CSS Media Queries (`@media print`).
- When a user triggers "Print Receipt" or "Print Ticket", the UI temporarily mounts a visually hidden `<PrintTemplate />` component containing the raw data (which is already loaded in the client state).
- Calling `window.print()` halts the browser and opens the OS print dialog.
- The `index.css` will include a `@media print` block that applies `display: none` to the App Shell (sidebar, nav, toolbars) and forces the `<PrintTemplate />` to `display: block` with a fixed `width: 80mm` (standard thermal receipt size), high-contrast monochrome text, and page-break rules.

---

## 6. Non-Goals

The following are explicitly excluded from this specification and the "essential version":

- **Vendor-Specific SDKs (Stripe, QuickBooks, Delivery Apps):** We cannot fabricate the necessary API credentials for self-hosted instances. Operators must utilize the generic webhooks + Zapier to wire up external services.
- **Built-in Email/SMS Sending:** Requires paid vendor accounts (SendGrid/Twilio). Operators can trigger emails via their own Zapier flow listening to `account.paid` webhooks.
- **Geocoding & Map Embeds:** Excluded for identical credential-availability reasons.
- **Inbound Data Workflows:** This framework is outbound-only. Importing marketplace delivery orders into the POS is a vastly more complex, distinct feature.
- **Native Printer Drivers / ESC-POS over LAN:** Hardware-level printer discovery (USB/Network) introduces extreme environmental complexity (CORS, mixed content, driver compilation). Browser printing outsources this complexity entirely to the OS.
- **Webhook Delivery Logs & DLQs:** Best-effort dispatch avoids the overhead of managing a massive secondary datastore of failed HTTP request bodies.

---

## 7. Open Questions

There are no unresolved ambiguities preventing the immediate implementation of this design. Constraints around permissions, RLS, and worker topologies have been definitively resolved based on existing project conventions.
