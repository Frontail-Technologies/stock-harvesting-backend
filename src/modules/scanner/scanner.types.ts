export type Near250WeekCloseHighScanMatch = {
  matched?: boolean;
  startTime: string;
  endTime: string;
  highlightTimes: string[];
  metrics: {
    lookbackWeeks: number | null;
  };
};
