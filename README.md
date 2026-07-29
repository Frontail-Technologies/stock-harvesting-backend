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
npm run dev
npm run worker
```

The frontend should call `http://localhost:4000` through `NEXT_PUBLIC_API_BASE_URL`.

## Route Naming

Client-facing APIs use broker-neutral names such as `market-data` and `data-provider`. Provider-specific naming is intentionally limited to backend adapter files.
