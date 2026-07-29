import {
  boolean,
  date,
  index,
  numeric,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { candleTimeframeEnum } from "./enums";

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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    exchangeActiveSymbolIdx: index("instruments_exchange_active_symbol_idx").on(
      table.exchange,
      table.active,
      table.symbol
    ),
    exchangeActiveNameIdx: index("instruments_exchange_active_name_idx").on(
      table.exchange,
      table.active,
      table.name
    ),
    exchangeActiveChangePctIdx: index("instruments_exchange_active_change_pct_idx").on(
      table.exchange,
      table.active,
      table.latestChangePct
    ),
    exchangeSymbolUnique: unique().on(table.exchange, table.symbol),
    providerTokenUnique: unique().on(table.provider, table.instrumentToken),
  })
);

export const candles = pgTable(
  "candles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    instrumentId: uuid("instrument_id").references(() => instruments.id, {
      onDelete: "cascade",
    }),
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    candleUnique: unique().on(table.exchange, table.symbol, table.timeframe, table.time),
  })
);
