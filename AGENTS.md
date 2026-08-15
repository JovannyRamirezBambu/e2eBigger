# Repository Guidelines

## Project Structure & Module Organization

This is an end-to-end harness for BIGER satellite integrations. The `./e2e` executable coordinates its lifecycle. Infrastructure and process management live in `lib/` and `flows/<flow>/flow.sh`; typed test logic lives in `src/`.

Each `src/flows/<flow>/` directory contains `index.ts`, deterministic seed data, scenarios, and cases. Shared HTTP, NATS, database, waiting, and reporting helpers belong in `src/harness/`. The dashboard is in `ui/`. Treat `run/` as generated local state (logs, PIDs, keys, and result JSON), not source code.

## Build, Test, and Development Commands

- `pnpm install` installs the TypeScript tooling and NATS client.
- `pnpm typecheck` runs strict TypeScript validation without emitting files.
- `./e2e list` shows supported flows.
- `./e2e run tomtom` brings up dependencies, seeds data, runs every case, and verifies database state.
- `./e2e test tomtom t11-carrera-manual` reruns one case while debugging.
- `./e2e up <flow>` and `./e2e down <flow>` manage services; use `down --all` only when shared infrastructure should also stop.
- `./e2e ui <flow>` starts the local diagnostic dashboard on port 7777. It builds `ui/dist` first if the React/Vite frontend in `ui/src` is stale (installing `ui/node_modules` on first run); `cd ui && pnpm dev` gives hot-reload while iterating on the panel itself.

The harness expects sibling application repositories under the same `ER/` directory, plus Docker, Node.js, pnpm, Maven, OpenSSL, and PostgreSQL tooling.

## Coding Style & Naming Conventions

Use two-space indentation, single quotes, semicolons, and strict TypeScript types. Prefer `import type` for cross-repository DTOs. Keep flow names lowercase (`ventaabordo`) and case identifiers stable and descriptive (`t11-carrera-manual`). Bash files must start with `#!/usr/bin/env bash`, quote variable expansions, and reuse helpers from `lib/common.sh`. No formatter or linter is configured, so match nearby code and always run `pnpm typecheck`.

## Testing Guidelines

Tests use the custom `CaseDef`/`Report` harness and are colocated in `src/flows/<flow>/cases.ts`. Seeds must be idempotent and identifiers deterministic so individual cases can run independently. New flows must export a `Flow` from `index.ts` and be registered in `src/cli.ts`. There is no coverage threshold; validate behavior through the relevant full-chain flow and confirm the DLQ remains empty where applicable.

## Commit & Pull Request Guidelines

Git history is not available in this directory. Use concise, imperative subjects with a scope when useful, such as `tomtom: cover duplicate geofence event`. Pull requests should describe the affected flow, setup assumptions, commands run, and results. Link the issue and include dashboard screenshots when UI or diagnostic output changes.

## Security & Generated State

Never commit real credentials, generated keys, logs, PIDs, or result files from `run/`. Use disposable test credentials; document required environment variables without secrets.
