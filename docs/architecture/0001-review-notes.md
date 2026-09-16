# Review Notes: ADR 0001 (Tech Stack and System Architecture)

**Verdict:** Send back for rework

### Findings

**1. Operational Complexity vs. Self-Hosting Goal**
- **Severity:** Blocker
- **Section:** 4. Data layer, realtime, and concurrency (Realtime delivery)
- **Claim:** "The worker claims outbox rows, publishes them to a local NATS JetStream stream... NATS JetStream is selected because it supplies durable local pub/sub and consumer replay"
- **Why it's a problem:** Adding a separate stateful persistent broker (NATS JetStream) with its own volume management and clustering concepts to a single Docker host installation violates the "no consultant needed" rule (`idea.md` Section 128). The ADR already specifies that clients rehydrate via REST upon reconnection, meaning they do not even utilize NATS's durable replay. This is premature infrastructure that makes backups and operations needlessly complex for a small restaurant owner.
- **Proposed Fix:** Remove NATS JetStream. Have the worker process the PostgreSQL outbox table directly for durable background jobs. For ephemeral WebSocket fan-out, use PostgreSQL `LISTEN/NOTIFY` or the already-included Valkey Pub/Sub.

**2. Multi-Agent Development Enforceability**
- **Severity:** Blocker
- **Section:** 2. System shape (Repository and module boundaries)
- **Claim:** "`services/api` is a modular monolith... Cross-module changes go through commands and published domain events, not arbitrary imports into another module's persistence code."
- **Why it's a problem:** There is no mechanical enforcement of this boundary described. In a multi-agent AI development environment, agents working concurrently will ignore documentation promises to fix immediate errors and silently import internals from other modules, rapidly eroding the modular monolith into a tightly-coupled mess.
- **Proposed Fix:** Mandate a concrete mechanical enforcement mechanism. Either extract the backend modules into distinct packages within the pnpm workspace (e.g., `packages/api-modules/inventory`), or explicitly mandate a static analysis boundary rule (such as `eslint-plugin-boundaries` or Nx boundary constraints) that fails the CI build on cross-module imports.

**3. Local Resilience vs. IT Sophistication**
- **Severity:** Blocker
- **Section:** 6. Local resilience
- **Claim:** "The LAN must use split-horizon DNS... A router/DHCP DNS override or a separately managed CoreDNS service provides this local resolution. This network setup is a production prerequisite..."
- **Why it's a problem:** A typical restaurant uses a basic ISP-provided modem/router which cannot configure split-horizon DNS or custom DHCP DNS servers. If the WAN connection drops, DNS TTLs expire, and public DNS becomes unreachable, meaning local devices won't be able to resolve the hostnames. Requiring a managed CoreDNS server assumes an IT network engineer is deploying this, which directly contradicts `idea.md`'s explicit constraint that the product should not require a consultant (Section 128).
- **Proposed Fix:** Drop split-horizon DNS as a hard prerequisite. Support local IP address fallback (with acknowledged TLS warnings for offline emergencies) or mDNS (`.local` addresses) for the LAN layer, decoupling the local operational capability from enterprise network administration.

**4. Security - QR Code Capability Tokens**
- **Severity:** Blocker
- **Section:** 7. Authentication and permissions
- **Claim:** "Table QR codes contain signed, scoped, expiring server-verifiable capabilities for one location/table/device context, not predictable table IDs"
- **Why it's a problem:** Physical QR code stickers placed on restaurant tables cannot practically "expire" without forcing the staff to reprint and replace stickers daily. If the sticker is static but contains a long-lived capability token, a malicious customer can photograph it and place fake orders from home indefinitely, or spy on the current table's orders.
- **Proposed Fix:** The physical QR code must contain only a static location and table identifier, not a capability token. When scanned, the server should create a dynamic session that either requires Staff/POS approval to "open" the table, or the server must automatically invalidate all previous customer sessions for that table once the table is paid and closed.

**5. Security - PIN Rate Limiting DoS**
- **Severity:** Should-fix
- **Section:** 7. Authentication and permissions
- **Claim:** "PIN attempts are rate-limited and locked out"
- **Why it's a problem:** If PIN lockouts are applied globally to a user account, a malicious user or disgruntled employee can intentionally enter the manager's PIN incorrectly on a public kiosk or shared POS terminal to lock the manager out of the system during a busy shift (Denial of Service).
- **Proposed Fix:** Rate limit PIN attempts per-terminal/device, not globally per-user, or require a time-delay rather than a hard account lockout for shared-terminal environments.

**6. Context Bleed / Hardcoded Configuration**
- **Severity:** Minor
- **Section:** 8. Deployment and networking
- **Claim:** "The current `coolify-mequihua` tunnel can route the Restaurant Suite public hostnames..."
- **Why it's a problem:** Hardcoding a specific user's infrastructure tunnel name (`coolify-mequihua`) is an anti-pattern for a generic, community-driven self-hosted product.
- **Proposed Fix:** Remove the user-specific reference and use a generic example like `restaurant-tunnel`.

### Validated Claims

- **License Review:** The license claims for Fastify (MIT), React (MIT), Vite (MIT), PostgreSQL (PostgreSQL License), NATS Server (Apache-2.0), Valkey (BSD-3-Clause), and Traefik (MIT) were sanity-checked and are genuinely sound. The intentional exclusion of Redis due to recent non-permissive licensing changes is also correct and appropriate.
- **Concurrency & Source of Truth:** The design for handling concurrent edits (`If-Match` version headers) successfully addresses the `idea.md` constraints for preventing silent overwrites while sharing a single source of truth.
