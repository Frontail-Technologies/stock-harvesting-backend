import { describe, expect, it } from "vitest";

import { toGlobalDatafeedsInstrument } from "./global-datafeeds.mapper";

function bseRow(overrides: Partial<Parameters<typeof toGlobalDatafeedsInstrument>[0]> = {}) {
  return {
    Identifier: "500325",
    TradeSymbol: "RELIANCE",
    Description: "Reliance Industries Ltd",
    Series: "A",
    IsCommonExchange: true,
    ISIN: "INE002A01018",
    QuotationLot: 1,
    High52Week: 3000,
    Low52Week: 2000,
    ...overrides,
  };
}

describe("toGlobalDatafeedsInstrument - BSE persistence universe", () => {
  it("A: an active BSE SME instrument with QuotationLot > 1 is persisted", () => {
    const result = toGlobalDatafeedsInstrument(
      bseRow({ Identifier: "SME001", TradeSymbol: "ABRIL", QuotationLot: 400 }),
      "BSE"
    );
    expect(result).not.toBeNull();
    expect(result?.symbol).toBe("ABRIL");
  });

  it("B: an active BSE instrument with missing/zero 52-week fields is not dropped solely for that reason", () => {
    const missing = toGlobalDatafeedsInstrument(
      bseRow({ Identifier: "SME002", TradeSymbol: "ACCORDTS", High52Week: undefined, Low52Week: undefined }),
      "BSE"
    );
    const zero = toGlobalDatafeedsInstrument(
      bseRow({ Identifier: "SME003", TradeSymbol: "ANL", High52Week: 0, Low52Week: 0 }),
      "BSE"
    );
    expect(missing).not.toBeNull();
    expect(zero).not.toBeNull();
  });

  it("C: a previously excluded trading series can exist in the instrument master as an active BSE instrument", () => {
    for (const series of ["F", "M", "MT", "NS", "P", "SM"]) {
      const result = toGlobalDatafeedsInstrument(
        bseRow({ Identifier: `SER_${series}`, TradeSymbol: `SYM${series}`, Series: series }),
        "BSE"
      );
      expect(result, `series ${series} should be persisted`).not.toBeNull();
    }
  });

  it("D: BSE_IDX is unaffected - the equity identity gate only applies to exchange === BSE", () => {
    const indexRow = bseRow({
      Identifier: "SENSEX",
      TradeSymbol: "SENSEX",
      IsCommonExchange: false,
      ISIN: undefined,
    });
    const result = toGlobalDatafeedsInstrument(indexRow, "BSE_IDX");
    expect(result).not.toBeNull();
    expect(result?.exchange).toBe("BSE_IDX");
  });

  it("E: the genuine identity-level gate (ISIN prefix) is preserved for BSE - IsCommonExchange is NOT gated on, since real active SME-board equities are returned with IsCommonExchange: false", () => {
    const notCommonExchangeButRealEquity = toGlobalDatafeedsInstrument(
      bseRow({ Identifier: "SME005", TradeSymbol: "ABRIL", IsCommonExchange: false }),
      "BSE"
    );
    const nonEquityIsin = toGlobalDatafeedsInstrument(bseRow({ ISIN: "US0378331005" }), "BSE");
    const missingIsin = toGlobalDatafeedsInstrument(bseRow({ ISIN: undefined }), "BSE");

    expect(notCommonExchangeButRealEquity).not.toBeNull();
    expect(nonEquityIsin).toBeNull();
    expect(missingIsin).toBeNull();
  });

  it("F: a normal, previously-eligible BSE instrument is unchanged", () => {
    const result = toGlobalDatafeedsInstrument(bseRow(), "BSE");
    expect(result).toEqual({
      exchange: "BSE",
      symbol: "RELIANCE",
      name: "Reliance Industries Ltd",
      instrumentToken: "500325",
      segment: "A",
    });
  });

  it("G: a newly-eligible SME instrument maps to the exact symbol identity collection CSV matching relies on", () => {
    const result = toGlobalDatafeedsInstrument(
      bseRow({ Identifier: "SME004", TradeSymbol: "admach", QuotationLot: 200, Series: "SM" }),
      "BSE"
    );
    expect(result?.symbol).toBe("ADMACH");
  });
});
