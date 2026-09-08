# Stock Harvesting Backend

Express + TypeScript backend for Stock Harvesting.

## Stack

- Express
- Drizzle ORM
- PostgreSQL
- Redis + BullMQ
- Zod validation
- AES-256-GCM field encryption
- Access token + rotating refresh token auth

## Local Setup

```bash
cd backend
npm install
copy .env.example .env
npm run db:generate
npm run db:migrate
```

Then run three processes concurrently (separate terminals) — a running
Redis matching `REDIS_URL` is required, not just configured, or
collection-preparation/backtest jobs never get consumed. See
`docs/DEPLOYMENT.md` "Process topology" for the full explanation.

```bash
npm run dev          # API
npm run dev:worker   # worker (consumes BullMQ jobs)
redis-server         # or: docker run -p 6379:6379 redis
```

The frontend should call `http://localhost:4000` through `NEXT_PUBLIC_API_BASE_URL`.

## Route Naming

Client-facing APIs use broker-neutral names such as `market-data` and `data-provider`. Provider-specific naming is intentionally limited to backend adapter files.
