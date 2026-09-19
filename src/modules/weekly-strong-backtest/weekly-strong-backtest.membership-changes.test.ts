import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../market-collections/market-collections.service", () => ({
  requireCollectionByCode: vi.fn(),
  getActiveMemberInstrumentRows: vi.fn(),
}));
vi.mock("../market-data/market-data.candles", async () => {
  const actual = await vi.importActual<typeof import("../market-data/market-data.candles")>(
    "../market-data/market-data.candles",
  );
  return { ...actual, readMetricDailyCloses: vi.fn() };
});
vi.mock("../scanner/scanner-current-signal", () => ({
  resolveLiveScannerSignalFromDailyCloses: vi.fn(),
}));

import { getWeekEndingFriday, resolveLatestCompletedWeekEnding } from "../market-data/trading-calendar";
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
const readMetricDailyCloses = vi.mocked(candlesModule.readMetricDailyCloses);
const resolveLiveScannerSignalFromDailyCloses = vi.mocked(scannerSignalModule.resolveLiveScannerSignalFromDailyCloses);

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
    readMetricDailyCloses.mockResolvedValue([dailyRow("A")] as never);
    resolveLiveScannerSignalFromDailyCloses.mockReturnValueOnce({
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
    readMetricDailyCloses.mockResolvedValue([dailyRow("A")] as never);
    resolveLiveScannerSignalFromDailyCloses.mockReturnValueOnce({
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
    readMetricDailyCloses.mockResolvedValue(
      [dailyRow("A"), dailyRow("B"), dailyRow("C"), dailyRow("D")] as never
    );
    const baseSignal = {
      effectiveLookbackWeeks: 250,
      currentTime: "2026-09-08",
      currentClose: 100,
      previousWeekTime: "2026-09-01",
    };
    resolveLiveScannerSignalFromDailyCloses
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
    readMetricDailyCloses.mockResolvedValue([dailyRow("NEWNAME")] as never);
    resolveLiveScannerSignalFromDailyCloses.mockReturnValueOnce({
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

  it("weekEnding is optional - when omitted, resolves and returns the naturally-computed current week without a match check", async () => {
    const a = member("A");
    getActiveMemberInstrumentRows.mockResolvedValue(scannerMembers([a]) as never);
    readMetricDailyCloses.mockResolvedValue([dailyRow("A")] as never);
    resolveLiveScannerSignalFromDailyCloses.mockReturnValueOnce({
      matched: true,
      effectiveLookbackWeeks: 250,
      currentTime: "2026-09-08",
      currentClose: 100,
      entryTime: "2026-09-08",
      entryClose: 100,
      previousWeekMatched: false,
      previousWeekTime: "2026-09-01",
    } as never);

    const result = await getWeeklyStrongBacktestMembershipChanges({ code: "SEG1" });

    expect(result.available).toBe(true);
    expect(result.weekEnding).toBe(getWeekEndingFriday("2026-09-08"));
    expect(result.enteredStocks).toEqual([{ instrumentId: a.instrumentId, symbol: "A", name: "A", exchange: "NSE" }]);
  });

  it("a caller-supplied weekEnding that mismatches the resolved current week is still rejected (validation only skipped when omitted, not weakened)", async () => {
    const a = member("A");
    getActiveMemberInstrumentRows.mockResolvedValue(scannerMembers([a]) as never);
    readMetricDailyCloses.mockResolvedValue([dailyRow("A")] as never);
    resolveLiveScannerSignalFromDailyCloses.mockReturnValueOnce({
      matched: true,
      effectiveLookbackWeeks: 250,
      currentTime: "2026-09-08",
      currentClose: 100,
      entryTime: "2026-09-08",
      entryClose: 100,
      previousWeekMatched: false,
      previousWeekTime: "2026-09-01",
    } as never);

    const result = await getWeeklyStrongBacktestMembershipChanges({ code: "SEG1", weekEnding: "2026-08-01" });

    expect(result.available).toBe(false);
  });

  it("no members have a currently-fresh Scanner week -> unavailable", async () => {
    const a = member("A");
    getActiveMemberInstrumentRows.mockResolvedValue(scannerMembers([a]) as never);
    readMetricDailyCloses.mockResolvedValue([dailyRow("A")] as never);
    resolveLiveScannerSignalFromDailyCloses.mockReturnValueOnce({
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
    expect(readMetricDailyCloses).not.toHaveBeenCalled();
  });

  it("no earlier week exists at all -> previousWeekEnding is null and every current member counts as entered", async () => {
    const a = member("A");
    getActiveMemberInstrumentRows.mockResolvedValue(scannerMembers([a]) as never);
    readMetricDailyCloses.mockResolvedValue([dailyRow("A")] as never);
    resolveLiveScannerSignalFromDailyCloses.mockReturnValueOnce({
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
    readMetricDailyCloses.mockResolvedValue([dailyRow("A")] as never);
    resolveLiveScannerSignalFromDailyCloses.mockReturnValueOnce({
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

describe("getWeeklyStrongBacktestMembershipChanges - in-progress (live) week", () => {
  const shiftDays = (date: string, days: number) => {
    const shifted = new Date(`${date}T00:00:00.000Z`);
    shifted.setUTCDate(shifted.getUTCDate() + days);
    return shifted.toISOString().slice(0, 10);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    requireCollectionByCode.mockResolvedValue({
      id: "col-1",
      code: "SEG1",
      name: "Segment One",
      exchange: "BSE",
    } as never);
    getActiveMemberInstrumentRows.mockResolvedValue([
      { instrumentId: "BSE:A", symbol: "A", name: "A", exchange: "BSE" },
    ] as never);
  });

  it("a stock that qualifies mid-week is listed as In before the week completes, flagged inProgress with the latest daily date", async () => {
    const lastCompletedFriday = resolveLatestCompletedWeekEnding("BSE");
    const midWeek = shiftDays(lastCompletedFriday, 5); // Wednesday of the forming week
    readMetricDailyCloses.mockResolvedValue([
      { symbol: "A", time: shiftDays(lastCompletedFriday, 0), close: 100 },
      { symbol: "A", time: midWeek, close: 120 },
    ] as never);
    resolveLiveScannerSignalFromDailyCloses.mockReturnValueOnce({
      matched: true,
      effectiveLookbackWeeks: 250,
      currentTime: midWeek,
      currentClose: 120,
      entryTime: midWeek,
      entryClose: 120,
      previousWeekMatched: false,
      previousWeekTime: lastCompletedFriday,
    } as never);

    const result = await getWeeklyStrongBacktestMembershipChanges({ code: "SEG1" });

    expect(result.available).toBe(true);
    expect(result.inProgress).toBe(true);
    expect(result.weekEnding).toBe(getWeekEndingFriday(midWeek));
    expect(result.previousWeekEnding).toBe(lastCompletedFriday);
    expect(result.asOf).toBe(midWeek);
    expect(result.enteredStocks.map((stock) => stock.symbol)).toEqual(["A"]);
    expect(result.exitedStocks).toEqual([]);
  });

  it("a stock that stops qualifying mid-week is listed as Out immediately", async () => {
    const lastCompletedFriday = resolveLatestCompletedWeekEnding("BSE");
    const midWeek = shiftDays(lastCompletedFriday, 5);
    readMetricDailyCloses.mockResolvedValue([{ symbol: "A", time: midWeek, close: 80 }] as never);
    resolveLiveScannerSignalFromDailyCloses.mockReturnValueOnce({
      matched: false,
      effectiveLookbackWeeks: 250,
      currentTime: midWeek,
      currentClose: 80,
      entryTime: null,
      entryClose: null,
      previousWeekMatched: true,
      previousWeekTime: lastCompletedFriday,
    } as never);

    const result = await getWeeklyStrongBacktestMembershipChanges({ code: "SEG1" });

    expect(result.inProgress).toBe(true);
    expect(result.exitedStocks.map((stock) => stock.symbol)).toEqual(["A"]);
    expect(result.enteredStocks).toEqual([]);
  });

  it("is not flagged inProgress when the latest reading is already a completed week", async () => {
    const lastCompletedFriday = resolveLatestCompletedWeekEnding("BSE");
    const priorFriday = shiftDays(lastCompletedFriday, -7);
    readMetricDailyCloses.mockResolvedValue([{ symbol: "A", time: lastCompletedFriday, close: 100 }] as never);
    resolveLiveScannerSignalFromDailyCloses.mockReturnValueOnce({
      matched: true,
      effectiveLookbackWeeks: 250,
      currentTime: lastCompletedFriday,
      currentClose: 100,
      entryTime: lastCompletedFriday,
      entryClose: 100,
      previousWeekMatched: false,
      previousWeekTime: priorFriday,
    } as never);

    const result = await getWeeklyStrongBacktestMembershipChanges({ code: "SEG1" });

    expect(result.inProgress).toBe(false);
    expect(result.weekEnding).toBe(lastCompletedFriday);
  });
});
