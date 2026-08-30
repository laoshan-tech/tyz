# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

TYZ is a tunnel relay management platform in a Bun-workspaces monorepo:

- **Control plane** (`apps/server`): Cloudflare Worker (Hono) + D1 (SQLite). Serves the admin panel (assets + CRUD API) and the agent API (versioned config polling, batched stats upload).
- **Node agent** (`apps/agent`): a single Rust binary (nightly, pinned via `rust-toolchain.toml`) with a self-built realm-ecosystem data plane: `realm_io` splice zero-copy forwarding, `kaminari` TLS links, `realm_lb` multi-exit load balancing. Polls config (WS push first, HTTP fallback), diffs services in-process (changed services rebuild; live connections survive; dead listeners self-heal), and reports cumulative traffic counters + service health. Deployed as one container per relay machine (Docker, host network). See `docs/agent-realm-rust-refactor.md` for the full design record.
- **Admin web** (`apps/web`): **React 19.2** + Vite + **HeroUI v3** (`@heroui/react` 3.2.x + `@heroui/styles`, built on React Aria Components + **Tailwind CSS v4** via `@tailwindcss/vite`; no framer-motion dependency) + TanStack Query + TanStack Router + `@tabler/icons-react`. Routing is **code-based** TanStack Router (`src/router.tsx`, no Vite plugin): a pathless `id: "app"` layout route under the root carries `AppLayout` (login/setup sit outside it), `declare module Register` enables typed `to`/`search` everywhere, and `/audit` redirects via `beforeLoad` + `redirect()`. Route loaders are **fire-and-forget prefetches** (`void queryClient.query(...)` — never awaited, so navigation commits immediately and pages keep their `useQuery` + skeleton loading; `defaultPreload: "intent"` starts the fetch on sidebar hover). Shared `queryOptions` live in `src/queries.ts` (loaders and components must reference the same objects); the global `QueryClient` singleton (`src/queryClient.ts`, `staleTime: 30s`) is injected via router context AND `QueryClientProvider`. Deep-link flags `?create=1` / `?status=` are read through `validateSearch` + `useSearch({ strict: false })`. The 401 fallback is registered inside `AppLayout` (hook context; avoids an api↔router import cycle). Do NOT reintroduce react-router — it was removed wholesale (its v7/v8 default of wrapping router state updates in `startTransition` defers nav-driven UI like the sidebar highlight until data settles; TanStack Router's location updates optimistically). Components are compound (`Modal.Backdrop/Container/Dialog`, `Table.ScrollContainer/Content/Header/Body`, `TextField > Label/Input/FieldError`) and use `onPress`/`isPending` instead of onClick/loading. Shared wrappers in `src/ui.tsx` keep pages terse: `TextForm`/`NumberForm`/`SelectForm` (label + error/hint in one line; Select supports `multiple`), `FormModal`/`SideDrawer` shells, `RowButton`/`SubmitButton`, `FilterSelect`/`ToolbarButton` (list toolbars: search → filter Select → 重置 → 刷新 left-aligned, the page's create button docked right in the same `ListToolbar` row), `PageHeader`/`PageShell` (list-page scaffolding; tables are NOT wrapped in Cards so they keep the default primary Table look), `emptyState` (HeroUI EmptyState), `useFormValues` (object-shaped controlled state; dialogs mount their form keyed by entity id so values re-initialize on open). Prefer HeroUI defaults over custom classes — custom classNames are layout-only (flex/grid/spacing) plus `text-muted` hierarchy hints. Left sidebar is a fixed Tailwind layout (mobile: top bar + Drawer nav). Dark mode toggles `<html class="dark" data-theme>` via `src/theme.ts` (`useTheme`, persisted as `tyz-theme`) with a pre-paint inline script in `index.html`; HeroUI semantic tokens (`bg-background`, `text-muted`, `border-border`, `accent-soft`…) drive all styling. Global radius is set to the small preset by overriding `--radius: 0.25rem` in `index.css` (every component radius AND Tailwind `rounded-*` derive from this one variable); form controls have their own `--field-radius` (default `--radius`×1.5) which is pinned to the same value there — change them in `index.css`, not per-component. The full theme is a monochrome (black/white accent, colored semantic states) HeroUI theme-builder export overridden in `index.css` (`:root` light + `.dark` blocks). Destructive confirmations use the shared `confirmDanger` helper (`src/confirm.tsx`, module-level bridge to a mounted `AlertDialog`); toasts use the imperative `toast()`/`toast.success()`/`toast.danger()` API with one `<Toast.Provider placement="top">` in `main.tsx`. Noto Sans SC simplified-Chinese font subsets are bundled explicitly (headless/Linux environments otherwise show missing CJK glyphs). Built output is served by the Worker via the `ASSETS` binding with SPA fallback implemented in `app.notFound`. Layout: full-width sticky top navbar (page title; theme toggle, account chip → profile, logout on the right) + fixed left sidebar (mobile: burger + Drawer). Pages: dashboard (`/` — user/rule/node/tunnel stat cards linking to their pages), nodes (per-service health + live current connection counts in a Drawer), tunnels (chain management Drawer), rules (owner + quota-stop chip + manual restart; target picked from stored endpoints or entered manually), endpoints (named forwarding targets with reference count; address edits auto-sync referencing rules), users (subscriptions, per-rule usage, stop reasons), packages (traffic/window/access/rule-count via multi-Select), settings with expandable sidebar submenu (basic/notification/announcement/site are planned-feature placeholders — no backend yet; audit lives at `/settings/audit`, old `/audit` redirects), profile (`/profile`, account info from `GET /api/admin/me` + own-password change via `PUT /api/admin/me/password`).
- **Shared** (`packages/shared`): entity types, zod schemas, API DTOs used by server and web (including the `RealmNodeConfig` agent payload).

**Stack**: Bun (workspaces) · Hono (server) · Cloudflare Workers + D1 + Drizzle ORM · Rust (agent: realm_io + kaminari + realm_lb, nightly pinned) · React 19 + HeroUI v3 + Tailwind CSS v4 · Biome

## Common Commands

```bash
bun install                     # install all workspaces
bun run lint                    # biome check (root)
bun run type-check              # tsc --noEmit in every workspace
bun run build:web               # build apps/web -> apps/web/dist

bun run dev:server              # wrangler dev (8787, root wrangler.jsonc) — apply migrations first
bun run dev:web                 # vite dev (5173, proxies /api to 8787)
bun run dev:agent               # cargo run the agent; needs CONTROL_PLANE_URL + NODE_TOKEN
bun run test:agent              # cargo test in apps/agent
bun run clippy:agent            # cargo clippy --all-targets

# Server (from the repo root — wrangler.jsonc lives there)
bunx wrangler d1 migrations apply DB --local      # apply migrations to local D1
bun run db:seed:local                             # local seed data
bun run apps/server/scripts/test-ws-push.ts [baseUrl]   # e2e push test vs wrangler dev (dev-token-1; bootstraps admin/admin123 via /setup when uninitialized)
```

## Architecture / Data Flow

```
admin web ──► /admin CRUD ──► D1 (relay_nodes/tunnels/chains/relay_rules)
                                   │ on every write: buildRealmNodeConfig for affected nodes
                                   ▼
                            node_configs (node_id, version, config_json = RealmNodeConfig)
                                   │ + notifyConfigChanged() → per-node NodePushDO broadcasts
                                   ▼
agent keeps WS GET /api/agent/ws (Bearer NODE_TOKEN) ── {"type":"config_changed"} push
  └─► immediate GET /api/agent/config?version=N  (config content still travels over HTTP)
        ├─ 304 when version unchanged
        └─ 200 { version, config: RealmNodeConfig }
              └─► translate (validate) ──► Supervisor::apply (service diff, in-process)

WS channel policy (apps/agent/src/cp/ws.rs): mirrors the legacy Go agent —
  - healthy WS ⇒ HTTP poll is a 5-min safety net only
  - every successful (re)connect fires `Connected` → an immediate poll (a
    config_changed broadcast during a disconnect window is lost; the gap is
    closed on reconnect)
  - ≥3 WS failures within 60s → fallback to HTTP polling (POLL_INTERVAL_MS + backoff)
  - while fallen back: fixed-interval probe promotes back to ws mode; a
    successful handshake ALSO clears the failure window and promotes
  - keepalive: text "ping" every WS_PING_INTERVAL_MS (clamped < 90s — the
    edge closes idle WebSockets > ~100s); the DO auto-responds "pong" at the
    edge without waking the object
  - manual rule restart: the panel's POST /rules/:id/restart broadcasts
    {"type":"restart_service","service":"service-{id}"}; the Supervisor
    rebuilds that ONE service from the last desired config (dropping its
    live connections); unknown names no-op
  - shutdown: signal → final stats flush → stop services

Supervisor data plane ──► per-service accept loops + splice/userland bidi copy
  ──► cumulative counters (service-level + per-client) ──► POST /api/agent/stats (batched, idle-skip)
  ──► service health snapshot rides the first chunk of each flush ──► D1 service_health
stats ingest (traffic.ts) ──► deltas vs traffic_counters ──► D1 traffic_hourly (per rule-hour ledger, billing SoT)
billing authorization: the sample's service string is attacker-controlled, so a
  service-{ruleId} sample only enters the rule ledger when the REPORTING node
  actually deploys that rule's service (nodeRuleTunnels: every IN and OUT chain
  of the rule's tunnel — both legs of every two-node tunnel deploy per-rule
  services under raw port-pair semantics). Multi-leg usage is the SUM over
  every serving node by design; operators trim legs via per-node rate (0 = record-only).
D1 chunking: every batched write/IN-list is chunked to stay under D1's 100 bound
  parameters per statement (stats insert 20 rows, health upsert 16, IN lists 90; the traffic
  ingest writes are MULTI-ROW upserts — traffic_hourly 12 rows @8 params, traffic_counters
  16 @5, service_metrics_hourly 16 @6, per-rule observation increments as one CASE-based
  UPDATE per 16-rule chunk)
rule status auto-sync: the stats ingest also derives relay_rules.status from the health snapshot —
  running/ready → running, failed/apply_failed → error; `paused` (manual) is never
  overwritten; absent services keep their status
```

### Key server modules (`apps/server/src`)

- `index.ts` — Hono app, mounts `/agent` and `/admin`, SPA fallback via `env.ASSETS`, daily cron pruning `gost_stats` (>30 days) and `audit_log` (>180 days; the hourly traffic ledger is NEVER pruned — permanent packages need unbounded windows) + recomputing every node config (quota sweep: expired subscriptions / drained allowances hard-stop their rules; unchanged configs skip the version bump). Exports `AppType` and the `NodePushDO` class.
- `services/quota.ts` — package/subscription enforcement: the server is the billing ledger (per-user usage = SUM of billed bytes from the `traffic_hourly` ledger within the subscription window; window start floored to its hour), the agent has NO in-path quota gate — enforcement is config removal at recompute time. Usage is ONE aggregate roundtrip per user; multi-user batches resolve decisions in parallel; the user-detail per-rule breakdown is a chunked GROUP BY (`ruleUsageByRule`). Hard-stop (rule dropped from the rendered payload) on disabled user / no subscription / expired / exhausted. `quotaSweepStoppedUsers` (flush-driven R4 mitigation) resolves hard-stop decisions for the users whose rules just billed traffic and returns those whose rules are STILL deployed in some node config — the stats route recomputes their nodes, shrinking the over-delivery window from one cron period to one flush interval; idempotent via the deployment scan, daily cron remains the backstop. Switching/renewing a subscription replaces its row with a fresh `activated_at` — the window change restarts usage accounting (换购清零).
- `routes/agent.ts` — node-facing endpoints; auth via `middleware/nodeAuth.ts` (Bearer token → direct plaintext lookup on `relay_nodes.token` (UNIQUE), 60s in-isolate cache). `GET /ws` forwards the authenticated upgrade request to the node's `NodePushDO`. `POST /stats` shares one `nodeRuleTunnels` lookup between the billing gate and the status write-back; schedules the quota sweep via `waitUntil`.
- `do/nodePush.ts` — `NodePushDO` (one Durable Object instance per node, `idFromName(String(nodeId))`): hibernation WebSocket API, auto-responds to `ping`→`pong` at the edge (`setWebSocketAutoResponse`, object stays hibernated), and on `POST /notify` broadcasts `{"type":"config_changed"}` / restart directives to all live sockets of that node. Bound as `CONFIG_PUSH` in wrangler.jsonc (SQLite class migration `v2_node_push_do`).
- `services/notify.ts` — `notifyConfigChanged(env, nodeIds)`: fire-and-forget fan-out to the DOs; never fails the admin write.
- `services/recompute.ts` — shared recompute helpers used by admin routes and the agent stats route: `recomputeAndNotify` (one node), `recomputeTunnelNodes` (parallel over the tunnel's chain nodes), `recomputeUserNodes` (every node serving a user's rules). `recomputeNodeConfig` (in `db/repo.ts`) is content-diffed: an unchanged config skips the version bump, so sweeps never force pointless refetches.
- `services/tls.ts` — platform link-TLS material: a self-signed ECDSA P-256 CA plus server/client leaves, generated in-process with a hand-rolled minimal DER encoder (Workers has no X.509 library). Stored as PEM in `tls_material` (kind = ca|server|client); `ensureTlsMaterial` lazy-generates on first TLS aggregation; `setTlsDomain`/`setTlsProfile` issue eagerly; `renewTlsMaterial` (daily cron) re-issues expiring material and recomputes the TLS-enabled nodes. The certificate profile (issuer DN strings + validity) is admin-configurable (`PUT /api/admin/settings/tls-profile`). The disguise domain (`app_settings.tls_domain`) is set from the settings page; `GET /api/admin/tls/status` shows expiry metadata + effective profile. **PEM material and `relay_auth_*` are secrets of the node-token trust domain: delivered only through the agent config payload, never in admin responses or audit rows.** Cert correctness is covered by `apps/server/test/tls.test.ts` (DER parse + WebCrypto signature self-checks).
- `routes/admin.ts` — login (HMAC-signed HttpOnly session cookie, `middleware/adminAuth.ts`), full CRUD for nodes/tunnels/chains/rules/users/packages/endpoints, subscribe (activate/switch/renew), token rotate + reveal (`GET /nodes/:id/token`), stats + health query, audit query, explicit synchronous recompute. Every write path records an audit row and recomputes affected nodes via `deferRecompute` (`c.executionCtx.waitUntil`) — the recompute + WS push runs AFTER the response is sent; deferred failures are logged (never surfaced) and the daily cron self-heals them. TLS shape validation: only the `tls` out transport can carry a TLS link (the realm agent speaks kaminari TLS only); a missing side is a construction intermediate that aggregates as plaintext until complete; only deleting a link from a COMPLETE TLS tunnel requires turning TLS off first.
- `db/schema.ts` — Drizzle schema mirroring `migrations/`; property names keep snake_case to match the shared entity types. **`nodeEntityColumns` is the allowlist for node fields in API responses — never select `token`/`tls_config` there (the token is revealed only via `GET /nodes/:id/token`).** Schema changes: edit `schema.ts` → `bunx drizzle-kit generate` (see `drizzle.config.ts`) → copy SQL into `migrations/` → apply with wrangler.
- `db/repo.ts` — Drizzle data access + `buildRealmNodeConfig`: the ONLY config renderer since the realm cutover (see "Realm config renderer" below), plus the versioned snapshot upsert.

### Agent modules (`apps/agent`, Rust)

- `main.rs` — env config, tracing (`DEBUG=true` → debug logs; `GOST_API_ADDR` is obsolete and warned about), rustls/ring provider install, control loop until SIGTERM/SIGINT (final stats flush + service shutdown). `--version` prints the build-stamped version (`TYZ_VERSION` compile-time env, `dev` when unset; stamped by the release workflow / Docker build-arg).
- `agentcfg.rs` — env/dotenv loading; variable names mirror the legacy Go agent one-for-one.
- `model.rs` — wire types mirroring `@tyz/shared` (`RealmNodeConfig`; stats samples with camelCase serde rename; WS push messages).
- `translate.rs` — `RealmNodeConfig` → desired service set. All validation happens here (flavor guard `agent == "realm"`, address parsing, LB shape, TLS-without-material); a rejected config keeps the previous one serving and the version is not adopted.
- `runtime/mod.rs` (`Supervisor`) — registry-diff apply over managed services: `last` records the desired world INCLUDING failures; changed services rebuild (same-port: stop old FIRST — double-bind is EADDRINUSE; different ports: new bind proven BEFORE old stops — zero downtime); a **dead accept loop self-heals on the next apply even with an unchanged config** (gostapply's dead-service rule); pure heals keep live connections, TLS rebuilds drop them; `restart(name)` rebuilds one service from `last` (no re-fetch); `health_snapshot` covers the full desired world (running/failed/apply_failed — the server deletes rows for services absent from it).
- `runtime/service.rs` — one managed service = one listener + accept loop + connection registry. Bind/constructor failures return errors (→ `apply_failed` health), never panics. Connections are independent tasks; `stop(drop_conns)` optionally aborts them (manual restart / TLS rotation only).
- `runtime/net.rs` — per-connection forwarding: realm_lb target pick, dial with connect timeout (default 5s), counting bidi copy — splice path for plain/plain legs, `StatStream` userland copy whenever a TLS leg is involved (realm itself goes userland under transport).
- `runtime/zero.rs` — the ~150-line counted splice state machine (realm_io v0.5.4 semantics: same pipe sizing 16×4K, `SPLICE_F_MOVE|SPLICE_F_NONBLOCK`, brutal-shutdown completion policy — one direction done closes the other at its current byte count). Bytes are counted at the write-splice, so billing never leaves the zero-copy path. Non-Linux dev runs fall back to userland copy. Unit tests compare totals against realm_io's own `bidi_zero_copy`.
- `runtime/tlsconf.rs` — kaminari TLS assembly: exits serve the platform server cert; entries dial with SNI = platform domain + payload ALPN. kaminari's client has no custom-CA option, so the entry leg runs `insecure` (encryption without server verification — an accepted tradeoff, design doc §11; the gost-era mTLS/relay-auth/admission layers are retired with GOST).
- `certs.rs` — persists the platform PEM material to `certs/` (atomic tmp+fsync+rename, 0700/0600, content-unchanged skips); the changed flag gates the TLS force-rebuild (rustls embeds certs at acceptor-build time).
- `cp/http.rs` — versioned config fetch (304 handling, 8MB response cap, 30s timeout) and batched stats upload.
- `cp/ws.rs` — WS push channel state machine (see diagram above).
- `stats.rs` — cumulative per-(service × client) atomic counters + the flush buffer (merge-by-key keeping the intra-window `current_conns` peak, cap 1000 with drop-oldest, ≤20-sample chunks; service-level rows sort first so the billing rows survive the cap).
- `store.rs` — offline bootstrap cache `last-config.json` (atomic write, 0600; non-realm payloads skipped with a warning).
- `control.rs` — the control loop (poll cadence by channel mode, backoff ×2 max 5min ±20% jitter, restart directives, version adopted only on fully successful apply) and the flush loop (random startup phase; buffer-merge; ≤20-sample chunked upload with remainder-keep retry).

## Critical Implementation Details

### Realm config renderer (`buildRealmNodeConfig`)

- Every tunnel renders with **raw port-pair semantics** (`forward_mode` is retired; legacy relay rows render identically; new tunnels always store `raw`).
- Entry node (the one `in` link): one `service-{ruleId}` per rule, `listen_port → exit:exit_port`, `tls_side=connect` on TLS links.
- Exit nodes (`out` links): one `service-{ruleId}` per rule on the rule's `exit_port` (or the deterministic allocation `start + ((ruleId*31 + nodeId) % range)` from THAT node's port range, computed server-side and delivered explicitly — collisions surface as `apply_failed` health) `→ rule target`, `tls_side=listen` on TLS links.
- Single-node tunnels (in link only) render a direct forward to the rule target.
- Several out links = the exit candidate set: primary + `extra_targets` with a `balance` strategy from the in link's `strategy` column (`round`→`roundrobin`, `iphash`→`iphash`, via realm_lb). TLS tunnels stay single-exit.
- Tunnels with middle-hop (`chain` type) links are SKIPPED — no hop chaining in the realm data plane; a node holding both ends of a tunnel is skipped too.
- Quota hard-stopped rules drop out via `applyRuleQuotas` (shared gate); `rule.limit` / quota never enter the payload (per-rule rate limits are currently INERT — do not promise them until agent-side enforcement returns).
- TLS link: only the `tls` out transport (`TLS_LINK_TRANSPORTS = {tls}`); legacy grpc/wss/mtls rows degrade to plaintext. Missing `tls_material` degrades BOTH legs to plaintext. The exit serves the platform server cert; the entry dials with SNI = disguise domain, `insecure` (no server verification — accepted).
- Config payload: `{ agent: "realm", node: {id, name}, services: [...], tls_material? }` — PEMs ride inside `tls_material` (0600 cache on the agent). The flavor guard on both server (renderer emits `agent: "realm"`) and agent (non-realm payloads refused) keeps a stale gost-era snapshot from ever being applied.

### Apply semantics and connection disposition (Supervisor)

| change | effect | live connections |
|---|---|---|
| config identical, service healthy | untouched | kept |
| service config changed / port changed | rebuild (same-port stops old first; other ports swap zero-downtime) | dropped only if TLS service |
| TLS material rotated | TLS services force-rebuild (rustls embeds certs at build time) | dropped for those services |
| accept loop died (fatal accept error) | rebuilt on next apply even with unchanged config (self-heal) | kept |
| service removed from config | listener stopped | kept (run to natural close) |
| `restart_service` directive | that ONE service rebuilt from `last` desired config | dropped |

Partial apply: a service whose spawn/bind fails is reported as `apply_failed` health, everything else applies, the version is NOT adopted (next poll retries; `last` keeps the desired world so retries rebuild only the failures). Quota removal semantics are config-removal based: an exhausted allowance removes the rule at the NEXT recompute (no in-agent accept gate — see below).

### Config versioning

`node_configs.version` is epoch-seconds-based and bumped monotonically on every recompute (`max(existing, epoch)` + 1 on conflict), so agents can never get stuck on a stale 304 after a snapshot row is recreated. `recomputeNodeConfig` skips the bump entirely when the rendered JSON is unchanged (sweeps stay cheap; agents poll the safety net without a refetch).

### Quota enforcement (no in-agent gate)

The realm payload carries no quota object (the gost quota limiter died with GOST). Hard-stop = rule removed from the rendered config, triggered by: admin writes (immediate), the flush-driven sweep (`quotaSweepStoppedUsers` — minute-level), and the daily cron (backstop). Accepted residual risk: traffic between two flushes can over-deliver by up to one flush interval; the documented phase-2 fallback is accept-time local rejection on the agent.

### Stats and billing

- Counters are CUMULATIVE per (service, client) within a process lifetime; the server folds telescoping deltas against `traffic_counters` (counter resets re-anchor). Lost uploads therefore never double-count; a restart re-anchors server-side.
- `traffic_hourly` (per rule-hour, PK `(rule_id, hour_ts)`) is the billing ledger: ledger-first UPSERT accumulation (`real_*` actual bytes, `billed_*` = round(real × node `rate`) — the line billing multiplier, 0..100 default 1.0, 0 = record-only; quota remaining computed from BILLED). Deliberately NO foreign keys: deleting a rule/user must not erase usage. Writes go ledger-first so a crash over-counts instead of under-counting.
- `service_metrics_hourly` rolls up per-service connection samples hourly (sum+samples for exact averages, max for peaks; 7-day retention, no FK).
- `service_health` is the panel's liveness signal (`reported_at` refreshed by every flush); rows absent from a node's snapshot are deleted (diffed, NOT `NOT IN` — chunking trap).
- The billing gate (`nodeRuleTunnels`) authorizes per-rule samples by the reporting node's chains — IN and OUT links both deploy per-rule services under raw semantics, so both legs bill by design; operators trim legs via per-node `rate`.

### Database schema quirks

- SQLite (D1): enums are TEXT + CHECK constraints; `limit`/`custom_cfg`/`tls_config`/`stats` stored as JSON TEXT.
- `tunnels.forward_mode` is a LEGACY column: new tunnels always store `raw`; the admin API no longer accepts `relay`. `tunnels.relay_auth_user/pass` are dormant (no link auth in the realm data plane) but stay populated for schema stability and are stripped from admin responses.
- `tunnels.tls_enabled` requires the 1-in/1-out shape with the `tls` out transport; a missing side is a construction intermediate that aggregates as plaintext until complete; only deleting a link from a COMPLETE TLS tunnel requires turning TLS off first.
- Node tokens are stored PLAINTEXT (`relay_nodes.token`, 128-bit random hex); the panel shows them masked (`token_hint`) with on-demand reveal; rotation is the leak response. The root `wrangler.jsonc` D1 binding intentionally omits `database_id` (wrangler automatic resource provisioning keeps the public repo free of account-specific ids).
- `relay_rules.tunnel_id` is REQUIRED on create (aggregation selects rules BY tunnel; NULL is a legacy state = "not deployed anywhere"; single-node direct forwarding is a one-in-chain tunnel). `relay_rules.user_id` NULL = admin-managed (never quota-gated). `relay_rules.exit_port` = dedicated exit port (0 = deterministic auto-allocation, computed server-side). `relay_rules.endpoint_id` references stored `endpoints` rows: `targets` keeps its own composed address copy (`endpointAddress()` in `@tyz/shared`, IPv6 bracketed) so the config pipeline never joins endpoints; address edits auto-sync referencing rules; deleting a referenced endpoint is a 409.
- `users.role` ∈ {admin, user} + `users.password_hash` (format `sha256$salt$hash`, never in API responses or audit rows). Admin rows are invisible to the users API (list filters, mutations 409).
- Packages: `traffic_bytes`/`period_days`/`max_rules` 0 = unlimited; `node_ids`/`tunnel_ids` NULL = unrestricted; one active `user_packages` row per user (UNIQUE); subscribe/switch replaces it with a fresh `activated_at` (usage window restarts); `package_name`/`traffic_bytes` on the subscription are buy-time snapshots.
- `app_settings` (key/value; `tls_domain`, `session_secret`, the four certificate-profile keys — public metadata, safe to audit) and `tls_material` (kind PK + PEM + not_after). `audit_log` records admin writes (`actor` snapshot; `detail` never holds secrets — rotate-token logs the rotation, never the token).

## Auth

- **Agent**: `Authorization: Bearer <NODE_TOKEN>`; token created/rotated in the admin panel.
- **Admin**: DB-account only — a `users` row with `role='admin'`, created through the first-run `/setup` wizard (`routes/setup.ts`: `GET /api/setup/status`, one-shot `POST /api/setup` that also generates the session secret and logs in). Passwords are salted single-step SHA-256 (`sha256$salt$hash` — never leaves the DB layer). Login ignores the business `status` column. Session = HttpOnly cookie `tyz_admin` = `expiry.username.hmac(key, expiry.username)`, 7 days; the key is `SESSION_SECRET` or, when unset, the random `session_secret` row in `app_settings` (per-isolate 60s cache).

## Environment Variables

Agent (`apps/agent/.env.example`, loaded from the working directory; real env vars take precedence): `CONTROL_PLANE_URL`, `NODE_TOKEN` (required); `POLL_INTERVAL_MS` (10000), `STATS_FLUSH_INTERVAL_MS` (60000), `WS_ENABLED` (true; false = pure HTTP polling), `WS_PROBE_INTERVAL_MS` (60000), `WS_PING_INTERVAL_MS` (60000, clamped < 90s), `DEBUG` (verbose logs). 
Server: no required secrets (admin login is DB-backed via `/setup`; local dev is zero-config — seed tokens are plaintext). Production-optional: `SESSION_SECRET` (session-cookie HMAC key) via `wrangler secret put`.

## HTTP Endpoints

Server: `GET /api/healthz`; agent-facing `GET /api/agent/config?version=N` (304/200, body = `RealmNodeConfig`), `GET /api/agent/ws` (WebSocket upgrade; pushes `{"type":"config_changed"}` / `{"type":"restart_service","service":...}`, auto-answers `ping`→`pong`), `POST /api/agent/stats` (samples + service health snapshot); admin `POST /api/admin/login|logout`, `GET /api/admin/me`, `PUT /api/admin/me/password`, CRUD `/api/admin/nodes|tunnels|chains|rules|users|packages|endpoints` (+`/api/admin/nodes/:id/{recompute,rotate-token,stats,health,metrics,token}`, `/api/admin/users/:id/subscribe` for activate/switch/renew, `GET /api/admin/users/:id` returns the rules' quota status incl. stop reasons, `GET /api/admin/audit`, `POST /api/admin/rules/:id/restart`, `GET /api/admin/tls/status` + `PUT /api/admin/settings/tls-domain` + `PUT /api/admin/settings/tls-profile`).

Agent: no HTTP surface of its own (a node is considered healthy as long as it keeps reporting; config apply and stats are in-process).

## Code Style

Biome (root `biome.json`) covers the TS workspaces: double quotes, 120 cols, organize imports; `noExplicitAny`/`noNonNullAssertion`/a11y anchor rules are downgraded to warnings. Rust (`apps/agent`): standard `rustfmt`, `tracing` structured logging, no config frameworks; toolchain pinned by `rust-toolchain.toml` (nightly — bump deliberately, with `cargo test`). Run `bun run lint`, `bun run type-check`, and `bun run clippy:agent` + `bun run test:agent` before committing.

## Testing

`bun run test:agent` (`cargo test` in apps/agent):
- zero-copy: counted splice vs realm_io's own `bidi_zero_copy` totals on real socket pairs; brutal-shutdown release of half-dead peers.
- supervisor: service lifecycle (create / idempotent re-apply), dead-listener self-heal keeping live connections, unchanged-config no-op guard.
- WS state machine: push delivery + mode recovery against a local WS server; dead-server demotion → probe promotion.
- e2e: `tests/e2e.rs` (two agents against a mock control plane: config sync, forwarding, stats) and `tests/tls_e2e.rs` (TLS link entry→exit; plaintext probes refused).
- unit: translate validation, store round-trip, certs write-once/skip-unchanged, stats buffer merge/chunk/cap.

Server-side (bun test under `apps/server/test/`): `crypto.test.ts` (salted-sha256 round-trip), `tls.test.ts` (DER encoder + WebCrypto signature self-checks), `traffic.test.ts` (ledger ingest vs the real D1 migration: delta chaining, counter resets, chunk-boundary splits, forged-service gate), `realm-config.test.ts` (realm renderer: raw port pairs, exit-port allocation, LB candidate sets, TLS legs, legacy relay degradation, multi-hop skips, quota gating, recompute content-diff, billing gate, quota sweep).

Live e2e (needs `wrangler dev` + seed): `bun run apps/server/scripts/test-ws-push.ts` — bad token rejected, hello, ping/pong, admin write broadcasts `config_changed`. For a full local stack: `wrangler dev` + seed + `bun run dev:agent`; send traffic through a rule's listen port and watch stats flow.
