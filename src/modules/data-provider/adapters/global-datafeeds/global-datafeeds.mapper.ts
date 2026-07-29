import { normalizeSymbol } from "../../../../shared/normalize";
import type {
  ProviderDailyCandle,
  ProviderInstrument,
  ProviderSymbolDailyCandle,
} from "../../data-provider.types";
import type {
  GlobalDatafeedsHistoryRow,
  GlobalDatafeedsInstrumentRow,
  GlobalDatafeedsQuoteRow,
} from "./global-datafeeds.types";

function toFiniteNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function toDateOnlyFromEpochSeconds(value: unknown) {
  const seconds = toFiniteNumber(value);
  if (!seconds) return null;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function isUsableBseEquity(row: GlobalDatafeedsInstrumentRow) {
  const series = row.Series?.trim().toUpperCase();
  const high52Week = toFiniteNumber(row.High52Week);
  const low52Week = toFiniteNumber(row.Low52Week);
  const lot = toFiniteNumber(row.QuotationLot);

  if (!row.IsCommonExchange) return false;
  if (!row.ISIN?.startsWith("INE")) return false;
  if (lot !== null && lot > 1) return false;
  if (high52Week !== null && high52Week <= 0) return false;
  if (low52Week !== null && low52Week <= 0) return false;
  if (series && ["F", "M", "MT", "NS", "P"].includes(series)) return false;

  return true;
}

export function toGlobalDatafeedsInstrument(
  row: GlobalDatafeedsInstrumentRow,
  exchange: string
): ProviderInstrument | null {
  if (exchange === "BSE" && !isUsableBseEquity(row)) return null;

  const identifier = row.Identifier?.trim();
  if (!identifier) return null;

  const symbol = normalizeSymbol(row.TradeSymbol || identifier);
  if (!symbol) return null;

  return {
    exchange,
    symbol,
    name: row.Description?.trim() || row.Product?.trim() || row.TradeSymbol?.trim() || symbol,
    instrumentToken: identifier,
    segment:
      [row.Series?.trim(), row.Category?.trim()].filter(Boolean).join(" / ") ||
      row.Name?.trim() ||
      undefined,
  };
}

export function toGlobalDatafeedsDailyCandle(
  row: GlobalDatafeedsHistoryRow
): ProviderDailyCandle | null {
  const time = toDateOnlyFromEpochSeconds(row.LastTradeTime);
  const open = toFiniteNumber(row.Open);
  const high = toFiniteNumber(row.High);
  const low = toFiniteNumber(row.Low);
  const close = toFiniteNumber(row.Close);
  const volume = toFiniteNumber(row.TradedQty) ?? 0;

  if (!time || open === null || high === null || low === null || close === null) {
    return null;
  }

  return {
    time,
    open,
    high,
    low,
    close,
    volume,
  };
}

export function toGlobalDatafeedsLatestDailyCandle(
  quote: GlobalDatafeedsQuoteRow,
  symbol: string
): ProviderSymbolDailyCandle | null {
  const price = toFiniteNumber(quote.LastTradePrice);
  const open = toFiniteNumber(quote.Open) ?? price;
  const high = toFiniteNumber(quote.High) ?? price;
  const low = toFiniteNumber(quote.Low) ?? price;
  const close = price ?? toFiniteNumber(quote.Close);
  const volume = toFiniteNumber(quote.TotalQtyTraded) ?? 0;
  const time = toDateOnlyFromEpochSeconds(quote.LastTradeTime ?? quote.ServerTime);

  if (!time || open === null || high === null || low === null || close === null) {
    return null;
  }

  return {
    symbol,
    time,
    open,
    high,
    low,
    close,
    volume,
  };
}
