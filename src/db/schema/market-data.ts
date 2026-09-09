import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { candleBootstrapStatusEnum, candleTimeframeEnum } from "./enums";

export const instruments = pgTable(
  "instruments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: varchar("provider", { length: 64 }).notNull(),
    exchange: varchar("exchange", { length: 16 }).notNull(),
    symbol: varchar("symbol", { length: 64 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    instrumentToken: varchar("instrument_token", { length: 64 }).notNull(),
    segment: varchar("segment", { length: 64 }),
    active: boolean("active").default(true).notNull(),
    latestClose: numeric("latest_close", { precision: 18, scale: 4 }),
    latestOpen: numeric("latest_open", { precision: 18, scale: 4 }),
    latestVolume: numeric("latest_volume", { precision: 20, scale: 0 }),
    latestChangePct: numeric("latest_change_pct", { precision: 10, scale: 4 }),
    latestPriceAt: date("latest_price_at"),
    sector: varchar("sector", { length: 255 }),
    sectorCode: varchar("sector_code", { length: 32 }),
    industry: varchar("industry", { length: 255 }),
    industryCode: varchar("industry_code", { length: 32 }),
    classificationSyncedAt: timestamp("classification_synced_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    exchangeActiveSymbolIdx: index("instruments_exchange_active_symbol_idx").on(
      table.exchange,
      table.active,
      table.symbol,
    ),
    exchangeActiveNameIdx: index("instruments_exchange_active_name_idx").on(
      table.exchange,
      table.active,
      table.name,
    ),
    exchangeActiveChangePctIdx: index(
      "instruments_exchange_active_change_pct_idx",
    ).on(table.exchange, table.active, table.latestChangePct),
    exchangeSymbolUnique: unique().on(table.exchange, table.symbol),
    providerTokenUnique: unique().on(table.provider, table.instrumentToken),
  }),
);

export const candles = pgTable(
  "candles",
  {
    id: uuid("id").defaultRandom().notNull(),
    instrumentId: uuid("instrument_id")
      .references(() => instruments.id, {
        onDelete: "cascade",
      })
      .notNull(),
    exchange: varchar("exchange", { length: 16 }).notNull(),
    symbol: varchar("symbol", { length: 64 }).notNull(),
    timeframe: candleTimeframeEnum("timeframe").notNull(),
    time: date("time").notNull(),
    open: numeric("open", { precision: 18, scale: 4 }).notNull(),
    high: numeric("high", { precision: 18, scale: 4 }).notNull(),
    low: numeric("low", { precision: 18, scale: 4 }).notNull(),
    close: numeric("close", { precision: 18, scale: 4 }).notNull(),
    volume: numeric("volume", { precision: 20, scale: 0 }).notNull(),
    source: varchar("source", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.time] }),
    candleUnique: unique().on(
      table.exchange,
      table.symbol,
      table.timeframe,
      table.time,
    ),
  }),
);

// Per-symbol resume checkpoint for a bulk historical candle bootstrap (see
// bootstrap-bse-candles.ts). One row per (exchange, symbol, timeframe, kind) -
// deliberately NOT derived from candles.MIN(time), since an instrument's
// earliest stored candle reflects its listing date, not whether a bootstrap
// run already completed for it. `kind` distinguishes different bootstrap
// operations (e.g. different exchanges/scripts) without a schema change;
// `bootstrapVersion` lets a later change to bootstrap semantics/range
// invalidate old checkpoints deliberately (see isCandleBootstrapCheckpointSatisfied).
export const candleBootstrapCheckpoints = pgTable(
  "candle_bootstrap_checkpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    exchange: varchar("exchange", { length: 16 }).notNull(),
    symbol: varchar("symbol", { length: 64 }).notNull(),
    timeframe: candleTimeframeEnum("timeframe").notNull(),
    kind: varchar("kind", { length: 64 }).notNull(),
    bootstrapVersion: integer("bootstrap_version").notNull(),
    status: candleBootstrapStatusEnum("status").notNull(),
    requestedFrom: date("requested_from").notNull(),
    requestedTo: date("requested_to"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    candleCount: integer("candle_count"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    identityUnique: unique().on(
      table.exchange,
      table.symbol,
      table.timeframe,
      table.kind,
    ),
  }),
);
