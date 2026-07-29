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
    currentClose: number;
    highestClose250: number;
    threshold85: number;
    currentVsHighestClosePct: number;
    distanceAboveThresholdPct: number;
    lookbackWeeks: number;
  };
};
