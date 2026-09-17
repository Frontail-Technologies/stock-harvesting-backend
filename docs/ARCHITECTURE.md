# Backend Architecture

`backend/src` is the current and final backend codebase (see `DECISIONS.md`).
This document describes what exists today, factually, and the principles
future cleanup should move toward. It is not a redesign.

## Current architecture

**Processes**
- API process (Express) — HTTP routes, request validation, auth, admin
  endpoints.
- Worker process (`src/worker.ts`) — BullMQ consumer for background jobs
  (instrument sync, price refresh, weekly-strong backtest jobs, collection
  preparation). Exits if `REDIS_URL` is not configured.

**Storage**
- PostgreSQL — canonical persistence, accessed through Drizzle. Not
  currently on TimescaleDB (candles are a plain `pgTable`).
- Redis — BullMQ queue backend for the worker process. When absent, some
  admin-triggered jobs fall back to running inline in the API request
  instead of being queued.

**Data access**
- Drizzle ORM — schema definitions under `src/db/schema/`, migrations via
  `drizzle-kit`.

**Jobs**
- BullMQ — one queue (`market-data`), job types defined in
  `src/shared/constants/jobs.ts`, consumed by `src/worker.ts`. Repeatable
  jobs are scheduled per supported exchange.

**Market data providers**
- GlobalDataFeeds — BSE equities, BSE indices, WebSocket-based (instrument
  sync, historical/latest candles). A separate REST client
  (GlobalDataFeeds Fundamentals) provides sector/industry classification.
- EODHD — still present, used as a fallback provider outside NSE/BSE.
- Zerodha — still present, used for NSE. Scheduled for removal (see
  `DECISIONS.md`, `ROADMAP.md`).

**Major existing modules** (`src/modules/`)
- `admin` — admin API surface: users, settings, jobs, sync triggers.
- `auth` — authentication.
- `data-provider` — provider adapters, provider registry, provider
  settings/health.
- `market-data` — instruments, candles, metrics (relative strength,
  weekly strong), dashboard snapshots, sector classification.
- `market-collections` — collection membership, versions, collection-scoped
  reads (relative strength, weekly strong, taxonomy).
- `weekly-strong-backtest` — backtest generation and read queries.
- `jobs` — queue setup/scheduling.
- `market-stream` — realtime WebSocket market data to clients.
- `monetization`, `security` — supporting concerns.

## Target principles

These describe the direction, not a folder tree to build ahead of need.
Modules should not be invented before the work that needs them.

- Layering: **HTTP → orchestration → business/domain logic → data access.**
  A route handler validates and delegates; it does not contain business
  rules or raw queries. `widget-preferences` (`routes.ts` → `controller.ts`
  → `service.ts` → `repository.ts`) is the first module realizing this in
  full, piloted 2026-09-17 - not yet rolled out to other modules.
- Provider infrastructure (transport, auth, request shaping for a specific
  vendor) stays separate from business/domain calculations (metrics,
  evaluators). A calculation must be testable without a live provider.
- The database is canonical state. A dashboard/read-model snapshot is a
  cache of that state, never a second source of truth for taxonomy or
  other current-instrument facts.
- Heavy provider/backfill work does not happen inside a normal read
  request. Sync and backfill are explicit admin/worker actions.
- `instrument.id` is the target canonical relationship identity between
  modules (collections, candles, metrics). `exchange + symbol` string
  identity is used today in several read paths and should be reduced
  systematically, not replaced in one pass.
- BSE is the target market. NSE-specific and Zerodha-specific code paths
  are legacy, kept only until explicitly removed per the roadmap.
