# Decisions

Only decisions that are already locked. Not a wishlist, not assumptions.
Each entry stays until explicitly superseded by a new dated entry.

- 2026-09-12 — `backend/src` remains the final backend. The parallel
  `src-v2` approach is abandoned.
- 2026-09-12 — The backend will be improved incrementally, module by
  module, not rewritten.
- 2026-09-12 — BSE is the target market.
- 2026-09-12 — Zerodha should be removed.
- 2026-09-12 — NSE-specific functionality should be removed.
- 2026-09-19 — Zerodha market-data integration retired. GlobalDataFeeds
  delayed APIs are the sole production market-data source (GetHistory =
  canonical daily candles, GetSnapshot = current-day provisional candle,
  SubscribeSnapshot = passive current-day updates). Removed: Zerodha
  adapter, Kite market-stream provider, OAuth connect-url/connect admin
  endpoints and callback page, NSE/NSE_IDX provider routing,
  `ZERODHA_*` and `DATA_PROVIDER` env vars. NSE and NSE_IDX now resolve
  to no provider (never a fallback) and are never advertised. DB columns
  and historical rows (`instruments.provider = 'zerodha'`,
  `data_provider_settings`/`data_provider_connections` rows) are retained
  untouched - no destructive migration. `instruments.instrument_token` is
  provider-generic (GlobalDataFeeds uses it too) and stays.
- 2026-09-19 — The production instrument universe is one definition:
  active instruments stamped with their exchange's routed provider
  (`activeUniverseFilter`), on an exchange whose provider is enabled and
  configured. No hardcoded exchange or stock lists; legacy rows stay as
  history and never match. Instrument discovery additionally covers
  GlobalDataFeeds-configured exchanges so a new exchange can be populated.
- 2026-09-19 — Bootstrap no-history state: a full-range GetHistory that GlobalDataFeeds
  answers successfully with zero candles is stored as a success row (kind
  `no-history-check`, candle_count 0) in `candle_bootstrap_checkpoints` - no new table.
  Errors, timeouts and persistence failures never write it and stay retryable. Bootstrap
  candidates exclude a confirmation younger than 7 days; after that one more full-range
  check runs (admin per-symbol refresh rechecks immediately); the row is deleted when
  candles are stored. Confirmed no-history instruments are exempt (not missing) in
  historical coverage.
- 2026-09-12 — Fewer DB tables/schemas are preferred over more.
- 2026-09-12 — Drizzle is the default DB access approach.
- 2026-09-12 — Zero explanatory comments in touched production code
  (see `RULES.md` rule 6).
- 2026-09-12 — Work proceeds one module at a time.
- 2026-09-12 — Controlled sample testing is used instead of large-universe
  runs during development.
- 2026-09-12 — Business calculations should become isolated/testable,
  separate from provider/transport/persistence/HTTP/jobs.
- 2026-09-12 — Public routes should avoid proprietary methodology names.
- 2026-09-12 — No big-bang rewrite.
- 2026-09-12 — Instrument identity for provider sync uses the existing
  `provider + instrument_token` mechanism: a symbol change under the same
  `provider + instrument_token` updates the existing instrument row in
  place, preserving `instrument.id`, rather than dropping the row or
  creating a second one.
- 2026-09-12 — A rename whose new `exchange + symbol` already belongs to a
  different existing instrument is never auto-merged or auto-overwritten;
  it is left untouched and reported. Resolving such conflicts is a manual,
  product-owner-reviewed decision.
- 2026-09-12 — Existing fragmented instrument rows for the same real
  security (e.g. ARIS/ARISINFRA, CEINSYS/CEINSYSTECH) are left as-is for
  now; merging historical fragmented rows is deferred to a later, explicit
  phase, not done as part of fixing the sync behavior.
- 2026-09-12 — The uncommitted `instruments` schema draft adding `type`,
  `security_code`, `isin`, and the `instruments_type_check` constraint is
  abandoned and reverted. No current `backend/src` feature reads or writes
  these fields. A future schema addition to `instruments` (or any table)
  is introduced only when an active `backend/src` feature actually
  requires it, not speculatively ahead of a consumer.
- 2026-09-12 — Candle canonical identity is `instrument_id + timeframe +
  time`, not `exchange + symbol + timeframe + time`. `exchange`/`symbol` on
  `candles` remain transitional denormalized metadata only, never identity.
- 2026-09-12 — A symbol rename must never break historical candle reads:
  since `instrument.id` is now stable across a rename (see Phase 1B), every
  candle read/write keyed by `instrument_id` stays correct through a rename
  with no candle-row rewrite required.
- 2026-09-12 — `candle_bootstrap_checkpoints` identity migration to
  `instrument_id` is deferred to the later candle backfill phase; it is an
  operational/backfill-resume concern, not touched by Phase 2A.
- 2026-09-12 — Superseded by Phase 2B (below): `readMetricCandles` and
  `findSymbolsNeedingHistoryBackfill` no longer remain on `(exchange,
  symbol)` identity — `instrumentId` was threaded through their callers as
  its own approved phase.
- 2026-09-12 — All normal candle reads in `backend/src` (`readMetricCandles`,
  `findSymbolsNeedingHistoryBackfill`, plus the Phase 2A set) use
  `instrument_id`, not `exchange + symbol`. `symbol`/`exchange` are
  metadata/provider-request coordinates only; `instrumentId` is the sole DB
  candle-lookup identity. The two are never substituted for each other.
- 2026-09-12 — Superseded by Phase 2C (below): `market-data.stocks.ts`'s
  per-row candle-existence check no longer uses `exchange + symbol`.
- 2026-09-12 — Threading `instrumentId` through the Relative
  Strength/Weekly Strong instrument-row types
  (`RelativeStrengthInstrumentInput` and the equivalent inline types) is a
  pure identity-plumbing change: no formula, scoring, membership rule,
  snapshot, or dashboard-output semantics changed as a result.
- 2026-09-13 — Scanner qualification is a standalone rule, independent of
  Weekly Strong: `close > rollingMax(close, N) * 0.85` over completed
  weekly candles only, where `N` is 50 (1x), 150 (3x), or 250 (5x). The
  window includes the evaluated candle itself; the comparison is strict
  (`>`, not `>=`). Scanner does not call `evaluateWeeklyStrongSeries`, use
  `passesDaily`/`dailyLookbackBars`, or require any daily-candle
  confirmation. This supersedes the prior design (see the 2026-09-12
  Phase 2B note above referencing the Scanner overlay) where the Scanner's
  live scan and backtest both delegated to Weekly Strong's two-condition
  (daily + weekly) evaluator.
- 2026-09-13 — Live Scanner (`calculateNear250WeekHighScan`) and Scanner
  Backtest (`computeSymbolBreakoutBacktest`) consume the exact same
  qualification series, produced by one Scanner-owned rule
  (`evaluateScannerWeeklySeries`, `modules/scanner/rules/scanner-weekly-rule.ts`)
  and one Scanner-owned fetch step (`getScannerWeeklySeriesInput`,
  `modules/scanner/scanner.candles.ts`). `computeSymbolBreakoutBacktest`
  and its supporting types/functions moved out of
  `market-data.metrics.ts` into `modules/scanner/scanner.backtest.ts`,
  since they were already Scanner-exclusive (no other caller existed).
  `deriveScannerLookbackBars` (Weekly Strong's daily-bar-ratio helper,
  used only by the old coupling) was deleted as dead code.
- 2026-09-13 — Scanner Backtest's history-sufficiency floor is a new,
  Scanner-owned constant (`MIN_SCANNER_WEEKLY_BARS = 20`), numerically
  equal to the Weekly Strong weekly-bar floor it previously inherited
  transitively through the shared fetch function, so this is not a
  silent behavior change - only a decoupling of ownership. Scanner
  Backtest still does not apply the live scan's 250->150->50 lookback
  fallback (`getEffectiveScannerLookbackWeeks`); that asymmetry already
  existed before this phase and was preserved as-is, not introduced.
- 2026-09-13 — Superseded by the entry below: the original Phase 3A
  completeness guards (`isLatestScannerWeekFresh` +
  `trimToTrailingContinuousWeeklySeries`) only detected fully-missing
  completed weeks, not partial ones. A live DB audit found a real partial
  week (TCS), so the guards were extended the same day (still within
  Phase 3A) to also classify and reject partial weeks.
- 2026-09-13 — `classifyScannerWeeklySeries`
  (`scanner/rules/scanner-weekly-series-safety.ts`) is the single
  Scanner-owned validation pass, replacing the two functions above, used
  by `getScannerWeeklySeriesInput` for both live Scanner and Scanner
  Backtest. Per completed week it checks the underlying daily-candle
  session count (not just whether a weekly candle exists at all):
  - 0 sessions → the week is fully missing (already caught structurally by
    a >7-day gap between consecutive weekly candles' week-endings).
  - 1-2 sessions → "partial" - invalid. A completed week is expected to
    have up to 5 daily sessions; since this codebase does not model
    exchange holidays (see `trading-calendar.ts`), a tolerance floor of
    `MIN_TRADING_SESSIONS_PER_COMPLETED_WEEK = 3` is used so a
    legitimate 1-2-holiday week is never misclassified as a data gap.
    Any completed week below that floor is a real gap (confirmed on TCS's
    real data: a week with only its Monday session, 1 of 5, immediately
    before the latest completed week).
  - The latest completed week itself is additionally checked: if it is
    either missing entirely or partial, the live scan is "stale" (no
    current match), not merely "the window is shorter."
  - The usable series is trimmed to the trailing run of consecutive valid
    (non-partial, non-missing) weeks, walking backward from the latest
    week and stopping at the first invalid week found; nothing before
    that point is used. No candle is fabricated and no missing value is
    forward-filled - a rejected week is excluded, never approximated.
  This directly closes the "partial week" detection gap the original
  Phase 3A completeness audit flagged as a known limitation.
- 2026-09-13 — Candle completeness issues found live in the current dev
  DB during the Phase 3A audit (SENSEX daily/weekly data materially stale;
  a TCS partial-week daily gap immediately before the latest completed
  week; ZOMATO/TATAMOTORS/LTIM marked `active` with no sync in months) are
  real and were not repaired. Root-cause investigation (provider sync,
  candle bootstrap, incremental refresh, self-heal/backfill, or checkpoint
  logic) and any fix are deferred to the candle-flow phase.
- 2026-09-13 — Superseded by the Phase 3B entries below: Scanner's `1D`
  fetch was bounded in Phase 3B. Moving Scanner onto a direct, bounded
  `timeframe = '1W'` Drizzle read (skipping `1D` derivation entirely)
  remains deferred to a future Phase 3C, specifically because stored `1W`
  coverage/freshness has not yet been proven safe as a source: a Phase 3A
  comparison (RELIANCE, TCS, SENSEX) found stored 1W and derived-from-daily
  weekly candles agree on nearly every overlapping timestamp, with 1 close
  mismatch each for RELIANCE and TCS and 0 for SENSEX - not repaired, only
  reported.
- 2026-09-12 — Phase 2C: the last normal application candle
  read/existence query still keyed on `exchange + symbol` —
  `searchChartEligibleBseStocks`'s (`market-data.stocks.ts`) per-instrument
  "has a daily candle" EXISTS subquery — now joins on
  `candles.instrument_id = instruments.id`. No normal application candle
  read or existence check in `backend/src` uses `candles.exchange`/
  `candles.symbol` as identity any longer. The two remaining occurrences of
  those columns (`market-data.candles.ts`'s `readMetricCandles` output
  projection/display ordering, and
  `scripts/reconcile-bse-candle-bootstrap-checkpoints.ts`'s operational
  bootstrap-checkpoint tooling) are metadata/deferred-tooling, not identity,
  and remain unchanged.
- 2026-09-13 — Phase 3B: how much historical Scanner yellow-band coverage
  to preserve when bounding the `1D` read was a genuine product trade-off
  (bounding necessarily limits how far back highlights can extend for a
  long-history symbol), put to the product owner directly rather than
  decided unilaterally. Decision: preserve full available per-symbol
  history, no reduction - `readScannerDailyCloses` has no artificial
  calendar lower bound; it reads exactly what is stored for that
  instrument. This means Phase 3B's row-count savings apply to
  shorter-history symbols; RELIANCE/TCS/SENSEX (full history already
  fits within the old 30-year fetch) see no row-count change, only fewer
  columns selected per row and a leaner, single-instrument query shape.
- 2026-09-13 — `readScannerDailyCloses` (`market-data.candles.ts`) is a
  new, Scanner-only, single-instrument `1D` read selecting only `time`
  and `close` (Scanner's weekly derivation and completeness classifier
  need nothing else). It replaces Scanner's prior use of the generic
  `readDailyAndWeeklyMetricCandles`/`readMetricCandles` path, which
  selected the full OHLCV column set, batched for multi-symbol callers
  (irrelevant for Scanner's always-single-symbol fetch), and - discovered
  as a side effect of this phase, not something it set out to find -
  could trigger a live provider seed-backfill call
  (`safeProviderAction`/`backfillDailyCandles`) when a requested symbol
  had zero synced daily candles. Scanner's fetch path no longer imports
  anything from `market-data.candle-sync.ts` and can no longer trigger a
  provider call, closing that latent gap against RULES.md rule 16
  ("provider fetching must not be triggered merely because a user opens a
  chart/page").
- 2026-09-13 — Weekly Scanner candles are derived via a new, small,
  Scanner-owned `deriveScannerWeeklyCloses`
  (`scanner/scanner.candles.ts`), which reuses the existing
  `aggregateWeeklyCandles` grouping/week-boundary algorithm
  (`candle-aggregation.ts`) by feeding it close-only daily rows with
  placeholder open/high/low (= close) and volume (= 0), then discarding
  everything but `time`/`close` from its output. This avoids duplicating
  ISO-week grouping logic (critical for staying consistent with
  `getWeekEndingFriday`/the completeness classifier, which rely on the
  exact same week boundaries) while still only selecting `time`/`close`
  from the database itself.
- 2026-09-13 — The existing `candles_instrument_id_timeframe_time_unique`
  index/constraint already fully supports `readScannerDailyCloses`'s
  `WHERE instrument_id = ? AND timeframe = '1D' ORDER BY time` query (same
  index already verified sufficient in Phase 2C/2A). No new index or
  migration was added or is needed for Phase 3B.
- 2026-09-13 — Phase 3B.1: a confirmed regression (BSE/TCS, BSE/LALPATHLAB)
  found the Phase 3A/3B completeness classifier kept only the LAST
  continuous valid weekly segment. When a missing/partial week occurred
  close to "now" (a real, unrepaired upstream data issue), the ENTIRE
  older, otherwise-valid history was discarded along with it, silently
  erasing historical yellow Scanner bands. Missing/partial completed
  weeks are now treated as hard continuity boundaries that PARTITION the
  weekly series into independent valid segments, rather than a single
  point past which everything before is dropped. The invalid week itself
  belongs to no segment (never fabricated, never forward-filled).
- 2026-09-13 — `classifyScannerWeeklySeries` now returns `{segments,
  latestSegment, isLatestWeekFresh}` instead of a single trailing
  `validWeeklyRows` array. `segments` is every continuous run of valid
  weeks found in the series (oldest first); `latestSegment` is the last
  entry in `segments` (empty if the series ends in an invalid week);
  `isLatestWeekFresh` is computed from `latestSegment`'s own last week
  against the exchange's actual latest completed week, not from the raw
  series' last row - so a stale/partial trailing week correctly leaves
  `latestSegment` pointing at whatever valid segment precedes it (or
  empty), without needing a second scan.
- 2026-09-13 — Historical Scanner qualification (highlightTimes) evaluates
  EVERY segment independently at the exact requested lookback tier
  (50/150/250 - no smaller-tier fallback for historical bands, unlike the
  live verdict). `evaluateScannerWeeklySeries`
  (`scanner-weekly-rule.ts`) now forces `passes = false` for any index
  before a full `lookbackWeeks` window exists (`index < lookbackWeeks -
  1`), closing a latent inconsistency: previously the first `N-1` bars of
  any series (segmented or not) could produce a "pass" from a partial,
  smaller-than-N window, which was never a genuine N-week breakout. This
  guarantees no segment - however short - can ever emit a signal before
  it has accumulated the full required number of valid weeks, and,
  because each segment has its own independent array/index space, a
  rolling window can never span a gap. This does not change the CURRENT/
  live verdict's own behavior: the live path already only evaluates
  `latestSegment` at an effective tier chosen to be `<= latestSegment.length`
  (`getEffectiveScannerLookbackWeeks`), so its own last index always
  already had a full window.
- 2026-09-13 — Current/latest Scanner qualification and historical
  Scanner qualification are independent outputs from the same
  `calculateNear250WeekHighScan` call. `latestSegment`/`isLatestWeekFresh`
  govern only `matched` (the current verdict, `undefined` when the latest
  segment is stale or shorter than any lookback tier); historical
  `highlightTimes` are computed from every segment and are never
  suppressed by the current verdict being unavailable. The API now
  returns a result whenever EITHER historical highlightTimes exist OR a
  current verdict exists - not only when both do, and not `[]` solely
  because `isLatestWeekFresh = false`. `matched` became optional
  (`boolean | undefined`) on `Near250WeekHighScanMatch` and
  `metrics.lookbackWeeks` became `number | null`; the client-facing wire
  shape is unaffected (`toClientScanMetrics` already omitted
  `latestMatched` for any non-boolean value).
- 2026-09-13 — Scanner Backtest (`computeSymbolBreakoutBacktest`) is
  segment-aware: trades are built independently per segment
  (`buildBreakoutTradesForSegment`) and combined afterward, so a trade's
  entry and exit can never straddle a gap. `MIN_SCANNER_WEEKLY_BARS`
  (the old blanket 20-week floor on the single trailing segment) was
  removed as redundant - a segment too short for any lookback tier
  naturally contributes zero historical signals (full-window requirement)
  and zero current verdict (effective-tier fallback already requires
  `latestSegment.length >= 50`), without needing a separate constant.
- 2026-09-13 — `MIN_TRADING_SESSIONS_PER_COMPLETED_WEEK = 3` is unchanged
  by Phase 3B.1 and remains a temporary heuristic, since this codebase
  still does not model exchange holidays (see the Phase 3A/3B.1 entries
  above). Phase 3B.1 changed how the series is partitioned around that
  threshold, not the threshold itself.
- 2026-09-13 — Superseded by the entry below: a confirmed bug (BSE/KOTAKBANK,
  `2026-08-31` missing from stored `1D` data) traced weekly candle
  mislabeling to the shared `aggregateWeeklyCandles`
  (`candle-aggregation.ts`), which set `time` to whichever daily row
  happened to be first available in that ISO week, not the week's actual
  start. A first fix normalized this only inside Scanner's own
  `deriveScannerWeeklyCloses`, deliberately scoped away from the shared
  function and its other callers (the price chart's own weekly rendering,
  provider backfill's stored 1W/1M writes, Relative Strength/Weekly
  Strong's derived weekly series) to keep that change small and
  low-risk while the fuller audit was pending.
- 2026-09-13 — Weekly candle `time` is now canonical - the ISO week's
  Monday (`getIsoWeekRange(time).start`) - at the single shared source,
  `aggregateWeeklyCandles` (`candle-aggregation.ts`), not per-caller. All
  callers were audited and confirmed semantically safe for this change:
  chart 1W rendering (`market-data.service.ts`, both the main
  `getChartCandles` path and the runtime-fetch fallback), provider
  backfill's stored 1W/1M write path (`market-data.candle-sync.ts`),
  Relative Strength/Weekly Strong's derived weekly series
  (`deriveWeeklyMetricCandlesFromDaily`, `market-data.candles.ts`), and
  Scanner. Weekly Strong's and Scanner's completeness/week-completion
  logic (`isCompletedTradingWeek`, `getWeekEndingFriday`,
  `classifyScannerWeeklySeries`) were already invariant to which day
  within a week is used as input - both the old first-available-day value
  and the new canonical Monday fall in the same ISO week, so none of that
  decision logic changes. The persisted `weeklyStrongBacktestRuns.weekEnding`
  column is likewise unaffected: it is always written from
  `getWeekEndingFriday(point.time)`, a value already independent of the
  raw candle `time`'s day-of-week (the column's own schema comment
  claiming it stores the "first trading day" value is stale/inaccurate
  pre-existing documentation, not touched here since it isn't a schema
  change). `aggregateMonthlyCandles` was deliberately left on the
  first-available-day convention - out of scope for this fix, no reported
  bug, and changing it wasn't requested.
- 2026-09-13 — Scanner's local weekly-timestamp normalization
  (`deriveScannerWeeklyCloses`'s post-processing step from the prior,
  Scanner-only-scoped fix) was removed as redundant now that the shared
  `aggregateWeeklyCandles` produces the canonical timestamp directly.
  There is one canonical weekly-timestamp rule, not two independently
  maintained ones.
- 2026-09-13 — A canonical weekly timestamp is an identity/labeling
  concern only, independent of completeness. `2026-08-31` is the correct
  bucket time for BSE/KOTAKBANK's `2026-09-01`+`2026-09-04` week even
  though that week has only 2 daily sessions and the (at-the-time-current)
  `MIN_TRADING_SESSIONS_PER_COMPLETED_WEEK = 3` heuristic still correctly
  classified it as partial/invalid for Scanner completeness purposes at
  that point. No daily candle was fabricated or forward-filled to produce
  the canonical timestamp; OHLCV values still come only from whichever
  real daily rows exist for that week. (Superseded by Phase 3B.2 below:
  a low session count no longer breaks Scanner continuity at all.)
- 2026-09-13 — Phase 3B.2: the `MIN_TRADING_SESSIONS_PER_COMPLETED_WEEK
  = 3` "partial week" rule was too aggressive for Scanner continuity.
  Confirmed live on BSE/KOTAKBANK and BSE/TCS: a single completed week
  with only 1-2 real daily sessions (a real, unrepaired upstream data
  gap - the `2026-08-31` daily candle is genuinely missing for both
  symbols) was treated as a hard continuity boundary, fragmenting each
  symbol's otherwise-continuous ~1,027-week history into a short recent
  segment plus an older segment excluded from the live rolling window,
  and for TCS additionally marking the latest segment stale - silencing
  both historical highlightTimes reconstruction quality and the live
  verdict, for a week that has real, if incomplete, price data.
- 2026-09-13 — New locked continuity rule: a completed weekly bucket
  with at least 1 actual daily candle remains in the Scanner rolling
  series and must not break continuity or be excluded from being the
  current/live week. Only a completed weekly bucket with zero daily
  candles (no weekly candle is ever derived for it - `aggregateWeeklyCandles`
  produces no entry) remains a hard continuity boundary: valid segments
  are still partitioned only at that point, and a rolling 50/150/250-week
  window still never crosses it. A partial week's weekly close is still
  exactly the close of its last actual daily candle - this decision
  changes only which weeks are allowed to participate in the rolling
  series, never how any individual week's close is derived, and never
  fabricates or forward-fills anything.
- 2026-09-13 — `classifyScannerWeeklySeries`
  (`scanner-weekly-series-safety.ts`) no longer takes a daily-candle
  input or computes a per-week session count. Partitioning is now purely
  a >7-day gap check between consecutive weekly candles' week-endings -
  which already is exactly what a zero-session week looks like
  structurally, since no weekly candle is ever produced for a week with
  no daily rows at all. `isLatestWeekFresh` is likewise now purely
  date-based (does the latest segment's last week match the exchange's
  actual latest completed week) - a latest week backed by only 1 real
  session is fresh and participates in the live verdict; only a latest
  week with zero daily candles (entirely absent from the weekly series)
  is stale.
- 2026-09-13 — The `MIN_TRADING_SESSIONS_PER_COMPLETED_WEEK = 3`
  constant and its session-counting helper were removed as dead code
  once nothing in the continuity path consumed the "partial" distinction
  they drew. Data-quality diagnostics (surfacing "this week only had N
  sessions" separately from the Scanner pass/fail decision) were
  explicitly not rebuilt this phase - out of scope, no current consumer,
  and the task treated the heuristic's continued existence as optional
  ("may remain for reporting/diagnostics"), not required. It can be
  reintroduced as a standalone concept, separate from continuity, if a
  real reporting need for it emerges later.
- 2026-09-13 — This phase does not change, and does not need to, the
  underlying candle-completeness reality: BSE/KOTAKBANK's and BSE/TCS's
  `2026-08-31` daily candle is still genuinely missing in the current dev
  DB, unrepaired. What changed is only that Scanner no longer treats a
  partial week's presence as disqualifying; the upstream data gap itself
  remains a deferred candle-sync/backfill concern, not addressed here
  (no provider call, no backfill, no repair was performed).
- 2026-09-13 — Re-verification pass (same "Phase 3B.2" scope, requested
  again with a more exhaustive 18-item test checklist): confirmed, via a
  repo-wide search, that no code change was actually needed -
  `scanner-weekly-series-safety.ts`, `scanner.candles.ts`,
  `near-250-week-high.ts`, and `scanner.backtest.ts` already fully
  implement the continuity rule from the entry above, and
  `MIN_TRADING_SESSIONS_PER_COMPLETED_WEEK` does not exist anywhere in
  `backend/src`. This pass only added the remaining test coverage
  (150-week and 250-week partial-crossing cases, a zero-session week
  actually blocking a rolling max, current-match/current-unavailable
  proven through the full `calculateNear250WeekHighScan` path rather than
  only `isLatestWeekFresh`, and the still-forming week staying excluded)
  and re-ran the live, read-only DB verification.
- 2026-09-13 — LALPATHLAB's `2026-08-31` week is a distinct case from
  KOTAKBANK/TCS's: it has real, non-fabricated daily data (close=1874.9)
  and is correctly kept in the weekly series, but it sits alone in its
  own 1-week segment because a *different*, genuinely fully-missing week
  elsewhere in its near-term history still separates it from the
  557-week main segment. A 1-week segment can never satisfy any lookback
  tier (50/150/250), so this week legitimately produces no signal at any
  tier - this is the missing-week hard-boundary rule working exactly as
  designed on real data, not a partial-week suppression regression.
- 2026-09-13 — Dashboard user-facing weekly date semantics are locked to
  the completed trading week's Friday/week-ending date, everywhere the
  dashboard displays a "weekly" concept. This reuses the existing
  `getWeekEndingFriday`/`resolveCompletedWeekEndingFromTradingDay`
  helpers (`backend/src/modules/market-data/trading-calendar.ts`,
  unchanged by this decision) - no new week-definition was introduced,
  and no formula/schema/backend code changed to make this true; the
  helpers already existed and were already correctly used by Harvest
  Results, Stocks In/Out, and Harvest Backtest.
- 2026-09-13 — Audited every dashboard weekly-date source before
  changing anything. Found the "mixed dates" symptom was a **display
  inconsistency, not a real underlying-data mismatch**:
  Index/Sector/Industry/Stock Harvest cards rendered their Relative
  Strength snapshot's raw `asOfDate` (a daily trading-day marker,
  `getLatestExpectedTradingDay`) directly, without ever converting it to
  a week-ending Friday, while every other dashboard section already
  applied that conversion. Since all of these dates trace back to the
  same underlying latest-trading-day state for the exchange, unifying
  the *display* onto one already-correct, already-existence-gated
  source (`getCollectionWeeklyStrongStocks`'s `weekEnding` field) closed
  the gap without altering what any card computes or shows numerically.
- 2026-09-13 — The dashboard's one canonical "Analysis week" is sourced
  from the currently-selected segment's own Weekly Strong snapshot
  `weekEnding` (already `null` until that snapshot genuinely exists -
  satisfies "never display an uncompleted/future week"), fetched once
  via the existing `useCollectionWeeklyStrongStocks` hook and reused
  (React Query dedupes by query key) everywhere the dashboard needs it -
  the global toolbar label, and Harvest Backtest's preferred default
  selection. No new backend endpoint was added; this was intentionally
  a frontend-only fix, per the explicit preference for reusing an
  existing authoritative source over introducing new backend surface.
  This ties the canonical week to the *currently selected segment*, not
  a database-wide value - accepted as the best available authoritative
  signal without backend changes; flagged as a known limitation, not
  silently glossed over.
- 2026-09-13 — Individual "As of ..." date labels were removed from the
  four Harvest cards (Index/Sector/Industry/Stock), and Harvest Results'
  redundant "Week ending ..." subtitle segment was removed, since the
  global "Analysis week" label now communicates this once. The
  `DashboardCardData.timestamp` field (and the now-unused
  `formatWeekEnding` helper) were deleted as dead code once nothing
  populated or consumed them, rather than left as unused surface -
  matching the pattern already established elsewhere in this codebase.
  "Last refreshed" (a client-side query-fetch timestamp, unrelated to
  any weekly analysis date) was deliberately left untouched.
- 2026-09-13 — Harvest Backtest's date selector and its list of
  historical week options were already Friday-based and already
  correctly derived via `getWeekEndingFriday` at read time (confirmed by
  audit, `weekly-strong-backtest.queries.ts`) - no change was needed
  there. Its *default* selection now prefers the canonical Analysis week
  when a backtest data point exists for that exact week, falling back to
  the latest available backtest week otherwise (generating a backtest
  run for a week that doesn't have one yet is explicitly out of scope
  for this fix - no full/partial backtest regeneration was triggered).
  Stocks In/Out were already correctly comparing the canonical current
  Friday against the previous completed Friday and needed no change.
- 2026-09-14 — Normal 1D candle sync is last-stored-date incremental, not
  full/fixed-history and not a bare "fetch the latest single day" call.
  Every routine refresh (scheduled job and manual admin refresh alike)
  also always re-fetches a bounded recent repair window
  (`RECENT_REPAIR_WINDOW_CALENDAR_DAYS = 35`), even for an already-fresh
  symbol, because a present latest candle does not prove the absence of
  recent middle gaps (`MAX(candle.time)` alone was proven insufficient by
  the LALPATHLAB diagnostic). `INCREMENTAL_OVERLAP_TRADING_DAYS = 5` is
  added on top of the stored latest date so a very-stale symbol's fetch
  still starts near its own last known date, not clamped to the 35-day
  window. Both constants are approximate/calendar-day, not
  trading-calendar-exact - acceptable because the provider's own returned
  dates are the authority for what actually gets written (see below), not
  these constants.
- 2026-09-14 — The provider's returned dates are the authority for what
  counts as "the recent trading history" for a sync range - no BSE holiday
  calendar is modeled or assumed. Every date the provider returns for the
  requested range is upserted as-is; a date the provider does not return is
  never fabricated or treated as an error.
- 2026-09-14 — Chart reads, Relative Strength/Weekly Strong reads, Scanner
  reads, and every other normal frontend-facing read are DB-only and must
  never trigger a provider call - this was already Engineering Rule #16 but
  `getChartCandles` (chart-open-triggered backfill/incremental-refresh/
  runtime-fetch) and `readDailyAndWeeklyMetricCandles` (a 20-symbol
  seed-backfill on an empty read) both violated it. Both were removed; the
  daily candle sync job now owns closing every gap a read used to paper
  over. The dead freshness-classifier helpers left behind by removing the
  chart-side trigger were deleted, not kept unused.
- 2026-09-14 — Initial bootstrap (an instrument with zero stored 1D
  history) stays a separate concern from routine incremental sync. Routine
  sync classifies a zero-history symbol as `bootstrap-required` and does
  not fetch for it - it does not fall back to a full multi-year fetch. The
  existing bootstrap tooling (`scripts/bootstrap-bse-candles.ts`,
  `backfillDailyCandles` with an explicit wide `from`) remains the owner of
  first-time history population.
- 2026-09-14 — Routine market-wide candle sync runs on a bounded schedule
  (BullMQ `dailyCandleSync` job, cron `45 15 * * 1-5` + a `0 17 * * 1-5`
  retry, `Asia/Kolkata`), not every 15/30 minutes. The existing 30-minute
  `instrumentSync` job and its `refreshAllLatestInstrumentPrices` call are
  unchanged - that cadence serves the live latest-price ticker
  (price alerts, `/stocks` listing), a different concern from canonical 1D
  candle-history completeness.
- 2026-09-14 — Chart reads stay strictly DB-only (unchanged from Phase 4A);
  on-demand freshness for a viewed symbol is a separate, explicit
  `POST /market-data/candles/ensure-fresh` call the frontend makes after
  the chart has already rendered from DB, never something GET candles
  triggers itself. This is the reactive complement to Phase 4A's proactive
  scheduled sync - the schedule stays the main safety net; ensure-fresh
  only closes the gap for symbols someone is actually looking at, before
  the next 15:45/17:00 run.
- 2026-09-14 — On-demand repair reuses `refreshDailyCandles` verbatim - no
  second range-planning/repair algorithm exists. The 5-day overlap and
  35-day repair window are unchanged and apply identically whether the
  caller is the scheduled job, an admin manual refresh, or a chart
  self-heal request.
- 2026-09-14 — One repair per `instrument + latest-expected-trading-date`
  is enforced via a deterministic BullMQ job id on the existing
  `market-data` queue, not a new Redis client or a DB table. A completed
  job's result is reused on later calls for the same key; a `failed`
  result is never cached as settled, so a later chart open can retry. When
  the queue is unreachable, an in-memory single-flight/settled-result
  cache is the single-instance fallback, with the same "failed is never
  cached" rule - explicitly logged as degraded, not a silent substitute
  for real cross-instance dedupe.
- 2026-09-14 — 1W/1M chart timeframes are derived from stored 1D at read
  time (`getChartCandles`), not persisted independently in the normal
  path - so on-demand ensure-fresh only ever repairs canonical 1D, and
  invalidating the chart candle query for a symbol/exchange is sufficient
  for every timeframe to pick up the repair. No new weekly/monthly
  persistence or reaggregation path was introduced.
- 2026-09-14 — Chart self-heal's BullMQ dedupe job id uses `-` as its
  separator, never `:` - BullMQ uses `:` internally to delimit Redis key
  segments for job ids, so a custom id containing `:` is unsafe. Format:
  `chart-ensure-fresh-{exchange}-{symbol}-{latestExpectedDate}`.
- 2026-09-14 — Ensure-fresh waits on a newly enqueued or already
  active/waiting job for up to 12 seconds (`Job.waitUntilFinished` via a
  `QueueEvents` instance on the existing `market-data` queue) before
  falling back to `in-progress`. This is a bounded wait, not a polling
  loop - the goal is that a repair finishing within a few seconds returns
  its real terminal status in the same HTTP response, so the frontend can
  invalidate/refetch immediately instead of always waiting for one
  delayed retry.
- 2026-09-14 — Superseded the above's "return quickly, invalidate
  separately" preference: the chart's freshness check now runs inside the
  same query that fetches candles (`useCandles({ ensureFresh: true })`),
  not as a parallel mutation that has to successfully invalidate the
  candle query afterward. Decision, per explicit product direction: a
  slower first paint that reliably ends in correct data is preferred over
  a fast paint whose correction depends on a second request lifecycle
  handing off cleanly. The bounded wait raised from 12s to 90s
  server-side (`ensureFreshDailyCandles`) is what makes this viable - the
  same-query wait is almost always satisfied by the real repair
  completing, not by hitting the bound. `GET /charts/:symbol/candles`
  itself is unchanged and still never calls the provider - the wait lives
  entirely in the frontend query's own `queryFn`, calling the existing
  `POST /candles/ensure-fresh` endpoint before reading candles, not by
  adding a provider call to the backend read route.
- 2026-09-14 — `useCandles`'s cross-symbol `placeholderData` carryover is
  disabled specifically when `ensureFresh: true` - showing a previous
  symbol's candles mislabeled as the newly-selected one is misleading once
  a query can legitimately take real time to resolve; a genuine loading
  state is preferred there. Other `useCandles` callers (quick preview)
  keep the smooth placeholder behavior since they never wait on a repair.
- 2026-09-14 — Investigated the reported Dashboard Stocks In/Out
  direction-reversal bug against real data (raw-SQL cross-check, not just
  code reading) and found the set-difference direction and snapshot-date
  direction were already correct - not reversed. Recorded here rather
  than silently closing the report, per RULES.md #4: a "no bug found"
  result from real-data verification is itself a decision worth keeping,
  not something to omit because it wasn't the expected finding.
- 2026-09-14 — `weekly-strong-backtest.queries.ts`'s membership-change
  identity is `instrumentId`, not `exchange:symbol` text - the canonical
  id was already present and NOT NULL on `weeklyStrongBacktestMembers`
  but unused for this comparison. Text identity happened to be correct
  for every case tested against real data, but cannot distinguish a
  symbol rename (same instrument, new symbol - should be unchanged) from
  two unrelated instruments that happen to share a symbol string (should
  be one exit + one entry) the way `instrumentId` can.
- 2026-09-14 — Superseded the prior "a week only becomes complete once
  evaluation moves into the following ISO week" design choice
  (`isCompletedTradingWeek`, `trading-calendar.ts`). A week is now
  complete as soon as its own Friday's trading day has closed, not one
  week later. Explicitly confirmed with the user this session, aware of
  the tradeoff: the prior rule was a deliberate guard against a delayed
  weekend EOD correction still touching Friday's candle; the user
  prioritized the analysis week/backtest matching "last week" over that
  guard. Applied to the shared rule (`isCompletedTradingWeek`,
  `resolveCompletedWeekEndingFromTradingDay`), not just the dashboard
  label, since Scanner's weekly candle series and the Weekly Strong
  evaluator both depend on the same function.
- 2026-09-14 — Auth email delivery (`auth-email.service.ts`) switched from
  a generic outbound webhook (`AUTH_OTP_EMAIL_WEBHOOK_URL`/`_TOKEN`) to
  direct SMTP via `nodemailer`, per explicit request - the user has a
  mailbox app password to send from directly, no middleman webhook
  service exists. New env vars: `SMTP_HOST` (default `smtp.gmail.com`),
  `SMTP_PORT` (default 587), `SMTP_SECURE` (default false), `SMTP_USER`,
  `SMTP_PASSWORD`, `SMTP_FROM` (defaults to `SMTP_USER`). Same
  unconfigured-in-dev-is-a-no-op / required-in-production behavior as the
  webhook it replaced. One shared `sendEmail` helper now backs both
  `sendRegistrationOtpEmail` and `sendPasswordResetEmail`.
- 2026-09-15 — Phase 4C: the daily candle sync schedule is three fires a
  day, not two - morning `40 9 * * 1-5` IST (repair before the session
  continues), post-market `50 15 * * 1-5` IST (was `45 15`, moved 5
  minutes later per explicit request), retry `0 17 * * 1-5` IST
  (unchanged). All three call the exact same
  `syncDailyCandlesForActiveInstruments`/`refreshDailyCandles`
  (Phase 4A) - the 5-day incremental overlap and 35-day repair window are
  unchanged, and no second sync algorithm was introduced.
- 2026-09-15 — Durable job-run history for scheduled market-data jobs did
  not exist before this phase: `sync_jobs` only ever gets a row when an
  admin-triggered action explicitly passes a `syncJobId` in the job data,
  which the repeatable cron jobs never did. A new, small
  `background_job_runs` table was added (one row per run, not per symbol)
  rather than extending `sync_jobs` with candle-sync-specific count
  columns that would be meaningless for `sync_jobs`' other job types
  (weekly-strong backfill, collection prepare, etc).
- 2026-09-15 — `background_job_runs.status` is `running` ->
  `completed`/`partial`/`failed`. `partial` means the run itself executed
  and produced isolated per-symbol failures (including the edge case of
  every symbol failing - the run still executed); `failed` is reserved for
  the wrapper's own catch block, when the job function throws before
  producing any summary at all (e.g. a DB connection loss).
- 2026-09-15 — Chart ensure-fresh (self-heal and manual refresh) is
  tracked in the same `background_job_runs` table, but only when an
  actual provider refresh executed or failed. `already-current`,
  `bootstrap-required`, and `provider-empty` never call the provider (or,
  for bootstrap-required, deliberately skip the call) and are never
  persisted - a normal chart open must not spam this table. One shared
  gate, `recordChartEnsureFreshResultIfNeeded`, is used by both the BullMQ
  worker job path and the in-memory single-instance fallback path (the
  fallback this sandbox's unreachable-but-configured Redis actually
  exercises), so tracking doesn't silently disappear depending on which
  path is active.
- 2026-09-15 — Worker heartbeat is Redis-only, reusing the existing
  `market-data` BullMQ queue's own Redis connection
  (`Queue.client`/`Worker.client`, both already-existing BullMQ
  properties) - no new Redis client dependency, no DB heartbeat row. The
  worker writes `{startedAt, lastHeartbeat}` every 20s with a 90s Redis
  TTL. Online/offline is decided by an explicit timestamp comparison in
  the reader (`lastHeartbeat` within 90s), not solely by whether the
  Redis key still exists - this makes staleness a genuine, testable rule
  rather than an implicit side effect of Redis key expiry timing.
- 2026-09-15 — Data health (`getMarketDataHealth`) is DB-only, computed
  from `instruments.latestPriceAt` (already maintained by every candle
  write path via `refreshLatestInstrumentStats`/`getLatestStockStats` as
  "this instrument's latest stored 1D candle date," confirmed by reading
  both functions) compared against `getLatestExpectedTradingDay`. No join
  against `candles`, no provider call. This intentionally only detects
  "is the latest candle current," not every historical middle gap -
  Phase 4A's scheduled repair already owns closing recent gaps.
- 2026-09-15 — The previously-stub `/admin/jobs` route (a bare redirect to
  `/admin/users`, not linked from the sidebar at all) is reused as the new
  "Market Data / Workers" admin page rather than creating a new route -
  it was already reserved for exactly this purpose and unused.
- 2026-09-15 — Manual chart Refresh reuses the existing
  `POST /market-data/candles/ensure-fresh` endpoint and its existing
  BullMQ-job-id dedupe (Phase 4B) verbatim - no new backend endpoint for
  the button, no market-wide manual trigger added (out of this phase's
  explicit scope: single-symbol only).
- 2026-09-15 — Found and fixed a real regression in the chart-open
  self-heal path: `useCandles`'s `queryFn` called `ensureFreshCandles(...)`
  without awaiting it, then immediately fetched and returned candles from
  `getCandles(...)`, discarding the ensure-fresh result entirely. The
  ensure-fresh request and the backend repair both genuinely executed;
  nothing in the frontend ever consumed the result or invalidated the
  candle query, so a chart open never rendered the repaired data without
  a separate, unrelated page reload. This directly explains
  "only updates after a manual refresh" reports, and contradicts what
  `docs/PROGRESS.md`'s own prior Phase 4B entry described as already
  fixed. Fixed by awaiting `ensureFreshCandles(...)` before
  `getCandles(...)`, restoring the single-request-lifecycle design that
  was originally intended.
- 2026-09-15 — Found and fixed a second real bug during this phase's own
  live verification: `getMarketDataQueueRedisClient` awaited BullMQ's
  `queue.client` with no bound. Against a Redis that is configured but
  unreachable (this sandbox's actual state, and a plausible production
  degraded state), that await hangs indefinitely rather than resolving to
  "queue unavailable." Bounded with the same 3s timeout-race pattern this
  file already uses for `addJobWithTimeout` - the failure path this was
  missing already existed and already degrades to an `offline` worker
  status; the fix only makes sure that path is actually reached instead
  of hanging first.
- 2026-09-16 — Phase 4D: WebSocket infrastructure is not duplicated - the
  existing raw `ws` gateway (`market-stream` module, `/ws/market`) is
  reused for admin job/worker events and chart symbol-refresh
  notifications alike, not a second Socket.IO/WS server. `ioredis` is
  added as an explicit dependency (it already existed nested under
  `bullmq` but was not directly importable) specifically because Redis
  pub/sub requires a dedicated subscriber connection that cannot also run
  BullMQ's own queue commands.
- 2026-09-16 — The worker process and the API process communicate job/
  worker-status events via Redis pub/sub (`modules/jobs/realtime-events.ts`),
  never a process-local EventEmitter alone - a worker-only signal would
  never reach the API process's WS clients otherwise. The API process's
  own in-memory ensure-fresh fallback (used when Redis is unreachable for
  BullMQ) also publishes through this same path when it can, so there is
  one event-emission code path regardless of which process performed the
  repair.
- 2026-09-16 — The market-stream gateway's WebSocket auth previously
  verified only the USER-portal token audience - an admin-portal access
  token could never authenticate on `/ws/market` at all. This phase adds
  a second verification attempt against the ADMIN-portal audience before
  falling back to the USER-portal one (unchanged for existing chart
  clients), and records which portal a connection authenticated under -
  required so `admin.subscribe` can check portal AND role together
  (mirroring `requireAdminAuth`+`requireAdmin`'s existing combined check
  used elsewhere), never role alone.
- 2026-09-16 — Admin operational events (job lifecycle, worker status) are
  fanned out only to sockets that explicitly sent `admin.subscribe` and
  passed the portal+role check - never broadcast to all connected
  clients. Chart symbol-refresh events reuse the existing exchange+symbol
  live-tick subscription matching already in the hub - no new per-symbol
  room concept was introduced for that case, since the existing
  mechanism already provides exactly the required scoping.
- 2026-09-16 — Job-progress events are WebSocket-only and never persisted
  - only `job-started` (on the existing `running` DB insert) and the
  terminal `job-completed`/`job-failed` events are tied to a durable
  `background_job_runs` write, and the terminal event is always published
  strictly after that write commits, never before.
- 2026-09-16 — `symbol-refreshed` is published only for `updated`/
  `repaired` chart-refresh outcomes, reusing the exact gate Phase 4C
  already built (`recordChartEnsureFreshResultIfNeeded`) for deciding
  when a chart refresh is durable-history-worthy - an `already-current`
  cache hit produces neither a DB row nor a WebSocket event.
- 2026-09-16 — Phase 4D.1 process-boundary audit: the live market-stream
  WebSocket provider, provisional current-day candle memory, chart WS
  gateway, and current-day candle HTTP endpoint all run in the API
  process (`server.ts`). The separate worker process handles background
  jobs only. In-memory provisional candles are valid for the current
  single API/WS deployment; Redis is only required if API/WS is later
  split across multiple API processes or replicas.
- 2026-09-16 — Found and fixed a real bug in `publishRealtimeEvent`:
  resolving the Redis publisher client happened outside its own
  try/catch, so a synchronous connection failure there rejected the
  function's promise; every call site uses it fire-and-forget
  (`void publishRealtimeEvent(...)`), making this a genuine unhandled-
  rejection risk, reproduced live in this session via the existing
  `market-data.chart-ensure-fresh.test.ts` suite. Fixed by wrapping the
  whole function body in try/catch, so a publish failure can never
  propagate to (or block) the caller, matching the explicit requirement
  that WebSocket publishing must never make a successful candle refresh
  fail.
- 2026-09-16 — Phase 4D.2: root-caused why the live-stream current-day
  capability had been observed returning "Function not enabled" against
  our GlobalDataFeeds account (`market-stream.capabilities.ts`'s
  cooldown tracking exists because of this). Confirmed against provider
  documentation that our account holds GDF's 15-minute-**delayed**
  entitlement, and that entitlement's WebSocket message types are
  `GetSnapshot`/`SubscribeSnapshot`/`GetExchangeSnapshot` - distinct
  message types from the full-realtime `GetLastQuote`/`SubscribeRealtime`
  the code had been using, which our account is not entitled to. Fixed
  by switching `GlobalDatafeedsMarketStreamProvider` from
  `SubscribeRealtime` to `SubscribeSnapshot` (Periodicity MINUTE, Period
  1) and adding a new `GetSnapshot`-based `fetchDelayedSnapshot` adapter
  method (new `current_price_snapshot` provider capability) as the
  primary current-day-price mechanism, with the passive stream state as
  fallback. `GetHistory` (canonical daily candle sync) already used the
  correct message type - GDF's own docs confirm delayed variants reuse
  the identical `GetHistory` request/response shape, delay applied
  server-side, so that path was left untouched.
- 2026-09-16 — Live-verified during real BSE market hours (10:17 IST):
  `GetSnapshot` for TCS/RELIANCE returned real OHLC with an observed
  `LastTradeTime` delay of ~19 minutes versus request time, consistent
  with the account's 15-minute-delayed entitlement (some extra latency
  is expected from the 1-minute snapshot periodicity plus request/queue
  time). `GetExchangeSnapshot` for BSE also succeeded, returning 1,627
  instruments (including TCS/RELIANCE, correctly identifier-matched) in
  a single request - materially fewer round trips than batching
  `GetSnapshot` 25-at-a-time for a full-exchange refresh. Per the task's
  explicit instruction this is a diagnostic finding only, not adopted -
  whole-exchange refresh still uses the existing per-symbol
  `GetHistory`/`GetSnapshot` paths. Recommended as a candidate for a
  future phase, pending payload-size/rate-limit testing at full
  ~5,800-instrument BSE universe scale (this diagnostic used the live
  default response, not the full universe).
- 2026-09-17 — Stock search (`symbol`/`name` `ILIKE '%q%'`) was slow because
  a leading-wildcard ILIKE cannot use a plain B-tree index - confirmed via
  `EXPLAIN` that it was a sequential scan. Added the `pg_trgm` extension
  plus GIN trigram indexes on `instruments.symbol`/`instruments.name`
  (`drizzle/0024_green_paladin.sql`) - `EXPLAIN` after the migration shows
  a `Bitmap Index Scan` on the new index for the same query. A results
  cache was considered instead (the user's original suggestion) but
  rejected as the primary fix: it only helps repeated identical queries,
  while the index fixes every query including first-time ones, with no
  staleness risk. `searchChartEligibleBseStocks` (the navbar Ctrl+K
  search) additionally got the same 20s in-memory `getOrSetCache` wrapper
  `listStocks` already used - it previously had no caching layer at all
  and also ran a correlated `EXISTS` subquery per matching row.
- 2026-09-17 — Security audit found two real gaps in the IP-keyed rate
  limiter (`shared/middleware/rate-limit.ts`, applied to auth/login/
  registration/password-reset routes): (1) `app.ts` never called
  `app.set("trust proxy", ...)`, so `req.ip` would resolve to the
  reverse proxy's address (not the real client's) the moment this runs
  behind any load balancer/CDN in production - collapsing every user
  into one shared rate-limit bucket. Fixed by adding a `TRUST_PROXY_HOPS`
  env var (default `0` - trust nothing, matching today's actual behavior
  unchanged for local/undeployed setups) that must be set to the real
  hop count in production; deliberately not guessed or hardcoded since
  setting it wrong in the other direction (trusting a hop that doesn't
  exist) lets clients spoof their own IP via X-Forwarded-For, which is
  worse than the gap it fixes. (2) The limiter's in-memory bucket Map
  had no eviction - every unique IP+email key seen stayed in memory for
  the life of the process, unbounded. Fixed with the same periodic sweep
  `shared/cache.ts` already uses (5-minute interval, unref'd). Also
  confirmed: no application-level rate limiting exists outside auth
  routes, and classic network-flood DDoS protection is out of scope for
  application code (belongs at a CDN/WAF layer, which this repo has no
  visibility into) - not something addressed by this fix.

- 2026-09-19 — Admin can delete a finished job from the Market Data job list:
  `DELETE /api/admin/jobs/:id?source=run|provider` (`run` = `background_job_runs`,
  `provider` = `sync_jobs`). Rows that are pending, queued or running are refused
  with 409, both on a pre-check and inside the DELETE's own WHERE, so a job that
  becomes active mid-request is never removed. Each delete writes a `job.deleted`
  audit log. Deleting a ledger row for the current trading day lets the next
  `ensureExpectedMarketDataJobs` pass recreate it; past-day rows stay deleted.

- 2026-09-19 — One GlobalDataFeeds session per key: GDF refuses a second session
  ("Access Denied. Key already in use by other session"), and the API and the worker each
  opened their own socket, so whichever connected second timed out on every request. A
  session broker (`global-datafeeds.session-broker.ts`) now makes exactly one process the
  owner. The worker competes for a Redis lease (`gdf:session:owner`, 15 s TTL, renewed
  every 5 s) and the winner opens the only socket. The API is a pure proxy: its
  `globalDatafeedsClient.request()/send()` are executed by the owner over Redis pub/sub
  (`gdf:rpc:request`, per-instance `gdf:rpc:response:<id>`), and the owner broadcasts quotes
  and connection status (`gdf:quotes`, `gdf:status`) so the live stream keeps working. A
  proxy fails immediately when no owner lease exists instead of waiting for a timeout. A
  candidate that loses the lease acts as a proxy and takes over when the lease expires; a
  restarted worker waits up to one TTL for a crashed predecessor's lease. Scripts and tests
  that never start the broker keep the old direct socket (stop the worker before running
  them). `GLOBAL_DATAFEEDS_SESSION_MODE=direct` restores per-process sockets.

- 2026-09-20 — The market-data worker ran strictly one job at a time (BullMQ's default), so a long
  scheduled instrument sync (45-80 minutes for BSE) blocked a manual Refresh candles catch-up
  behind it. `WORKER_CONCURRENCY` (default 1, max 4) sets `concurrency` on the BullMQ Worker.
  Production uses 2. This is safe with the single GDF session because every GDF request carries
  its own tag and replies are matched by it; the database has lock headroom
  (`max_locks_per_transaction` raised to 2560) and each process' pool is capped by
  `DB_POOL_MAX`. Duplicate work is still prevented by deterministic job ids (for example
  `market-data-catch-up:<exchange>:<date>`).

- 2026-09-20 — GlobalDataFeeds enforces an hourly call quota and answers refused calls with an
  untagged `RequestError` ("Calls per hour are limited."). Untagged, the reply could never be
  matched to its request, so every affected `GetHistory` waited out its 30 s timeout and showed
  up as a generic timeout; with 8 symbols in flight a catch-up kept burning calls. The client
  now (1) recognises the reply and blocks all calls for a cooldown (5 min, doubling to 30 min
  while it recurs, reset by any success), (2) rejects the waiting requests at once with
  `ProviderRateLimitedError` (carried over the Redis broker with its cooldown), and (3) can
  cap calls itself with `GLOBAL_DATAFEEDS_MAX_CALLS_PER_HOUR`. The daily candle sync stops
  starting new symbols on that error, keeps the candles already saved and fails the run with
  "retry in N minute(s)" instead of marking every remaining symbol failed.
