export type ScannerCandle = {
  time: string;
  high: number;
  close: number;
};

export type Near250WeekHighScanMatch = {
  matched: boolean;
  startTime: string;
  endTime: string;
  highlightTimes: string[];
  metrics: {
    lookbackWeeks: number;
  };
};
