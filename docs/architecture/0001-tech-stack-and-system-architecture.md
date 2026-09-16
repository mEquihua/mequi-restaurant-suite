# ADR 0001: Technology Stack and System Architecture

- **Status:** Accepted (revised after independent review)
- **Date:** 2026-09-15
- **Scope:** Restaurant Suite core architecture

## Revision history

- **2026-09-15 — independent-review revision:** removed the separate persistent broker and retained PostgreSQL outbox durability with Valkey Pub/Sub only for ephemeral WebSocket fan-out.
- Made modular-monolith boundaries mechanically enforceable in CI, so concurrent worktrees cannot import another module's persistence internals.
- Replaced the split-horizon-DNS prerequisite with product-managed mDNS and locally trusted HTTPS for enrolled LAN terminals, preserving PWA behavior during WAN loss.
- Replaced static QR capabilities with server-side table sessions, scoped PIN backoff to terminals, and removed deployment-specific tunnel naming.

## 1. Summary of the decision

Restaurant Suite will be a **pnpm-workspace TypeScript monorepo** implemented as a **modular monolith**: five independently deployable React PWAs call one Fastify REST API, which owns all transactional business rules and a single PostgreSQL database. PostgreSQL is the authoritative store for menu, orders, tables, accounts, inventory, identity, and audit history. A transactional outbox records committed domain events; a worker dispatches durable work from it and publishes transient notifications through Valkey Pub/Sub, which API instances fan out as scoped WebSocket updates to Kitchen, Staff, Self-Service, Admin, and Customer clients. This keeps the installation small enough for a self-hosted restaurant server while preserving one coherent operational model, real concurrency control, durable auditability, and clear module boundaries for parallel development.

The selected foundations are permissively licensed and actively maintained: TypeScript/Node.js, React, Vite, Fastify, PostgreSQL, Valkey, Traefik, and the proposed testing tooling use MIT, BSD-family, or the PostgreSQL License. Redis is deliberately not selected because current Redis licensing is not permissive. Every future runtime and build dependency must pass a license and security review before it is added; AGPL, GPL, LGPL, SSPL, BSL, source-available, and commercial dependencies require an explicit ADR exception.

## 2. System shape

### Repository and module boundaries

Use one monorepo. The five applications, API, worker, contracts, UI primitives, and deployment configuration must change together often enough that separate repositories would add release and contract coordination overhead without creating a meaningful operational boundary. A monorepo also makes a single versioned, self-hosted installation practical.

```text
apps/
  admin/                 # Restaurant Admin PWA
  staff/                 # Restaurant Staff PWA: waiter, POS, host
  kitchen/               # Restaurant Kitchen PWA / KDS
  self-service/          # Kiosk, table/QR, and order-status PWA modes
  customer/              # Public customer PWA: menu, ordering, loyalty, reservations
services/
  api/                   # Fastify HTTP API, WebSocket gateway, domain modules
  worker/                # Outbox dispatcher, scheduled work, integrations
packages/
  contracts/             # OpenAPI 3.1, event schemas, generated TS clients
  domain/                # Backend-only domain types, policies, commands, tests
  ui-tokens/             # Design tokens, localization-safe formatting rules
  ui-primitives/         # Accessible React primitives; no application layouts
  ui-admin/              # Dense administration components
  ui-operations/         # POS/KDS/touch-oriented components
  config/                # Shared TypeScript, lint, test, and build configuration
infra/
  compose/               # Production and development Compose definitions
  traefik/               # Gateway and routing configuration
  cloudflared/           # Tunnel examples, never committed credentials
docs/
  architecture/
```

`services/api` is a modular monolith, not a disguised set of microservices. It contains explicit modules such as `identity`, `locations`, `module-center`, `menu`, `floor`, `orders`, `accounts-payments`, `kitchen`, `inventory`, `reservations`, `loyalty`, `reporting`, `devices`, and `integrations`. Each module owns its use cases, database migrations/tables, REST operations, event definitions, and tests. Cross-module changes go through commands and published domain events, not arbitrary imports into another module's persistence code.

This boundary is mechanically enforced with **`eslint-plugin-boundaries`** in the root shared ESLint configuration. Every API file is tagged with its owning module; each module exposes an explicit public entry point, while `persistence`, migrations, and other implementation paths are private. The rule permits another module to import only that public entry point or the shared `packages/contracts`/`packages/domain` API, and rejects every import into another module's private path, especially persistence. `pnpm lint` must load this configuration for every workspace, and CI runs it as a required merge gate; a forbidden cross-module persistence import therefore fails the build rather than relying on review discipline. This is deliberately retained as one deployable API while providing a deterministic safeguard for concurrent AI-agent worktrees.

The `worker` is a separately deployed process from the same source tree and release image. It performs outbox delivery, scheduled work, reporting projections, media processing, and optional external integration jobs. It never becomes an alternative writer for core state: it invokes the same application use cases or writes only its own module's data.

### Deployable units and shared contracts

Each of the five `apps/*` packages produces a separate static web bundle and is a separately routable deployable unit. That lets a dedicated kitchen tablet load only Kitchen and lets public Customer have a deliberately different exposure policy. A single `web` container may serve all five version-matched bundles behind Traefik; separate bundles do **not** require five Node servers.

All application-to-server operations are REST operations described in `packages/contracts/openapi.yaml`. Generated TypeScript clients and request/response types are consumed by the five apps; generated files are committed so worktrees can build independently, and CI fails when generated output is stale. WebSocket event payloads live in versioned event schemas in the same package. UI packages share tokens, primitives, icons, formatting, and status vocabulary only. They must not share route trees, page layouts, or app-specific state.

## 3. Backend

The backend will use **Node.js LTS and TypeScript with Fastify**, using JSON Schema request/response validation and parameterized PostgreSQL queries. Fastify is mature, strongly suited to schema-first HTTP APIs, has a small operational footprint, and is MIT licensed. TypeScript across apps, API, workers, and contract generation removes a language boundary while OpenAPI remains the language-neutral, reviewable contract for agents and future integrations.

The external and internal application API will be **REST over HTTPS**, versioned under `/api/v1`, documented as OpenAPI 3.1. Commands are explicit resources/actions such as `POST /orders/{id}/send`, `POST /accounts/{id}/payments`, and `POST /orders/{id}/voids`; they are not a generic CRUD surface. REST makes authorization, idempotency, tracing, generated clients, webhooks, and future third-party integrations straightforward. WebSockets are receive-only server push for authenticated clients; mutations always use REST so they receive normal validation, idempotency, authorization, audit, and conflict handling.

This is intentionally not a fleet of backend services. A restaurant's most important operations cross orders, tables, accounts, payments, inventory, and kitchen routing in one transaction. Splitting them prematurely would turn normal restaurant actions into distributed transactions and make a small self-hosted install harder to run. The module boundary is a code and contract boundary now; an individual module can be extracted later only when a measured operational need justifies the added distributed-system cost.

Security is structural in the API:

- Validate every request at the boundary; reject unknown fields where practical and use parameterized SQL only. Never concatenate user input into SQL.
- Use allowlisted, typed commands and server-owned state transitions. React's normal output escaping is retained; a strict CSP, secure headers, output sanitization for any rich text, and upload content validation protect browser surfaces.
- No server-side arbitrary URL fetches. Integration connectors use an explicit egress allowlist, DNS/IP revalidation, timeouts, and block loopback/private destinations to prevent SSRF.
- Use CSRF tokens for cookie-authenticated mutating requests, `Secure`/`HttpOnly` cookies, origin checks, rate limits, request size limits, and audit logging. Secrets are mounted as Docker secrets or root-readable files, never committed or logged.

## 4. Data layer, realtime, and concurrency

### Primary data model

Use **PostgreSQL** (a pinned, supported major release; initially the PostgreSQL 17 image line) as the only system of record. It is mature for relational transactions, constraints, reporting, full-text needs, JSON where appropriate, backups, and self-hosting; its PostgreSQL License is permissive. Product data remains relational and normalized. SQL migrations are reviewed source files; no application is permitted to modify production schema outside migrations.

This installation serves one organization, not unrelated SaaS tenants. There is one organization row as an installation invariant and a `location` table. Every operational record that is location-specific has a non-null `location_id`: orders, visits, tables, accounts, payments, inventory movements, devices, shifts, kitchen stations, reservations, and location configuration. Organization-level definitions such as products, recipes, customers, and roles remain shared, with explicit location assignment/override tables for price, availability, hours, menus, and permissions. This yields shared data without accidental cross-location operations.

The API sets the authenticated actor and permitted location scope at the start of every transaction. Central policy checks are the primary authorization mechanism; PostgreSQL row-level security on location-scoped tables is a second enforcement boundary against accidental query omissions. A restricted migration role and a separate runtime role are required. There is no database-per-location split: it would make shared customers, loyalty, cross-location reporting, catalog governance, and atomic operations needlessly complex.

### Realtime delivery

Every committed state change that needs notification writes an `outbox_event` in the **same PostgreSQL transaction** as the aggregate change and audit record. The worker claims pending rows with transactional leases, executes durable background/integration work with retry and idempotency, and publishes notification envelopes to Valkey Pub/Sub only after the committed outbox row is available. It records completed durable dispatch; a crash around publication can produce a duplicate, so consumers use the stable event ID, aggregate ID, location, schema version, and sequence idempotently. PostgreSQL, not Valkey, is the durable delivery record and source of truth.

Fastify API instances subscribe to authorized Valkey Pub/Sub channels and fan out compact, location- and device-scoped messages through WebSockets. Kitchen tickets, table status, order status screens, stock-out changes, waiter requests, and Customer order status therefore receive push updates rather than polling. WebSocket payloads identify the authoritative aggregate version; a reconnecting or out-of-sequence client rehydrates through REST. The client must never treat an event as proof that an unacknowledged mutation succeeded.

Valkey Pub/Sub is intentionally fire-and-forget: it has no consumer replay or durable notification queue. A Valkey restart, a temporarily disconnected API instance, or a disconnected WebSocket client can lose a realtime notification. That loss is acceptable because events are only a freshness hint and every client already rehydrates authoritative state through REST on reconnect, version gaps, or resubscription. The PostgreSQL outbox still gives durable retry semantics to background jobs and integrations; it is not replaced by Pub/Sub. Valkey also provides ephemeral rate-limit counters, cache entries, and WebSocket presence; it holds no product truth and can be rebuilt after restart. Valkey is BSD-3-Clause licensed. This explicitly avoids Redis's non-permissive current licensing and removes a separate persistent broker from the restaurant installation.

### Concurrent edits and irreversible operations

All commands execute in short PostgreSQL transactions. Aggregates that can be edited concurrently (`order`, `visit/table occupancy`, `account`, menu availability, reservation allocation) have a monotonic `version`. A client sends the version it read as `If-Match` (or the equivalent explicit command field); updates use `WHERE id = $id AND version = $expectedVersion` and increment the version. A mismatch returns `409 Conflict` with the current representation, current version, and machine-readable changed state. The UI must show the change and let the user retry/rebase; it must not silently overwrite it.

The server additionally enforces invariants with constraints and transaction-level locks where required: one active visit per table relationship, legal state-transition tables, capacity rules, non-negative payment/refund totals, and unique idempotency keys. Adding an independent order line is modeled as an idempotent command, so two people adding distinct items does not create a false conflict. Sending, cancelling, moving items, discounts, voids, payments, refunds, inventory adjustments, and assigning a table are serialized through the relevant aggregate version and rules. Payments and external webhooks require an idempotency key and provider event ID; they are never retried as a blind browser operation. Sensitive changes append immutable business/audit events with actor, terminal/device, reason, request ID, and before/after version.

## 5. Frontend

All five experiences will use **React with TypeScript and Vite**, not five different frameworks. React has the largest suitable ecosystem for dense operations UIs, touch-oriented experiences, accessibility tooling, and test automation; React and Vite are MIT licensed. Use React Router, TanStack Query, and a small shared fetch client generated from OpenAPI. Vite builds static bundles that can be served locally without a Node rendering tier.

This ADR deliberately does **not** choose SSR for the initial product. Four apps are authenticated, highly interactive operational surfaces where SSR provides little value. Customer ordering needs reliable menu access and fast navigation, not server-rendered marketing pages; its public content is fetched from the local API and cached appropriately. Deferring SSR avoids a second rendering/data-cache model and preserves local resilience. If public SEO or a marketing site becomes a measured requirement, add a separate SSR/static marketing surface later without changing the operational apps or REST contracts.

Admin and the operational/customer apps share a token-based design system, not a one-size-fits-all layout:

- `ui-tokens` defines color/state, typography, spacing, focus, touch-target, dark-mode, and internationalized number/date tokens.
- `ui-primitives` supplies accessible buttons, inputs, dialog, status badge, table primitives, and form behavior.
- `ui-admin` implements dense desktop shells, data tables, filters, saved views, and configuration forms.
- `ui-operations` implements large targets, menu grids, cart/ticket lanes, timers, and low-chrome device shells.

Admin can therefore be compact and data-dense while Kiosk, QR/Table, Customer, POS, and KDS deliberately use spacious, touch-first layouts and state labels. Shared status semantics never rely only on color.

Staff, Kitchen, Self-Service, and Customer are installable PWAs; Admin is also installable where useful but is not optimized for an unattended device. Each has its own manifest, icons, scope, and service worker. Workbox precaches the versioned shell and essential static assets. IndexedDB stores the local read cache and a constrained command outbox; commands have client-generated idempotency keys and expected versions. The app clearly distinguishes `offline shell`, `waiting to sync`, `synchronized`, and `conflict` states. It must not claim that a queued command has succeeded before the server acknowledges it.

## 6. Local resilience

The normal local path is **browser on the restaurant LAN -> Traefik -> static web bundle/API -> PostgreSQL/Valkey on the same Docker host**. It does not traverse Cloudflare Tunnel, public DNS, a payment provider, email/SMS, or any cloud API. Thus waiter ordering, table changes, KDS receipt/preparation, local status displays, cash payments, and local reports continue when external internet fails. Cloudflared is an outbound ingress connector for remote/public traffic only; its loss must not make the LAN gateway unavailable.

Restaurant Suite ships a bundled `local-connectivity` service in its Compose release. It advertises a stable per-installation `*.local` hostname through mDNS and operates a private local certificate authority; Traefik serves a certificate for that hostname issued by this authority. During the one-time guided installation, the product enrolls each restaurant-owned Staff, Kitchen, Kiosk, and POS terminal: it installs/trusts the local CA by the platform's normal managed-profile or administrator flow, verifies the `https://<installation>.local` route, and installs/opens the relevant PWA. No split-horizon DNS, custom DHCP option, router configuration, or owner-managed CoreDNS is required. mDNS resolves locally without WAN access, and the trusted HTTPS origin remains a secure context, so the service worker and installable-PWA behavior continue during a WAN outage.

The public Cloudflare hostname remains for remote and ordinary public Customer access and uses its normal publicly trusted certificate when WAN is available. A device that was never enrolled for the local CA—such as a brand-new personal phone scanning a QR during an outage—may be unable to resolve the local name, trust its certificate, or register a service worker; it is not promised full local PWA behavior. It can use the public route once WAN returns or be deliberately enrolled by staff where that is appropriate. The core Staff/Kitchen/POS loop is guaranteed only for the restaurant's enrolled terminals, whose local hostname, trust, and PWA installation are validated during setup. The product must not offer an untrusted HTTP/IP fallback as a substitute for this path, because it would not satisfy the secure-context requirement for service workers.

For brief LAN/Wi-Fi blips, the PWA shell and last known safe read state remain available. Safe, order-preserving commands can queue locally and replay in order after reauthentication/reconnection; the server still applies idempotency and version checks. Kitchen may keep displaying cached tickets and queue a completion command, but it shows a prominent stale/offline state. Card authorizations, payment captures, provider webhooks, external Customer orders, email/SMS, maps/geocoding, and remote Cloudflare access are explicitly unavailable without their providers. Card payments are only considered locally available when the selected terminal/provider offers a documented local/offline authorization flow; otherwise the POS presents a clear payment outage and cash/manual methods remain usable. Full multi-device operation during a total LAN/server outage is not promised by this ADR and must not be misrepresented as PWA offline support.

## 7. Authentication and permissions

Identity is a first-party module because the product requires fast, attributable switching on shared restaurant terminals. Staff authenticate with an individual badge/QR/NFC credential plus PIN; a password-based login exists for admin/setup and recovery. PINs are stored with Argon2id. Failed PIN attempts are rate-limited and receive escalating time-delay backoff **per enrolled terminal/device and presented credential**, never a global account lockout; a person at one terminal cannot deny a manager access from another terminal during a shift. A terminal must be enrolled as a device before it can enter shared-terminal mode. Unlocking creates a short-lived personal operator session associated with the terminal and location. Switching cashier/waiter never reuses the previous person's identity; every command and audit event carries the actual operator and device. Reauthentication is required for manager overrides, voids, refunds, cash-drawer operations, and other configured high-risk commands.

Sessions are opaque, revocable, server-stored sessions with hashed tokens, short inactivity windows for shared terminals, and secure cookie transport. Do not put broad permissions into long-lived browser JWTs. Initial owner bootstrap is a one-time installation flow; recovery credentials and database secrets are handled outside browser-accessible configuration.

Customer access is guest-first. A guest receives a minimal, short-lived order session; no email, phone, or account is required to create an allowed order. A customer account is optional and separately authenticated/verified. A physical table QR encodes only a stable, non-secret location/table identifier and URL; it is never a signed capability or a bearer credential. On scan, the server validates the table and its current ordering state, then mints an opaque, short-lived, server-stored customer session bound to that table and device/browser. That session grants only the current table's allowed menu/order/request operations under the location configuration.

When an account is paid and the table is closed, the server invalidates every customer session for that table before any later table session can be used. Staff/POS has explicit audited commands to force-close a table's ordering session or re-open it for a new visit, including when a table is moved or service needs intervention. This requires server-side session and table-visit state rather than a self-contained signed QR token, but permits immediate revocation and prevents a photographed sticker from remaining an indefinitely valid ordering capability.

Authorization is central policy-as-code backed by database-managed RBAC and scope:

1. Roles grant named permissions such as `orders.create`, `orders.move_items`, `orders.void`, `accounts.split`, `payments.refund`, `cash.open_drawer`, `menu.price.update`, `inventory.adjust`, and `reports.read`.
2. Permission grants have organization/location, module, device-mode, and (where needed) ownership/section scope. A waiter can be limited to assigned tables; Kitchen devices can be limited to their station.
3. Each command passes a server-side policy decision before it reaches a domain use case. Deny is the default; clients only use permissions to shape the UI, never to authorize themselves.
4. Manager override is a distinct authenticated approval record and audit event, not a mutable `isManager` flag supplied by a client.

This provides granular configurable roles without introducing an authorization service that would be disproportionate for a single-organization installation. PostgreSQL location RLS provides defense in depth, but policy-as-code remains the auditable business authorization decision point.

## 8. Deployment and networking

The production baseline is one Docker Compose project with named volumes, resource limits, health checks, and no published database/broker/cache ports. The concrete service set is:

| Service | Responsibility | Exposure / persistence |
| --- | --- | --- |
| `traefik` | Local TLS, host routing, headers, static/API routes | Only LAN HTTP(S); no application data |
| `web` | Serves all five immutable, version-matched PWA bundles | Internal behind Traefik |
| `api` | Fastify REST API and WebSocket gateway | Internal behind Traefik; horizontally scalable later |
| `worker` | Outbox dispatch, scheduled jobs, projections, integrations | Internal only |
| `postgres` | Authoritative relational data and outbox/audit history | Named volume; internal only |
| `valkey` | Ephemeral Pub/Sub, rate limits, cache, and presence | Internal only; persistence not required |
| `local-connectivity` | Product-managed mDNS advertisement and local CA/certificate lifecycle for enrolled LAN terminals | Internal/LAN only; local CA material stored as a protected secret/volume |
| `cloudflared` | Optional outbound public ingress connector | No inbound host ports; tunnel token as a secret |

Traefik is MIT licensed. It must route public Customer traffic and authorized remote Admin/Staff traffic separately. Cloudflare Access protects remote administrative hostnames; Customer ordering remains public but has API rate limits, bot/WAF controls, and checkout protections. The tunnel receives only Traefik routes, never PostgreSQL, Valkey, Docker, or SSH. A deployment may route Restaurant Suite public hostnames through a generically named existing tunnel (for example, `restaurant-tunnel`) on a shared Docker edge network, or use the dedicated `cloudflared` service; do not run two connectors with overlapping ingress rules.

This is compatible with Coolify-style Git-push deployment, but Coolify is **not required** and is not the deployment authority. A compatible deployment platform may build/deploy the stateless `web`, `api`, and `worker` images from this monorepo, provided all services remain pinned to one release and use the same Compose network. For the initial restaurant install, a versioned Compose release is preferred because it keeps PostgreSQL, Valkey, migrations, backup paths, local HTTPS/device enrollment, and rollback behavior explicit. If a platform proxy is used, it must be the sole owner of the relevant ports; do not add a competing Traefik instance. Stateful volumes and backups remain owned by the Restaurant Suite Compose project, not an opaque platform abstraction.

Use Docker secrets (or root-owned secret files referenced by Compose) for database credentials, session signing keys, Cloudflare API/tunnel tokens, and integration keys. CI builds immutable tagged images, migrations run as an explicit pre-deploy step with a verified backup, and a health/readiness check gates traffic. Scheduled encrypted PostgreSQL backups must go to a local removable/NAS target; an optional off-site copy is an operator choice, never a core availability dependency.

## 9. Testing, release, and CI

Testing follows the architecture boundary rather than relying on end-to-end tests alone:

- **Domain/unit tests:** state machines, pricing/tax calculations, permissions, availability, idempotency, and conflict behavior run without a browser.
- **Database integration tests:** real PostgreSQL migrations and transactions verify constraints, RLS, outbox atomicity, and simultaneous command races. Each module owns fixtures and test data builders.
- **Contract tests:** API implementations validate against OpenAPI; generated client compatibility and WebSocket event schema compatibility are checked in CI. Breaking contracts require a versioned migration path.
- **Browser/PWA tests:** Playwright exercises Staff, Kitchen, Kiosk, QR/Table, Customer guest checkout, Admin, accessibility-critical paths, reconnect, queued safe commands, and visible offline/stale states.
- **Security tests:** static analysis, dependency/SBOM and license policy checks, secret scanning, OWASP-oriented API tests, authorization-negative tests for every sensitive command, and image vulnerability scanning are mandatory merge gates.
- **Operational tests:** Compose smoke tests start the production-shaped stack, run migrations, place an order, observe Kitchen push, mark it ready, and verify Staff/Customer updates. They also verify that an enrolled terminal reaches the mDNS local hostname with a trusted certificate and can register its service worker while WAN simulation is unavailable. Backup restore is rehearsed on a disposable database before every release process is declared reliable.

CI runs formatting, the required module-boundary lint rules, type checking, unit/domain tests, migrations, contract generation drift checks, integration tests, and targeted Playwright tests on pull requests. Protected main releases additionally build signed images, generate an SBOM, scan images, run the Compose smoke suite, and publish release notes with migration/rollback instructions. Agents work in separate worktrees/branches but may not change an API/event schema without the owning contract package and compatibility tests.

## 10. Explicitly rejected alternatives

### Backend framework and architecture

- **NestJS:** rejected as the primary backend framework. It is MIT licensed and viable, but its decorator/container-heavy conventions add ceremony and hidden runtime wiring without improving the transactional modular-monolith requirement. Fastify with explicit modules and schemas is simpler to inspect, test, and parallelize. NestJS is not banned for extensions; it is simply not the core decision.
- **Go microservices:** rejected. Go is excellent for isolated high-throughput services, but it would split the team across languages and turn normal order/account/table actions into distributed coordination. It violates the operational simplicity goal at this stage.
- **GraphQL or tRPC:** rejected as the primary application contract. GraphQL adds a second authorization/query-cost surface and weaker obvious HTTP cache/audit semantics; tRPC couples every external consumer to TypeScript. OpenAPI REST is more stable for five apps, code agents, hardware, and future integrations.

### Database and event alternatives

- **MongoDB:** rejected. Its SSPL licensing fails project policy, and document-first modeling is a poorer fit for restaurant accounting, inventory movements, constraints, and relational reporting.
- **SQLite as the shared primary database:** rejected. SQLite is excellent embedded software but is not the right concurrency and networked multi-user authority for simultaneous POS, KDS, and customer order traffic on this installation.
- **Redis as cache/queue:** rejected because current Redis licensing is not permissive. Valkey provides the required ephemeral capability under BSD-3-Clause.
- **Any separate durable broker:** rejected for this single-host installation. The PostgreSQL outbox already provides durable retry for background work; realtime browser delivery does not require replay because clients rehydrate authoritative state through REST. Adding a persistent broker would add volume, backup, and operational complexity without improving that recovery path.
- **PostgreSQL `LISTEN/NOTIFY` alone:** rejected as the primary realtime fan-out mechanism. It provides neither durable job dispatch nor the already-standardized shared Pub/Sub interface used for API-instance WebSocket fan-out; PostgreSQL outbox plus Valkey Pub/Sub separates those concerns.

### Frontend alternatives

- **Next.js for all five apps:** rejected for the initial operational suite. It is MIT licensed and mature, but SSR/React Server Components introduce a server-rendering/cache layer and five server workloads where the core apps gain little. Static Vite PWAs have fewer moving parts on a local Docker host and clearer LAN-outage behavior. A future separate Customer marketing/SEO surface may use Next.js without replacing the operational architecture.
- **Native mobile applications:** rejected for the initial five experiences. They would add platform-specific releases, device management, and separate offline behavior before the restaurant's web/PWA workflows are proven. The PWA approach supports tablets, kiosks, terminals, and customer phones from one codebase.
- **One shared responsive layout:** rejected. It would directly conflict with the design reference: dense admin/reporting and POS/KDS/kiosk/customer touch workflows require distinct shells, densities, and interaction patterns even though they share visual tokens and primitives.

## 11. Deferred risks and follow-up decisions

The following are deliberately not decided here; each needs a focused ADR before implementation reaches it:

1. **Payments:** choose provider adapters, terminal hardware, country-specific fiscal requirements, PCI scope, offline-card behavior, refunds, and reconciliation. The core payment interface is provider-neutral.
2. **Printing and hardware bridge:** decide the local agent/protocol for ESC/POS printers, cash drawers, scanners, and customer displays. Browsers alone cannot reliably cover all hardware.
3. **Media storage:** define image upload retention, virus scanning, image transformation, and an optional S3-compatible external store. The initial local volume is not a long-term media platform.
4. **Backup retention and disaster recovery:** define encryption keys, retention, restore authorization, NAS/off-site targets, and recovery-time objectives; test restores before production claims.
5. **LAN device onboarding and local trust:** document the guided terminal enrollment/profile flows, mDNS hostname/host-address recovery, local-CA rotation and recovery, Wi-Fi segmentation, and the explicit limitations for un-enrolled personal devices.
6. **Public Customer scale and SEO:** decide whether measured public marketing/SEO needs justify a separate SSR/static rendering surface or CDN caching policy.
7. **Integration/plugin boundary:** define signed/verified extensions, webhook retries, connector credentials, egress policy, and the compatibility promise. Do not allow plugins direct writes to core tables.
8. **Analytics/reporting scale:** begin with PostgreSQL read models; decide on a separate analytical store only after measured reporting load makes it necessary.
9. **Data retention, privacy, and jurisdiction:** decide customer-data retention, export/deletion workflows, consent, and local tax/privacy requirements per deployment country.
10. **High availability:** this ADR targets one local Docker host. Replication, standby hardware, and multi-host failover are later operational decisions, not implied by the outbox, Valkey, or PWA use.

## License verification baseline

The named infrastructure choices were checked on 2026-09-15 against their upstream repositories/licenses: Fastify (MIT), React (MIT), Vite (MIT), PostgreSQL (PostgreSQL License), Valkey (BSD-3-Clause), and Traefik (MIT). Pinning an image or package version does not waive the dependency review gate; CI must produce an SBOM and reject prohibited licenses for the full transitive dependency set.
