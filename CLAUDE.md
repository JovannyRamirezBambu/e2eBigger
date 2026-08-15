# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

End-to-end test harness for BIGER ↔ satellite integrations (Estrella Roja). It stands up the
minimal stack for one business flow, seeds deterministic data, and exercises it with the real
code of every repo involved — before deploying to `dev`. This repo (`ER/e2e`) expects sibling
application repos as directories next to it under `ER/`: `BCB_EstrellaRoja_Backend`,
`BIGER_EstrellaRoja_Main`, `BIGER_EstrellaRoja_TomTom`, `BIGER_EstrellaRoja_VentaABordo`. It also
needs Docker, Node.js, pnpm, Maven, OpenSSL, and PostgreSQL client tooling on PATH.

## Commands

```bash
pnpm install              # once
pnpm typecheck             # tsc --noEmit — strict, run this after any src/ change

./e2e list                 # flows available
./e2e run tomtom            # full cycle: up → seed → test → verify (what you want 90% of the time)
./e2e test tomtom t11-carrera-manual   # rerun one case while debugging
./e2e up <flow> [--reset]   # bring up infra + services only (idempotent)
./e2e seed <flow>           # recreate test data (idempotent, safe to rerun)
./e2e verify <flow>         # human-readable DB state dump (runs flows/<flow>/verify.sql)
./e2e status <flow>         # what's up / down
./e2e psql <flow>           # psql into the flow's main DB
./e2e logs <flow> [service] # tail -f; no service arg lists what's available
./e2e down <flow>           # stop this flow's services (shared infra stays up)
./e2e down <flow> --all     # also stop shared infra (NATS, BIGER Postgres) — other flows use it
./e2e ui <flow>             # diagnostic dashboard at http://localhost:7777 (builds ui/dist if stale)

cd ui && pnpm install && pnpm dev   # dashboard frontend with hot-reload (separate project, own deps)
```

`cases`, `probe`, `db-json`, `dlq <stream>`, `traffic <flow>`, `results` emit JSON (the dashboard
consumes these; also useful for scripting).

There is no linter/formatter configured for `src/`/`lib/` — match surrounding code and always run
`pnpm typecheck` before considering TS work done. The `ui/` frontend is its own TypeScript project
with its own `pnpm --dir ui typecheck` (also strict); it is excluded from the root `tsconfig.json`.

## Architecture

Two languages, each doing what it's good at — this split is intentional, don't blur it:

| Layer | Language | Responsibility |
|---|---|---|
| `e2e`, `lib/`, `flows/<flow>/flow.sh` | bash | Infra lifecycle: docker, maven, ports, process management, RSA keys |
| `src/` | TypeScript | The actual tests: cases, seeding, assertions, DB/NATS inspection |
| `ui/` | React + Vite + Tailwind (`ui/src`), served by dependency-free Node (`ui/server.cjs`) | Read-only dashboard; the backend shells out to `./e2e` and reformats its output, the frontend is a separate build |

`./e2e <cmd> <flow>` (bash) dispatches infra commands (`up`/`down`/`status`/`psql`) to
`flows/<flow>/flow.sh`, and delegates test-layer commands (`seed`/`test`/`verify`/`cases`/`probe`/
`db-json`/`dlq`/`traffic`) to `pnpm exec tsx src/cli.ts <flow> <cmd>`. Adding a flow never requires
touching `./e2e` itself — see "Adding a flow" below.

### The dashboard (`ui/`)

Two independent pieces:

- **Backend** — `ui/server.cjs`. Still dependency-free Node (`.cjs` extension is deliberate: it's
  CommonJS regardless of `ui/package.json`'s `"type": "module"`, which the React frontend needs).
  Exposes `/api/state`, `/api/logs`, `/api/run` (SSE), `/api/seed` (SSE) — all of it by shelling out
  to `./e2e` and reformatting stdout/JSON. Never reimplements test logic; if the dashboard and the
  CLI ever disagree, that's a server bug, not two sources of truth. Also serves `ui/dist` as static
  files for anything not under `/api/`.
- **Frontend** — `ui/src/`. React + TypeScript + Tailwind + shadcn/ui-style components (hand-authored
  Radix wrappers in `ui/src/components/ui/`, not the `shadcn` CLI) built with Vite. Has its own
  `package.json`/lockfile/tsconfig — a separate project from the harness's TS, excluded from the root
  `tsconfig.json`. `lib/api.ts` mirrors the backend's exact response shapes; `lib/format.ts` has the
  JWT/Basic-auth decoding, `curl` reproduction, and JSON pretty-printing used by the HTTP trace modal.

`./e2e ui <flow>` builds `ui/dist` first if `ui/src` (or its configs) changed since the last build —
same staleness-check pattern as the Java jars (`ui_dist_is_stale`/`ensure_ui_build` in
`lib/common.sh`) — then launches `server.cjs`. For live-reload while editing the panel itself, run
`cd ui && pnpm dev` (Vite on :5173, proxying `/api` to the `:7777` backend) alongside `./e2e ui`.

### Why TypeScript for the test layer

- **Payloads typed against the satellites' real DTOs** (`import type` cross-repo, via `tsconfig.json`
  path aliases like `@bcb/dto/*` pointing into `../BCB_EstrellaRoja_Backend/apps/bcb/src/*`). If a
  contract field is renamed or removed, the harness **fails to compile** instead of surfacing as a
  400 in production that really means a lost event.
- **Typed Prisma** (`@bcb/prisma` aliased to the sibling repo's generated client) instead of raw
  SQL strings — autocomplete, and renamed columns break compilation.
- **A real NATS client** (`src/harness/nats.ts`) reads DLQ message *content* and headers
  (`x-dlq-reason`, `x-origin-subject`, `x-error-detail`), not just a counter.
- **The satellite's real signing code is imported directly** (e.g. `AdapterTomtomCallbackClient`),
  so the JWT the harness exercises is the satellite's actual implementation, not a reimplementation.

`tsconfig.json` sets `strictPropertyInitialization: false` deliberately — BCB's DTOs declare
`field: string;` with no initializer (Nest hydrates them), and since this project typechecks BCB's
own files via the path aliases, it must match that repo's compiler setting.

### The `Flow` contract

Every flow implements `Flow` from `src/harness/types.ts` and is registered by name in the `FLOWS`
map in `src/cli.ts`:

```ts
export const flow: Flow = {
  name, description,
  cases,        // CaseDef[]: { name, label, run(t: Report) }
  seed,         // idempotent — reruns N times safely
  probe,        // ChainNode[] for the dashboard: per-service up/down + last error + metrics
  dbSnapshot,   // rows for `verify` and the dashboard
  beforeCases,  // optional — for things that shouldn't persist between runs (e.g. fake SmartMac)
  close,        // optional — always called on exit, e.g. to disconnect Prisma
};
```

`src/harness/` provides the shared building blocks any flow uses: `report.ts` (assertions +
`PASS`/`FAIL` output — the format is byte-for-byte what the old bash harness printed, because both
the dashboard and human muscle memory parse it), `http.ts` (`SatelliteClient`, RS256 JWT signing
via `signJwt`/`jwkThumbprint`, `isUp`/`portOpen`), `db.ts` (typed BCB Prisma client + Venta a Bordo
satellite client), `nats.ts` (JetStream stream state + DLQ inspection), `wait.ts` (`until`/
`untilEquals` polling helpers, timestamp formatting), `paths.ts` (repo/key/log path resolution).

Each `src/flows/<flow>/` directory has `index.ts` (wires up the `Flow`), `seed.ts` (deterministic,
idempotent scenario data), `scenarios.ts`, and `cases.ts`. Some flows add extras (e.g.
`src/flows/tomtom/satellite.ts` calls the TomTom satellite's real callback client).

### Adding a flow

Two pieces; the entrypoint is never touched:

1. `flows/<name>/flow.sh` — infra only: implement `flow_up`, `flow_down`, `flow_status`,
   `flow_psql`. Reuse helpers from `lib/common.sh` (see below) rather than reinventing them.
2. `src/flows/<name>/index.ts` exporting a `Flow`, registered as one line in the `FLOWS` map in
   `src/cli.ts`.

**Pick a business-key prefix that isn't a substring of another flow's prefix.** All flows share the
same BCB database and each seed cleans up by matching its own prefix; a contained prefix
(`E2E-TCO-` inside `E2E-`) means one flow's cleanup sweep deletes another flow's rows, breaks its
FKs, and turns its suite red for a reason that has nothing to do with it.

### Ports & shared infrastructure

`adapter-bcb` and the real `apps/bcb` satellite app are shared across all three flows — they're
started from `lib/common.sh` (`start_adapter_bcb`, `start_bcb_app`), not from an individual flow,
because they're single processes and the second flow to start one must not restart it out from
under the first. `./e2e down <flow>` (without `--all`) stops only that flow's own services and
leaves shared infra running.

## Non-obvious pitfalls the harness already works around

These are documented in code/README because each one cost real debugging time; know them before
you assume something is broken:

- **Stale jars.** An `adapter-*.jar` built before a new NATS consumer existed starts with **no
  error** and silently never registers that consumer. `up` compares source vs. jar mtimes
  (`jar_is_stale` in `lib/common.sh`) and rebuilds only when needed.
- **Rebuilt-but-not-restarted jars.** The JVM read the jar at boot; rebuilding doesn't change the
  running process. `stop_rebuilt` stops any service whose jar was just rebuilt so the next `up`
  starts it fresh. This matters most for `adapter-bcb`, since three flows can rebuild it.
- **JetStream streams don't auto-create.** Without `make nats-init`, publish returns `503 No
  Responders` and the durable consumer never binds.
- **PKCS#1 vs PKCS#8.** `openssl genrsa` emits PKCS#1, which Node's `jsonwebtoken`/`crypto` accepts
  but Java's `PemRsaKeyParser` rejects (`InvalidKeySpecException`). `ensure_keypair` in
  `lib/common.sh` generates both formats per "leg" and each side gets the one it needs.
  `readKey(leg, kind)` in `src/harness/paths.ts` is the TS-side equivalent.
- **Orphaned processes.** `pnpm exec …` is a wrapper; killing its PID leaves the child `node`
  holding the port, so a fresh service dies with `EADDRINUSE` and tests keep hitting the old
  process — a false green that's hard to spot. `up`/`down` kill by port (`kill_port`), not PID.
- **Global Nest pipes.** `apps/bcb` wires validation pipes in `main.ts`/`serverless.ts`, not in
  `AppModule`. A test bootstrap that only calls `app.init()` validates nothing and produces false
  passes. `lib/bcb-bootstrap.ts` (grafted into the BCB repo at start time) replicates the real
  bootstrap.
- **Stale Prisma client.** Any `prisma generate` run from a branch missing new columns (including
  the repo's pre-push hook) leaves a client that doesn't match current code, failing with unrelated
  type errors. `up` always regenerates it (sub-second cost).
- **JetStream dedup on repeated chain cases.** `adapter-tomtom` derives `Nats-Msg-Id` from the trip
  id (`despacho:<tripId>`) with no timestamp component and a 2-minute dedup window. Chain-of-custody
  cases therefore create a fresh trip per run (`createChainTrip` in `src/flows/tomtom/seed.ts`),
  reusing the scenario's bus/operator and deleting the previous ephemeral trip — so the suite can be
  rerun back-to-back without waiting out the dedup window.
- **Split PEM lines in `.env`.** A `sed` replacement containing `\n` becomes real newlines, and
  `docker compose` then fails to parse the `.env`. `up` scripts discard orphaned lines like that.
- **Grafted scripts.** `up` copies ephemeral scripts into sibling repos (`scripts/e2e/` in BCB,
  `src/e2e-trigger.ts` in the TomTom satellite) because they need that repo's `tsconfig` path
  aliases to resolve. `graft`/`ungraft_all` in `lib/common.sh` track and remove them; `down` always
  cleans up.

## Flow specifics worth knowing before touching a case

- **`ventaabordo`** authenticates its two directions differently: WS1 (dispatch) is called by BCB
  with a `bcb-system` JWT; WS2/redemption/query are called by SmartMac with Basic Auth
  (`SMARTMAC_INBOUND_BASIC_*`). Whether the harness uses the new Basic Auth guard is currently
  detected at runtime by checking whether
  `src/shared/guards/smartmac-basic-auth.guard.ts` exists in `BIGER_EstrellaRoja_Main` (same
  pattern used for `ticketcolectoroffline`'s explicit `shiftId`) — hardcoding either path would
  turn the suite red on half the checkouts, or green against a guard that isn't actually running.
  SmartMac itself is a real third party with no sandbox; the harness substitutes its own fake
  (`src/harness/fake-smartmac.ts`) that mirrors the real response shape (`HTTP 200` with the
  verdict in `responseCode`) rather than inventing a different one that could pass here and fail
  against the real service.
- **`tomtom`** enters the chain via the satellite's own `AdapterTomtomCallbackClient` (the real
  JWT-signing code), not `POST /tomtom/geocercas` directly — that endpoint polls a sandbox-less
  third party (InRoute). CU04/CU05 start right after that detection point.
- **`ticketcolectoroffline`** is the only flow that does **not** run with `JWT_BYPASS`. Its
  controllers require `@BcbAuth({ADVISOR})` and the ticket agent's identity travels via
  `SecurityContext` → the NATS message's `_auth` field → re-signed by `adapter-bcb` as BCB's
  contract-token-2.0 `userId`/`role` claims — never in the payload itself. With the bypass on, that
  context is empty and BCB just 401s without saying where identity was lost. This flow therefore
  runs a local JWKS issuer (`lib/jwks-server.js`) and signs a real ADVISOR token. The `kid` is the
  RFC 7638 thumbprint of the key (`jwkThumbprint` in `src/harness/http.ts`), not a constant —
  Nimbus caches JWKS by `kid`, so a fixed value would keep validating against a stale key after
  `run/keys/` regenerates.

## Coding style

Two-space indent, single quotes, semicolons, strict TypeScript. Prefer `import type` for
cross-repo DTOs (see above for why). Bash files start with `#!/usr/bin/env bash`, quote variable
expansions, and reuse `lib/common.sh` helpers instead of duplicating them. Flow names are lowercase
(`ventaabordo`); case identifiers are stable and descriptive (`t11-carrera-manual`).

## Generated state & secrets

`run/` (logs, PIDs, generated RSA keys, results JSON) is gitignored and is local, disposable
state — never commit it, and treat keys under `run/keys/` as single-use local test material, never
real credentials. Inbound credentials the flows use are written by the harness itself, not read
from a repo's real `.env` (which may hold production-adjacent secrets, e.g. TECNITRANS). The
TomTom satellite's `.env` is rewritten by `up` with InRoute placeholders each run — back up real
InRoute credentials before running `up` if they're ever placed there.
