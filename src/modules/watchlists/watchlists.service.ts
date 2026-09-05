import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { instruments, watchlistItems, watchlists } from "../../db/schema";
import { conflict, forbidden, notFound } from "../../shared/errors";
import { normalizeSymbol } from "../../shared/normalize";
import {
  computeAllRelativeStrengthMetrics,
  pickTopRelativeStrengthRows,
  type RelativeStrengthInstrumentInput,
  type RelativeStrengthMetricRow,
} from "../market-data/market-data.service";

type WatchlistRow = typeof watchlists.$inferSelect;
type WatchlistItemRow = typeof watchlistItems.$inferSelect;

// Pure ownership check, split out from the DB lookup around it so it can be
// unit tested without a database connection (matches the existing
// price-alerts.service.ts pattern of fetch-then-check-ownership, just with
// the check itself made independently testable).
export function assertWatchlistOwnership(
  watchlist: Pick<WatchlistRow, "userId"> | undefined | null,
  userId: string
): asserts watchlist is Pick<WatchlistRow, "userId"> {
  if (!watchlist) throw notFound("Watchlist not found");
  if (watchlist.userId !== userId) throw forbidden("Watchlist belongs to another user");
}

// Also DB-independent: given the items already in a watchlist, decide
// whether adding (exchange, symbol) would duplicate an existing entry. The
// DB's own unique constraint is still the backstop against a race between
// this check and the insert - this just produces a clean, friendly error
// for the common case instead of a raw constraint-violation error.
export function findDuplicateWatchlistItem(
  items: Array<Pick<WatchlistItemRow, "exchange" | "symbol">>,
  exchange: string,
  symbol: string
) {
  const normalizedSymbol = normalizeSymbol(symbol);
  return (
    items.find(
      (item) => item.exchange === exchange && item.symbol === normalizedSymbol
    ) ?? null
  );
}

// Pure/DB-independent, so it's unit tested directly (same split as
// assertWatchlistOwnership/findDuplicateWatchlistItem above). A Watchlist
// can mix exchanges in a way a market-collection never does, and the
// shared relative-strength evaluator computes per single exchange, so the
// items have to be bucketed before each bucket is evaluated separately.
export function groupSymbolsByExchange(
  items: Array<{ exchange: string; symbol: string }>
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const item of items) {
    const bucket = grouped.get(item.exchange);
    if (bucket) bucket.push(item.symbol);
    else grouped.set(item.exchange, [item.symbol]);
  }
  return grouped;
}

export async function listWatchlists(input: { userId: string }) {
  const rows = await db
    .select({
      id: watchlists.id,
      name: watchlists.name,
      createdAt: watchlists.createdAt,
      updatedAt: watchlists.updatedAt,
      // Table-qualified on both sides deliberately, not the bare-column
      // interpolation this used to use: drizzle's `sql` tag renders a
      // Column reference as just its column name, and watchlist_items has
      // its own `id` primary key - inside this subquery's scope, an
      // unqualified "id" resolves to THAT (its own PK) rather than the
      // intended outer watchlists.id, silently turning the correlation
      // into watchlist_id = id (always false) and making itemCount always
      // 0. Same bug/fix already applied to market-collections.service.ts's
      // listCollections memberCount subquery.
      itemCount: sql<number>`(
        select count(*)::int from "watchlist_items"
        where "watchlist_items"."watchlist_id" = "watchlists"."id"
      )`,
    })
    .from(watchlists)
    .where(eq(watchlists.userId, input.userId))
    .orderBy(asc(watchlists.createdAt));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    itemCount: row.itemCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

async function getOwnedWatchlist(id: string, userId: string) {
  const [existing] = await db.select().from(watchlists).where(eq(watchlists.id, id)).limit(1);
  assertWatchlistOwnership(existing, userId);
  return existing;
}

export async function getWatchlist(input: { userId: string; id: string }) {
  const watchlist = await getOwnedWatchlist(input.id, input.userId);
  const items = await db
    .select()
    .from(watchlistItems)
    .where(eq(watchlistItems.watchlistId, watchlist.id))
    .orderBy(asc(watchlistItems.position), asc(watchlistItems.createdAt));

  return toWatchlistDetailResponse(watchlist, items);
}

// Ranks a Watchlist's current members through the exact same relative-
// strength evaluator Dashboard's Stock Harvest widget uses for a market
// collection (computeAllRelativeStrengthMetrics/pickTopRelativeStrengthRows,
// re-exported from market-data.service.ts - not reimplemented here). The
// only thing this adds is sourcing the instrument universe from a
// Watchlist's live membership instead of a collection's, computed fresh on
// every call (no persisted snapshot, unlike the collection path) since
// Watchlist membership is small and can change at any moment - a stale
// snapshot would silently show outdated rankings after an add/remove.
export async function getWatchlistRelativeStrength(input: {
  userId: string;
  id: string;
  limit: number;
}) {
  const watchlist = await getOwnedWatchlist(input.id, input.userId);
  const items = await db
    .select({ exchange: watchlistItems.exchange, symbol: watchlistItems.symbol })
    .from(watchlistItems)
    .where(eq(watchlistItems.watchlistId, watchlist.id));

  if (items.length === 0) {
    return {
      watchlist: { id: watchlist.id, name: watchlist.name },
      metrics: [] as RelativeStrengthMetricRow[],
      asOfDate: null as string | null,
    };
  }

  const bySymbolsPerExchange = groupSymbolsByExchange(items);
  const allMetrics: RelativeStrengthMetricRow[] = [];

  for (const [exchange, symbols] of bySymbolsPerExchange) {
    const instrumentRows: RelativeStrengthInstrumentInput[] = await db
      .select({
        symbol: instruments.symbol,
        name: instruments.name,
        exchange: instruments.exchange,
        sector: instruments.sector,
        industry: instruments.industry,
      })
      .from(instruments)
      .where(and(eq(instruments.exchange, exchange), inArray(instruments.symbol, symbols)));

    const metrics = await computeAllRelativeStrengthMetrics(instrumentRows, exchange);
    allMetrics.push(...metrics);
  }

  return {
    watchlist: { id: watchlist.id, name: watchlist.name },
    metrics: pickTopRelativeStrengthRows(allMetrics, input.limit),
    asOfDate: new Date().toISOString().slice(0, 10),
  };
}

export async function createWatchlist(input: { userId: string; name: string }) {
  const [row] = await db
    .insert(watchlists)
    .values({ userId: input.userId, name: input.name })
    .returning();

  return toWatchlistSummaryResponse(row, 0);
}

export async function renameWatchlist(input: { userId: string; id: string; name: string }) {
  await getOwnedWatchlist(input.id, input.userId);

  const [row] = await db
    .update(watchlists)
    .set({ name: input.name, updatedAt: new Date() })
    .where(eq(watchlists.id, input.id))
    .returning();

  const [{ itemCount }] = await db
    .select({ itemCount: sql<number>`count(*)::int` })
    .from(watchlistItems)
    .where(eq(watchlistItems.watchlistId, input.id));

  return toWatchlistSummaryResponse(row, itemCount);
}

export async function deleteWatchlist(input: { userId: string; id: string }) {
  await getOwnedWatchlist(input.id, input.userId);
  await db.delete(watchlists).where(eq(watchlists.id, input.id));
  return { ok: true };
}

export async function addWatchlistItem(input: {
  userId: string;
  watchlistId: string;
  exchange: string;
  symbol: string;
}) {
  const watchlist = await getOwnedWatchlist(input.watchlistId, input.userId);
  const symbol = normalizeSymbol(input.symbol);

  const existingItems = await db
    .select({ exchange: watchlistItems.exchange, symbol: watchlistItems.symbol })
    .from(watchlistItems)
    .where(eq(watchlistItems.watchlistId, watchlist.id));

  if (findDuplicateWatchlistItem(existingItems, input.exchange, symbol)) {
    throw conflict("This stock is already in the watchlist");
  }

  const [row] = await db
    .insert(watchlistItems)
    .values({ watchlistId: watchlist.id, exchange: input.exchange, symbol })
    .returning();

  await db.update(watchlists).set({ updatedAt: new Date() }).where(eq(watchlists.id, watchlist.id));

  return toWatchlistItemResponse(row);
}

export async function removeWatchlistItem(input: {
  userId: string;
  watchlistId: string;
  itemId: string;
}) {
  const watchlist = await getOwnedWatchlist(input.watchlistId, input.userId);
  const [existing] = await db
    .select()
    .from(watchlistItems)
    .where(eq(watchlistItems.id, input.itemId))
    .limit(1);
  if (!existing || existing.watchlistId !== watchlist.id) {
    throw notFound("Watchlist item not found");
  }

  await db.delete(watchlistItems).where(eq(watchlistItems.id, input.itemId));
  await db.update(watchlists).set({ updatedAt: new Date() }).where(eq(watchlists.id, watchlist.id));
  return { ok: true };
}

function toWatchlistItemResponse(row: WatchlistItemRow) {
  return {
    id: row.id,
    exchange: row.exchange,
    symbol: row.symbol,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
  };
}

function toWatchlistSummaryResponse(row: WatchlistRow, itemCount: number) {
  return {
    id: row.id,
    name: row.name,
    itemCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toWatchlistDetailResponse(row: WatchlistRow, items: WatchlistItemRow[]) {
  return {
    id: row.id,
    name: row.name,
    items: items.map(toWatchlistItemResponse),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
