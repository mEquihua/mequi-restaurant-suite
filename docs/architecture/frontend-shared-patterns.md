# Frontend Shared Patterns

This document establishes how every one of the five PWAs (Admin, Staff, Kitchen, Self-Service, Customer) talks to the backend and manages state, so the first real frontend work (Staff/POS, Staff/Waiter, Kitchen) starts from one consistent foundation instead of each app inventing its own. It extends ADR 0001 section 5 (frontend framework choice) with the concrete conventions that were left as "your call" there.

## 1. Dependencies every operational app adds

- `react-router` — routing.
- `@tanstack/react-query` (MIT) — server state, caching, retries, and the optimistic-concurrency retry flow in section 4 below. Do not hand-roll fetch/cache logic per app.
- The generated OpenAPI client at `@restaurant-suite/contracts` (already exists) for request/response types — never hand-write a fetch call's shape from memory.

No global client-side state library (Redux/Zustand/etc.) for Foundation. TanStack Query's cache plus small local component state is sufficient for the operational surfaces; introduce one only if a real cross-cutting UI state need shows up that query caching can't express (there isn't one yet).

## 2. API client (`packages/contracts` gains a thin runtime wrapper, or each app's `src/api.ts`)

A single small `apiFetch` helper per app (or shared in a new `packages/api-client` package if the duplication becomes real — Foundation starts with one helper per app, promote to shared only when a second app needs the identical logic):

- Reads the base URL from an environment variable (Vite `import.meta.env`), not hardcoded, since the LAN-local origin differs per install.
- Attaches `Authorization: Bearer <token>` from the stored session (see section 3) to every request.
- Attaches `If-Match` when the caller passes an expected version (see section 4).
- On a `401`, clears the stored session and redirects to the PIN-unlock screen — a shared terminal must never keep acting as a now-invalid identity.
- Throws a typed error carrying the parsed `{ error: { status, code, message, request_id, details } }` body so calling code can branch on `code`, not on parsing prose.

## 3. Session storage

- The opaque session token from `POST /api/v1/auth/pin-unlock` is stored in memory plus `sessionStorage` (not `localStorage`) — a shared terminal's browser tab closing should not silently keep a previous operator's session resumable indefinitely. Re-unlocking is fast (PIN + terminal credential already provisioned), so this is not a real friction cost.
- The terminal credential from `POST /.../terminals/enroll` (long-lived) is the one thing that *does* persist in `localStorage`, scoped per-origin per-terminal, since re-enrolling a physical terminal on every browser restart would defeat the point of enrollment.
- On app load: if a terminal credential exists but no active session, show the PIN-unlock screen. If neither exists, show the enrollment flow (Owner/Manager only, gated by `iam.terminals.enroll`).

## 4. Optimistic concurrency in the UI

Every mutation that requires `If-Match` follows the same shape:
1. The screen holds the current `version` from its last successful read (TanStack Query cache).
2. On submit, send that version as `If-Match`.
3. On a `409` with the standard `{ current_version, current_state }` details payload, do not silently retry with the server's version. Show the user the conflict plainly (e.g. "This order changed since you last saw it — reloaded with the latest.") and refresh the view from `current_state`, requiring a deliberate second action to proceed. Silent auto-merge is explicitly disallowed by ADR 0001 section 4.

## 5. Realtime (once `feature/realtime-worker` lands)

A single `useRealtime(locationId)` hook per app (in a new shared `packages/ui-operations` or app-local `src/realtime.ts` — promote to shared once two apps need it) that:
- Opens the WebSocket at `/api/v1/realtime` with the same bearer token used for REST.
- On any message, invalidates the relevant TanStack Query cache keys (e.g. an `order_line.sent` event invalidates that order's query) rather than trying to hand-merge the push payload into cached state. The WebSocket is a "go refetch" signal, never a trusted source of the final state — this matches the ADR's explicit rule that a client must rehydrate authoritative state via REST, never treat a push event as proof a mutation succeeded.
- Reconnects with backoff on drop, and on reconnect immediately invalidates the app's active queries once (covers whatever was missed while disconnected, since Valkey Pub/Sub has no replay).

## 6. What Foundation's first frontend pass does NOT need yet

- No IndexedDB command outbox / offline mutation queuing. ADR 0001 section 5 describes this as part of the longer-term installable-PWA offline story; the Foundation success criterion (idea.md section 129) is a restaurant completing the core loop on the local network with the API reachable, not surviving a total local outage while mutating data. Build clear loading/error/retry states for a request that fails, not a queue that replays it later. Revisit this once the core screens are real and in use.
- No service-worker precaching beyond what the scaffold already generates. Deeper offline shell behavior is the same deferred item as above.

## 7. Design system usage

Per `docs/design-reference.md`: Staff/POS and Kitchen use the "spacious/touch-first" density from `packages/ui-operations`; any admin-style configuration screens (e.g. floor-plan editing) use `packages/ui-admin`'s denser components. Both consume the same `packages/ui-tokens`. Do not fork color/spacing values locally in an app — extend the shared tokens package if something is missing.
