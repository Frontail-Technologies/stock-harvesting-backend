import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../market-collections/market-collections.service", () => ({
  requireCollectionByCode: vi.fn(),
  getActiveMemberInstrumentRows: vi.fn(),
}));
vi.mock("../market-data/market-data.candles", async () => {
  const actual = await vi.importActual<typeof import("../market-data/market-data.candles")>(
    "../market-data/market-data.candles",
  );
  return { ...actual, readMetricCandles: vi.fn() };
});
vi.mock("../scanner/scanner-current-signal", () => ({
  resolveScannerSignalFromDailyCloses: vi.fn(),
}));

import { getWeekEndingFriday } from "../market-data/trading-calendar";
import * as marketCollectionsModule from "../market-collections/market-collections.service";
import * as candlesModule from "../market-data/market-data.candles";
import * as scannerSignalModule from "../scanner/scanner-current-signal";
import {
  computeMembershipChanges,
  getWeeklyStrongBacktestMembershipChanges,
  type WeeklyStrongBacktestMembershipChangeMember,
} from "./weekly-strong-backtest.queries";

const requireCollectionByCode = vi.mocked(marketCollectionsModule.requireCollectionByCode);
const getActiveMemberInstrumentRows = vi.mocked(marketCollectionsModule.getActiveMemberInstrumentRows);
const readMetricCandles = vi.mocked(candlesModule.readMetricCandles);
const resolveScannerSignalFromDailyCloses = vi.mocked(scannerSignalModule.resolveScannerSignalFromDailyCloses);

function member(symbol: string, exchange = "NSE", instrumentId = `${exchange}:${symbol}`) {
  return { instrumentId, symbol, name: symbol, exchange };
}

function assertInOutInvariants(
  current: WeeklyStrongBacktestMembershipChangeMember[],
  previous: WeeklyStrongBacktestMembershipChangeMember[],
  entered: WeeklyStrongBacktestMembershipChangeMember[],
  exited: WeeklyStrongBacktestMembershipChangeMember[],
) {
  const currentIds = new Set(current.map((m) => m.instrumentId));
  const previousIds = new Set(previous.map((m) => m.instrumentId));

  for (const stock of entered) {
    expect(currentIds.has(stock.instrumentId)).toBe(true);
    expect(previousIds.has(stock.instrumentId)).toBe(false);
  }
  for (const stock of exited) {
    expect(previousIds.has(stock.instrumentId)).toBe(true);
    expect(currentIds.has(stock.instrumentId)).toBe(false);
  }
}

describe("computeMembershipChanges", () => {
  it("A: identical membership -> no entries, no exits", () => {
    const previous = [member("A"), member("B"), member("C")];
    const current = [member("A"), member("B"), member("C")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, previous);

    expect(enteredStocks).toEqual([]);
    expect(exitedStocks).toEqual([]);
    assertInOutInvariants(current, previous, enteredStocks, exitedStocks);
  });

  it("B: a new stock qualifies -> entered only", () => {
    const previous = [member("A"), member("B")];
    const current = [member("A"), member("B"), member("C")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, previous);

    expect(enteredStocks).toEqual([member("C")]);
    expect(exitedStocks).toEqual([]);
  });

  it("C: a stock drops off -> exited only", () => {
    const previous = [member("A"), member("B"), member("C")];
    const current = [member("A"), member("B")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, previous);

    expect(enteredStocks).toEqual([]);
    expect(exitedStocks).toEqual([member("C")]);
  });

  it("D: the task's canonical example - previous [A,B,C], current [B,C,D] -> IN [D], OUT [A], B/C unchanged", () => {
    const previous = [member("A"), member("B"), member("C")];
    const current = [member("B"), member("C"), member("D")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, previous);

    expect(enteredStocks).toEqual([member("D")]);
    expect(exitedStocks).toEqual([member("A")]);
    const changedIds = new Set([...enteredStocks, ...exitedStocks].map((m) => m.instrumentId));
    expect(changedIds.has(member("B").instrumentId)).toBe(false);
    expect(changedIds.has(member("C").instrumentId)).toBe(false);
    assertInOutInvariants(current, previous, enteredStocks, exitedStocks);
  });

  it("E: the same symbol on a different exchange is a distinct identity", () => {
    const previous = [member("TCS", "NSE")];
    const current = [member("TCS", "BSE")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, previous);

    expect(enteredStocks).toEqual([member("TCS", "BSE")]);
    expect(exitedStocks).toEqual([member("TCS", "NSE")]);
  });

  it("F: no previous result -> every current member counts as entered, nothing exits", () => {
    const current = [member("A"), member("B")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, null);

    expect(enteredStocks).toEqual(current);
    expect(exitedStocks).toEqual([]);
  });

  it("a previous run with zero members is not the same as no previous run - everything current still counts as entered", () => {
    const current = [member("A")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, []);

    expect(enteredStocks).toEqual([member("A")]);
    expect(exitedStocks).toEqual([]);
  });

  it("identical snapshots produce zero IN and zero OUT even with a larger overlapping set", () => {
    const stocks = [member("A"), member("B"), member("C"), member("D"), member("E")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(stocks, stocks);

    expect(enteredStocks).toHaveLength(0);
    expect(exitedStocks).toHaveLength(0);
  });

  it("duplicate rows for the same instrumentId do not create duplicate IN/OUT rows", () => {
    const previous = [member("A"), member("A"), member("B")];
    const current = [member("B"), member("C"), member("C"), member("C")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, previous);

    expect(enteredStocks).toEqual([member("C")]);
    expect(exitedStocks).toEqual([member("A")]);
  });

  it("canonical instrumentId drives identity, not symbol text: a real rename (same instrumentId, new symbol) is unchanged", () => {
    const previous = [member("OLDNAME", "BSE", "instrument-1")];
    const current = [member("NEWNAME", "BSE", "instrument-1")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, previous);

    expect(enteredStocks).toEqual([]);
    expect(exitedStocks).toEqual([]);
  });

  it("canonical instrumentId drives identity, not symbol text: two different instruments sharing a symbol are both entered and exited", () => {
    const previous = [member("TCS", "BSE", "instrument-old")];
    const current = [member("TCS", "BSE", "instrument-new")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, previous);

    expect(enteredStocks).toEqual([member("TCS", "BSE", "instrument-new")]);
    expect(exitedStocks).toEqual([member("TCS", "BSE", "instrument-old")]);
  });

  it("invariants hold across a larger mixed fixture", () => {
    const previous = [member("A"), member("B"), member("C"), member("D"), member("E")];
    const current = [member("C"), member("D"), member("E"), member("F"), member("G")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, previous);

    expect(enteredStocks.map((m) => m.symbol).sort()).toEqual(["F", "G"]);
    expect(exitedStocks.map((m) => m.symbol).sort()).toEqual(["A", "B"]);
    assertInOutInvariants(current, previous, enteredStocks, exitedStocks);
  });
});

function dailyRow(symbol: string, time = "2026-09-11", close = 100) {
  return { symbol, time, open: close, high: close, low: close, close, volume: 1000 };
}

function scannerMembers(instrumentRows: ReturnType<typeof member>[]) {
  return instrumentRows.map((m) => ({
    instrumentId: m.instrumentId,
    symbol: m.symbol,
    name: m.name,
    exchange: m.exchange,
    sector: null,
    industry: null,
  }));
}

describe("getWeeklyStrongBacktestMembershipChanges - Scanner-qualified membership diff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireCollectionByCode.mockResolvedValue({
      id: "col-1",
      code: "SEG1",
      name: "Segment One",
      exchange: "NSE",
    } as never);
  });

  it("11: previous Scanner ON, current Scanner OFF -> Stocks Out", async () => {
    const a = member("A");
    getActiveMemberInstrumentRows.mockResolvedValue(scannerMembers([a]) as never);
    readMetricCandles.mockResolvedValue([dailyRow("A")] as never);
    resolveScannerSignalFromDailyCloses.mockReturnValueOnce({
      matched: false,
      effectiveLookbackWeeks: 250,
      currentTime: "2026-09-08",
      currentClose: 100,
      entryTime: null,
      entryClose: null,
      previousWeekMatched: true,
      previousWeekTime: "2026-09-01",
    } as never);

    const result = await getWeeklyStrongBacktestMembershipChanges({ code: "SEG1", weekEnding: "2026-09-11" });

    expect(result.available).toBe(true);
    expect(result.weekEnding).toBe(getWeekEndingFriday("2026-09-08"));
    expect(result.previousWeekEnding).toBe(getWeekEndingFriday("2026-09-01"));
    expect(result.enteredStocks).toEqual([]);
    expect(result.exitedStocks).toEqual([{ instrumentId: a.instrumentId, symbol: "A", name: "A", exchange: "NSE" }]);
  });

  it("12: previous Scanner OFF, current Scanner ON -> Stocks In", async () => {
    const a = member("A");
    getActiveMemberInstrumentRows.mockResolvedValue(scannerMembers([a]) as never);
    readMetricCandles.mockResolvedValue([dailyRow("A")] as never);
    resolveScannerSignalFromDailyCloses.mockReturnValueOnce({
      matched: true,
      effectiveLookbackWeeks: 250,
      currentTime: "2026-09-08",
      currentClose: 100,
      entryTime: "2026-09-08",
      entryClose: 100,
      previousWeekMatched: false,
      previousWeekTime: "2026-09-01",
    } as never);

    const result = await getWeeklyStrongBacktestMembershipChanges({ code: "SEG1", weekEnding: "2026-09-11" });

    expect(result.enteredStocks).toEqual([{ instrumentId: a.instrumentId, symbol: "A", name: "A", exchange: "NSE" }]);
    expect(result.exitedStocks).toEqual([]);
  });

  it("D: the task's canonical example via Scanner signals - previous [A,B,C], current [B,C,D] -> IN [D], OUT [A]", async () => {
    const [a, b, c, d] = [member("A"), member("B"), member("C"), member("D")];
    getActiveMemberInstrumentRows.mockResolvedValue(scannerMembers([a, b, c, d]) as never);
    readMetricCandles.mockResolvedValue(
      [dailyRow("A"), dailyRow("B"), dailyRow("C"), dailyRow("D")] as never
    );
    const baseSignal = {
      effectiveLookbackWeeks: 250,
      currentTime: "2026-09-08",
      currentClose: 100,
      previousWeekTime: "2026-09-01",
    };
    resolveScannerSignalFromDailyCloses
      .mockReturnValueOnce({ ...baseSignal, matched: false, entryTime: null, entryClose: null, previousWeekMatched: true } as never) // A: out
      .mockReturnValueOnce({ ...baseSignal, matched: true, entryTime: "2026-09-08", entryClose: 100, previousWeekMatched: true } as never) // B: unchanged
      .mockReturnValueOnce({ ...baseSignal, matched: true, entryTime: "2026-09-08", entryClose: 100, previousWeekMatched: true } as never) // C: unchanged
      .mockReturnValueOnce({ ...baseSignal, matched: true, entryTime: "2026-09-08", entryClose: 100, previousWeekMatched: false } as never); // D: in

    const result = await getWeeklyStrongBacktestMembershipChanges({ code: "SEG1", weekEnding: "2026-09-11" });

    expect(result.enteredStocks).toEqual([{ instrumentId: d.instrumentId, symbol: "D", name: "D", exchange: "NSE" }]);
    expect(result.exitedStocks).toEqual([{ instrumentId: a.instrumentId, symbol: "A", name: "A", exchange: "NSE" }]);
  });

  it("13: uses instrumentId identity, not symbol text - a symbol rename (same instrumentId) is unchanged", async () => {
    const renamed = member("NEWNAME", "NSE", "instrument-1");
    getActiveMemberInstrumentRows.mockResolvedValue(scannerMembers([renamed]) as never);
    readMetricCandles.mockResolvedValue([dailyRow("NEWNAME")] as never);
    resolveScannerSignalFromDailyCloses.mockReturnValueOnce({
      matched: true,
      effectiveLookbackWeeks: 250,
      currentTime: "2026-09-08",
      currentClose: 100,
      entryTime: "2026-09-08",
      entryClose: 100,
      previousWeekMatched: true,
      previousWeekTime: "2026-09-01",
    } as never);

    const result = await getWeeklyStrongBacktestMembershipChanges({ code: "SEG1", weekEnding: "2026-09-11" });

    expect(result.enteredStocks).toEqual([]);
    expect(result.exitedStocks).toEqual([]);
  });

  it("no members have a currently-fresh Scanner week -> unavailable", async () => {
    const a = member("A");
    getActiveMemberInstrumentRows.mockResolvedValue(scannerMembers([a]) as never);
    readMetricCandles.mockResolvedValue([dailyRow("A")] as never);
    resolveScannerSignalFromDailyCloses.mockReturnValueOnce({
      matched: false,
      effectiveLookbackWeeks: null,
      currentTime: null,
      currentClose: null,
      entryTime: null,
      entryClose: null,
      previousWeekMatched: null,
      previousWeekTime: null,
    } as never);

    const result = await getWeeklyStrongBacktestMembershipChanges({ code: "SEG1", weekEnding: "2026-09-11" });

    expect(result.available).toBe(false);
    expect(result.weekEnding).toBeNull();
    expect(result.enteredStocks).toEqual([]);
    expect(result.exitedStocks).toEqual([]);
  });

  it("a collection with no active members is unavailable without ever fetching candles", async () => {
    getActiveMemberInstrumentRows.mockResolvedValue([] as never);

    const result = await getWeeklyStrongBacktestMembershipChanges({ code: "SEG1", weekEnding: "2026-09-11" });

    expect(result.available).toBe(false);
    expect(readMetricCandles).not.toHaveBeenCalled();
  });

  it("no earlier week exists at all -> previousWeekEnding is null and every current member counts as entered", async () => {
    const a = member("A");
    getActiveMemberInstrumentRows.mockResolvedValue(scannerMembers([a]) as never);
    readMetricCandles.mockResolvedValue([dailyRow("A")] as never);
    resolveScannerSignalFromDailyCloses.mockReturnValueOnce({
      matched: true,
      effectiveLookbackWeeks: 250,
      currentTime: "2026-09-08",
      currentClose: 100,
      entryTime: "2026-09-08",
      entryClose: 100,
      previousWeekMatched: null,
      previousWeekTime: null,
    } as never);

    const result = await getWeeklyStrongBacktestMembershipChanges({ code: "SEG1", weekEnding: "2026-09-11" });

    expect(result.previousWeekEnding).toBeNull();
    expect(result.enteredStocks).toEqual([{ instrumentId: a.instrumentId, symbol: "A", name: "A", exchange: "NSE" }]);
    expect(result.exitedStocks).toEqual([]);
  });

  it("a requested week that doesn't match the current live Scanner week is unavailable, not silently substituted", async () => {
    const a = member("A");
    getActiveMemberInstrumentRows.mockResolvedValue(scannerMembers([a]) as never);
    readMetricCandles.mockResolvedValue([dailyRow("A")] as never);
    resolveScannerSignalFromDailyCloses.mockReturnValueOnce({
      matched: true,
      effectiveLookbackWeeks: 250,
      currentTime: "2026-09-08",
      currentClose: 100,
      entryTime: "2026-09-08",
      entryClose: 100,
      previousWeekMatched: true,
      previousWeekTime: "2026-09-01",
    } as never);

    const result = await getWeeklyStrongBacktestMembershipChanges({ code: "SEG1", weekEnding: "2026-08-01" });

    expect(result.available).toBe(false);
  });
});
