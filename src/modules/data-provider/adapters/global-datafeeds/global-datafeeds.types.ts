export type GlobalDatafeedsExchange = "BSE" | "BSE_IDX" | string;

export type GlobalDatafeedsRequest = Record<string, unknown> & {
  MessageType: string;
  UserTag?: string;
};

export type GlobalDatafeedsResponse = Record<string, unknown> & {
  MessageType?: string;
  Complete?: boolean;
  Message?: string;
  PaketID?: number;
  Request?: {
    MessageType?: string;
    UserTag?: string | null;
  };
  Result?: unknown;
};

export type GlobalDatafeedsInstrumentRow = {
  Identifier?: string;
  TradeSymbol?: string;
  Name?: string;
  Description?: string;
  Product?: string;
  Series?: string;
  TokenNumber?: string | number;
  ISIN?: string;
  High52Week?: number;
  Low52Week?: number;
  Category?: string;
  IsCommonExchange?: boolean;
  QuotationLot?: number;
};

export type GlobalDatafeedsHistoryRow = {
  LastTradeTime?: number;
  TradedQty?: number;
  Open?: number;
  High?: number;
  Low?: number;
  Close?: number;
};

export type GlobalDatafeedsQuoteRow = {
  Exchange?: string;
  InstrumentIdentifier?: string;
  LastTradeTime?: number;
  ServerTime?: number;
  LastTradePrice?: number;
  TradedQty?: number;
  Open?: number;
  High?: number;
  Low?: number;
  Close?: number;
  TotalQtyTraded?: number;
  PriceChange?: number;
  PriceChangePercentage?: number;
  MessageType?: string;
  Message?: string;
};
