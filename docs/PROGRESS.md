# Backend Cleanup Progress

Single source of truth for backend cleanup progress. Update this file
whenever a module's audit/cleanup/test/verification state changes.

Current focus: Analysis Week — Remove Extra One-Week Completion Lag
Status: Done

Follow-up fix: the real-data verification for the Analysis Week fix ran
`syncWeeklyStrongBacktestIncremental("BSE")`, which generated a single
`historical_membership` run for BSE100 (this collection has an
admin-imported dated membership version on file). `resolveMembershipMode`
(`weekly-strong-backtest.queries.ts`) switches a collection to historical
mode the moment ANY historical run exists for it, regardless of how many
current_membership runs already exist - so that one stray row silently cut
the Harvest Backtest chart and Stocks In/Out card down from 246 weeks of
`current_membership` history to that single historical week (visually: one
full-width bar, one x-axis label, `previousWeekEnding: null`). Deleted the
stray run (cascade-deleted its member rows too); `current_membership`
mode and the full 246-week history are restored, confirmed via
`getWeeklyStrongBacktestMembershipChanges` (previousWeekEnding populated
again, IN/OUT back to non-degenerate counts). **Lesson recorded**: never
run `syncWeeklyStrongBacktestIncremental`/any backtest-generating action
against a real collection as a "verification step" without checking
`resolveMembershipMode`'s all-or-nothing switch first - for a collection
with a dated membership version on file, generating so much as one
current-week run can silently reduce its entire displayed history to that
one week.

Completed:
- Follow-up to the Stocks In/Out investigation: the dashboard's "Analysis
  week" was showing 04 Sep 2026 when the most recently completed trading
  week (Mon 07 - Fri 11 Sep) had already fully closed - one calendar week
  further behind than expected. Root cause: `isCompletedTradingWeek`
  (`trading-calendar.ts`) required evaluation to move into the week AFTER
  a week's own Friday before treating that week as complete, instead of
  treating it complete as soon as Friday itself closes. This was a
  documented, deliberate prior design choice (guarding against a delayed
  weekend EOD correction still touching Friday's candle) - confirmed with
  the user this session that the intended behavior is "last week", not
  "second-to-last week", and confirmed they wanted the shared rule fixed
  everywhere rather than only patching the display label.
- Fixed `isCompletedTradingWeek` to compare dates directly (a week is
  complete once `getLatestExpectedTradingDay(...) >= getWeekEndingFriday(weekCandleTime)`)
  and `resolveCompletedWeekEndingFromTradingDay` to only step back an
  extra week when the trading day passed in falls *before* its own week's
  Friday (mid-week), not unconditionally. This function is shared by the
  Weekly Strong evaluator's `excludeIncompleteTradingWeek` (also used by
  Scanner's weekly candle series via `scanner.candles.ts`) and the
  dashboard's weekEnding label (`dashboard-snapshots.service.ts`) - fixing
  it once keeps all three consistent, per explicit confirmation rather
  than only changing the label.
- 4 pre-existing tests in `trading-calendar.test.ts` asserted the old
  one-extra-week-lag behavior (including one with an explicit "deliberate
  design choice" comment) - updated to the corrected semantics; no other
  test file needed changes (Scanner/Weekly Strong/metrics tests don't
  happen to hit this exact Friday-boundary edge case in their fixtures).
- Real-data verification (BSE100, the only active collection): fresh
  `resolveLatestCompletedWeekEnding('BSE')` now returns `2026-09-11`
  (was `2026-09-04`). The dashboard's *persisted* weekly_strong snapshot
  needed an explicit `invalidateCollectionSnapshots` + reread to pick up
  the new date (its `asOfDate` was frozen from a prior computation - this
  is pre-existing caching behavior, not something this fix changed).
  Running the real `syncWeeklyStrongBacktestIncremental("BSE")` (the same
  function the scheduled job calls) generated the week-ending-2026-09-11
  backtest run and confirmed the label now matches real data.
- **Side effect observed during verification, not caused by this fix**:
  running the incremental sync also generated a `historical_membership`
  run for BSE100 (this collection has an admin-imported dated membership
  version on file), which switches `resolveMembershipMode` to historical
  mode going forward. Since no earlier historical_membership run exists
  yet, `getWeeklyStrongBacktestMembershipChanges` currently reports
  `previousWeekEnding: null` for this collection until a second
  historical week accumulates - a normal bootstrapping state for a
  mode this collection was already configured to use, not a bug in this
  fix or in the previously-verified Stocks In/Out logic.
- `npx tsc --noEmit`/`npm run lint`/`npm test` clean (666/666, 66 files).
  No schema/migration, provider, Scanner *rule* logic (only the shared
  week-completeness gate it also happens to call), or Weekly Strong
  formula changed - only the completeness/date-resolution rule.

Completed:
- Audited the full data flow for the dashboard's "Stocks In This Week" /
  "Stocks Out This Week" card end to end: `useCollectionWeeklyStrongStocks`
  (canonical current weekEnding) → `getWeeklyStrongBacktestMembershipChanges`
  (`findRunForWeek`/`findPreviousRun`/`computeMembershipChanges`,
  `weekly-strong-backtest.queries.ts`) →
  `useWeeklyStrongBacktestMembershipChanges` (frontend hook, pass-through) →
  `WeeklyStrongMembershipChanges.tsx` (`enteredStocks` → "Stocks In",
  `exitedStocks` → "Stocks Out"). Verified with real BSE100 data (the only
  active collection): current week 2026-09-04, previous week 2026-08-28 -
  matching the exact dates named in the bug report - and cross-checked
  `computeMembershipChanges`'s output against an independent raw-SQL
  set-difference over the same two runs' member rows. Both matched
  exactly (0 IN, 17 OUT), and every OUT symbol was independently confirmed
  present in the previous run and absent from the current run. **No
  direction reversal was found** - set-difference direction, snapshot
  date direction, and the frontend's IN/OUT wiring were all already
  correct. Logged as an honest negative result per RULES.md #4 rather than
  inventing a fix for a reversal that isn't present in the code.
- Fixed a real, separate deviation found during the audit: membership
  identity was computed from `exchange:symbol` text
  (`weekly-strong-backtest.queries.ts`'s `membershipKey`) instead of the
  canonical `instrumentId` already present on `weeklyStrongBacktestMembers`
  (NOT NULL, unique per `(runId, instrumentId)`). Switched
  `computeMembershipChanges` to compare by `instrumentId`, added
  `dedupeByInstrumentId` before comparison (duplicate member rows no
  longer produce duplicate IN/OUT rows), and added `instrumentId` to
  `WeeklyStrongBacktestMembershipChangeMember` (backend and frontend
  types) - additive, no UI/table redesign. This protects the classification
  against a future symbol rename (same instrument, new symbol text) being
  misclassified as one exit + one entry instead of unchanged, which the
  previous text-identity approach could not distinguish.
- 19 tests in `weekly-strong-backtest.membership-changes.test.ts`
  (up from 8): the task's canonical A/B/C example, current/previous-only
  classification, unchanged-stock exclusion, identical-snapshot zero
  result, duplicate-row dedup, instrumentId-vs-symbol-text identity (both
  directions - a real rename is unchanged, two different instruments
  sharing a symbol are both an entry and an exit), an explicit
  current-newer-than-previous date assertion, and an IN/OUT invariant
  helper (every IN stock exists in current and not in previous, every OUT
  stock exists in previous and not in current) applied across every
  fixture.
- `npx tsc --noEmit`/`npm run lint`/`npm test` clean (backend, 666/666,
  66 files); frontend `npx tsc --noEmit`/`npm run lint`/`npm run build`
  clean (additive `instrumentId` field only, no UI change). No Weekly
  Strong formula, Scanner, candle sync, provider, schema/migration, or
  Friday analysis-week semantics touched.

Completed (Phase 4B fix 2):
- Root cause of the "only updates after a manual page refresh" reports: the
  chart's freshness signal lived in a *separate* mutation
  (`useEnsureFreshDailyCandles`) that had to successfully call
  `queryClient.invalidateQueries` with a matching predicate for the chart's
  own `useCandles` query to ever pick up the repair - two independent
  request lifecycles that had to both complete and hand off correctly.
  Confirmed via live testing this session that the ensure-fresh call itself
  and the repair were both working; the failure mode traced to that
  hand-off (in one observed case a dev-server Fast Refresh reset the
  in-memory access token between the two calls, in general any interruption
  between the mutation resolving and the invalidate firing left the chart
  showing pre-repair data with nothing left to retry it).
- Fix: `useCandles` can now take `{ ensureFresh: true }` and does the
  freshness check *inside its own queryFn*, before reading candles - one
  request lifecycle, not two. `ensureFreshCandles()` is awaited first
  (already bounded at 90s server-side, Phase 4B fix), then `getCandles()`
  runs and returns the now-repaired data directly as the query's own
  result. `useScannerCandles` (the chart page's hook) passes
  `ensureFresh: true`; other `useCandles` callers (`StockQuickChartPreview`)
  are unchanged (default `false` - no wait, existing behavior preserved).
  The separate `useEnsureFreshDailyCandles` mutation/hook and its
  predicate-based invalidate are deleted, not left dead.
- A real second bug found and fixed in the same pass: `useCandles`'s
  `placeholderData: (previousData) => previousData` carries the
  *previously viewed symbol's* candles into the query while a new one is
  loading. With the old fire-and-forget ensure-fresh this was a brief,
  easy-to-miss flash; once a repair can legitimately take real time,
  showing another symbol's chart mislabeled as the new one for that long
  is actively misleading. `placeholderData` is now disabled specifically
  when `ensureFresh: true`, so the scanner chart shows a genuine loading
  state instead of a stale different symbol.
- `getChartCandles`/GET `/charts/:symbol/candles` is unchanged and still
  strictly DB-only - the merge happens entirely in the frontend query
  lifecycle (one `queryFn` doing ensure-fresh-then-fetch), not by adding a
  provider call to the backend read route.
- Files changed: `src/features/market-data/hooks/use-market-data.ts`,
  `src/features/scanner/hooks/use-scanner-data.ts`,
  `src/features/scanner/components/ScannerPage.tsx`,
  `src/features/market-data/index.ts`. No backend changes this pass.
- `npx tsc --noEmit` clean, `npm run lint` clean, `npm run build` succeeds
  (frontend). Backend suite unaffected: 659/659 pass.

Completed (Phase 4B fix):
- Root cause: the ensure-fresh dedupe job id used `:` as a separator
  (`chart-ensure-fresh:{exchange}:{symbol}:{date}`), which collides with
  BullMQ's own use of `:` as a Redis key-segment delimiter for custom job
  ids. Job id is now `chart-ensure-fresh-{exchange}-{symbol}-{date}`
  (hyphen-separated) - same dedupe identity (instrument + latest expected
  trading date), safe as a BullMQ job id.
- `ensureFreshDailyCandles` no longer returns `in-progress` immediately
  after enqueueing a new job or finding an active/waiting one - it now
  waits on that job (new `getMarketDataQueueEvents()` in `queues.ts`,
  `Job.waitUntilFinished`) for up to 12s. A repair that finishes inside
  that window returns its real terminal status (`updated`/`repaired`/
  `already-current`/`bootstrap-required`/`failed`); only a genuine timeout
  still returns `in-progress`. A job that fails within the window is
  reported as `failed` (`changed:false`), never cached as settled, so a
  later call retries - unchanged from Phase 4B's original failed-job
  handling, just now reachable within the same request when it happens
  quickly.
- No new queue, planner, or repair service - `getMarketDataQueueEvents`
  reuses the existing `market-data` BullMQ queue/Redis connection;
  `refreshDailyCandles` (Phase 4A) remains the only repair implementation.
- Files changed: `backend/src/modules/jobs/queues.ts`,
  `backend/src/modules/market-data/market-data.chart-ensure-fresh.ts`,
  `market-data.chart-ensure-fresh.test.ts` (17 tests, was 12).
- Controlled live verification (BSE, real DB, 2 symbols): LALPATHLAB
  already-current both calls; TCS had genuinely drifted stale in this
  sandbox (no worker process has run the 15:45/17:00 job here since the
  last session), first ensure-fresh call found and repaired a real gap
  (4834 -> 4860 rows, latest 2026-08-06 -> 2026-09-11, `updated`), second
  call made zero additional `refreshDailyCandles` invocations (cache hit,
  ~3s vs ~7-10s). This environment's Redis is configured but unreachable,
  so live runs exercised the in-memory fallback's bounded wait; the
  BullMQ-path bounded wait/timeout/failure-retry behavior is proven by 17
  mocked unit tests.
- `npx tsc --noEmit` clean, `npm run lint` clean, `npm test` - 657/657
  pass (66 files). Frontend untouched this round (existing
  `useEnsureFreshDailyCandles` mutation logic already handles any
  `status`/`changed` combination the backend can return, including the
  new case of a fast terminal result arriving immediately instead of
  after one delayed retry).

Completed (Phase 4B):
- New endpoint `POST /api/market-data/candles/ensure-fresh` (auth-gated, same
  as `/charts/:symbol/candles`) - `ensureFreshDailyCandles({symbol, exchange})`
  in `market-data.chart-ensure-fresh.ts`. `getChartCandles` itself was not
  touched again in this phase - it was already DB-only as of Phase 4A.
- Reuses Phase 4A's `refreshDailyCandles` as the sole repair implementation
  (no second planner) - scheduled sync, manual admin refresh, and chart
  self-heal all call the same function.
- Dedupe key is `instrument + latest-expected-trading-date`, backed by a
  BullMQ job id (`chart-ensure-fresh:{exchange}:{symbol}:{date}`) on the
  existing `market-data` queue/worker - no new Redis client, no new DB
  table. A completed job's `returnvalue` is reused directly on a later
  call (zero additional provider call) unless its status is `failed`, in
  which case the job is removed and retried. When Redis is unreachable or
  unconfigured, an in-memory single-flight + settled-result cache (same
  shape, `failed` never cached) is the fallback for a single-instance/dev
  backend - logged plainly as a degraded path, not silently swallowed.
- Worker gained one new job type, `chartCandleEnsureFresh`, calling
  `refreshDailyCandles({symbol, exchange})` - same write path as the
  scheduled `dailyCandleSync` job.
- Frontend: `useEnsureFreshDailyCandles` fires once per chart
  symbol+exchange selection (ref-guarded, not re-fired on every candle
  refetch), does not block chart rendering, and on `updated`/`repaired`
  invalidates the exact `["market-data","candles",{symbol,exchange,...}]`
  query family (all timeframes for that symbol/exchange) so 1D/1W/1M all
  pick up the repaired canonical 1D on next read - 1W/1M are derived from
  1D at read time in `getChartCandles`, not persisted independently, so no
  reaggregation step was needed. `in-progress` schedules exactly one
  delayed re-check (5s); no polling loop. Wired into the scanner chart
  workspace (`ScannerPage.tsx`/`useScannerEnsureFreshCandles`), BSE only.
- `bootstrap-required` and `provider-empty` are treated as settled (cached
  like a success) since neither makes a provider call either way; only
  `failed` is excluded from the cache so a later chart open retries.
- Controlled live verification (BSE, real DB, 3 symbols, no full-universe
  run): LALPATHLAB/TCS/RELIANCE were already fully repaired by Phase 4A's
  own verification, so this phase's live run correctly classified all
  three `already-current` on the first ensure-fresh call and proved the
  second call for the same symbol made zero additional `refreshDailyCandles`
  invocation. BullMQ-path dedup (job reuse, concurrent-request collapse,
  failed-job retry, cross-symbol independence) is proven by 12 mocked unit
  tests instead of live BullMQ, since this sandbox's Redis is configured
  but unreachable - the ensure-fresh call gracefully falls back to the
  in-memory path after a bounded 3s timeout rather than hanging, a real
  gap this environment surfaced and was fixed as part of this phase.
- `npx tsc --noEmit` clean (backend + frontend), `npm run lint` clean
  (backend + frontend), backend `npm test` - 652/652 pass (66 files, +14
  since Phase 4A), frontend `npm run build` succeeds.

Completed (Phase 4A):
- Root cause confirmed (baseline: LALPATHLAB/KOTAKBANK diagnostics): the
  provider and upsert path were already correct; gaps like LALPATHLAB's
  survived because routine sync (`syncLatestDailyCandlesForSymbols`, the
  non-Zerodha branch) called the provider's "latest daily candle" endpoint
  with no date range at all, so only the single newest day was ever
  re-checked - an existing but non-fresh middle gap was never revisited.
- New pure range planner `planDailyCandleSync` (`market-data.candle-sync-plan.ts`):
  `incrementalFrom = latestStoredDate - INCREMENTAL_OVERLAP_TRADING_DAYS (5)`,
  `repairFrom = latestExpectedTradingDate - RECENT_REPAIR_WINDOW_CALENDAR_DAYS (35)`,
  `from = earlier(incrementalFrom, repairFrom)`, `to = latestExpectedTradingDate`.
  No stored history -> `{ kind: "bootstrap-required" }`, never a full-history
  fetch folded into routine sync. 9 unit tests (`market-data.candle-sync-plan.test.ts`).
- New `refreshDailyCandles({ symbol, exchange })` and
  `syncDailyCandlesForActiveInstruments(exchange)` (`market-data.candle-sync.ts`):
  single-symbol and multi-symbol entry points sharing one range-planning +
  write path (`backfillDailyCandles`, unchanged). Per-symbol result:
  `updated | repaired | already-current | bootstrap-required | provider-empty | failed`.
  Post-write verification diffs provider-returned dates against DB dates in
  the fetched range and surfaces any gap as `failed` (never silently
  swallowed). One symbol failing never aborts the run - failures are
  isolated and listed in the job summary
  (`processed/updated/repaired/alreadyCurrent/bootstrapRequired/failed/failedSymbols`).
  9 tests (`market-data.daily-candle-sync.test.ts`), including the
  LALPATHLAB-class regression (present latest candle, absent recent middle
  dates, restored by one normal refresh call, classified `repaired`).
- Read path is now DB-only (RULES.md #16, previously violated): removed
  `getChartCandles`'s freshness-triggered provider calls
  (`runChartBackfillOnce`/`runLatestCandleRefreshOnce`) and its
  no-DB-rows-at-all runtime provider fallback (`fetchRuntimeChartCandles`);
  the now-dead classifier helpers
  (`decideChartCandleFreshnessAction`/`isLatestDailyCandleStale`/
  `hasSuspiciousHistoryGap`/`hasLikelySplitDiscontinuity`/
  `shouldBackfillRequestedHistory`/gap-retry-cooldown helpers) and their
  test file (`market-data.freshness.test.ts`) were deleted rather than left
  unused. Removed `market-data.metrics.ts`'s `readDailyAndWeeklyMetricCandles`
  seed-backfill fallback (`RELATIVE_STRENGTH_SEED_BACKFILL_LIMIT`) - a
  symbol pool with zero stored candles is now covered by the routine daily
  sync job, not fetched on a Relative Strength/Weekly Strong read.
- Scheduling audited first: no existing job ran a bounded, once-daily,
  post-close candle sync (`instrumentSync`'s 30-min cadence exists for the
  live latest-price ticker, `refreshAllLatestInstrumentPrices` - left
  unchanged). New repeatable job `dailyCandleSync`, same BullMQ
  queue/worker (`market-data`, `worker.ts`), cron `45 15 * * 1-5` (main) +
  `0 17 * * 1-5` (retry), `tz: Asia/Kolkata` - not a new queue system.
- Manual single-symbol repair preserved/formalized: admin
  `POST /admin/market-data/refresh-daily-candles` ->
  `triggerDailyCandleRefresh` -> `refreshDailyCandles`, the exact same
  function the scheduled job calls per symbol - no separate formula.
- Controlled live verification (BSE, real DB writes, small explicit sample,
  no full-universe run): LALPATHLAB (already repaired by the earlier
  diagnostic) re-ran as `already-current`, 2656 -> 2656 rows, proving
  idempotency; TCS had a real recent middle gap, 4853 -> 4860 rows,
  classified `repaired`; RELIANCE was a week stale (latest 2026-09-04),
  extended to 2026-09-11, 4855 -> 4860 rows, classified `updated`. All
  three: zero persistence failures, provider fetch bounded to ~26 days per
  symbol (vs the prior full-history-style 30-year `getDefaultChartHistoryFromDate`
  bound still used only by admin backfill/bootstrap paths, never by routine
  sync).
- No Scanner, Weekly Strong evaluator, schema, or stored-weekly-candle
  logic touched. `npm run typecheck` clean; `npm run lint` clean;
  `npm test` - 638/638 pass (64 test files; +9 range-planning tests, +9
  gap-repair/regression tests since the prior pass; -8 removed with the
  deleted freshness test file).

Completed:
- backend documentation foundation created (`backend/docs/RULES.md`,
  `ARCHITECTURE.md`, `PROGRESS.md`, `DECISIONS.md`, `ROADMAP.md`)
- Phase 1A audit: current `instruments` schema, identity flow across
  instrument sync, candles, collections, backtests, taxonomy, stock
  search/listing, chart reads; symbol-rename failure path traced in code
  and confirmed live in DB
- Phase 1B fix: `upsertInstruments` (`market-data.instruments.ts`) now
  detects a provider+instrumentToken match under a different symbol and
  updates that existing instrument row's symbol/name/segment in place,
  preserving `instrument.id`, instead of silently dropping the row
- conflict safety: if the new symbol already belongs to a different
  instrument row (same exchange), the rename is skipped and reported via
  `logger.warn` — neither row is touched, no automatic merge
- 7 regression tests added for the rename/conflict/idempotency behavior
- Phase 1B closure: abandoned src-v2 remnants removed (`backend/scripts/v2/`,
  `backend/tsconfig.v2.json`, `docs/backend-v2/`, the `src-v2` alias block
  in `backend/vitest.config.ts`); backend test suite fully green
- Phase 1C: abandoned `instruments` schema draft (`type`, `security_code`,
  `isin`, `instruments_type_check`) reverted from
  `src/db/schema/market-data.ts`; the never-applied-by-us draft migration
  `drizzle/0020_deep_overlord.sql` + `drizzle/meta/0020_snapshot.json`
  deleted; the matching `0020_deep_overlord` entry removed from
  `drizzle/meta/_journal.json` — schema/migration state restored to the
  committed baseline (`0019_first_ravenous` is now latest again)
- Phase 2A: candle canonical identity migrated from
  `(exchange, symbol, timeframe, time)` to `(instrument_id, timeframe, time)`.
  Preflight was clean (0 duplicates, 0 null `instrument_id`, 0 orphans across
  1,750,233 rows). Migration `0020_candle_instrument_identity` generated and
  applied to the current dev DB. `readChartCandles`, `readCandleHistoryRange`,
  `deleteCandlesForRefresh`, `upsertCandles` (conflict target + dedupe key),
  and `replaceCandlesAtomically` now key on `instrument_id`; `getChartCandles`
  / `getChartHistoryRange` (`market-data.service.ts`) resolve the instrument
  once via `getInstrumentsBySymbol` and pass `instrumentId` into every candle
  read. `exchange`/`symbol` remain on the row as transitional metadata only.
  8 new regression tests added
- Phase 2B: closed the remaining candle identity gap. `readMetricCandles`
  and `findSymbolsNeedingHistoryBackfill` (`market-data.candles.ts`) now
  filter/group by `instrument_id`; `instrumentId` was threaded through
  `RelativeStrengthInstrumentInput`, `readDailyAndWeeklyMetricCandles`, and
  every caller (`computeAllRelativeStrengthMetrics`,
  `computeWeeklyStrongStocks`, `computeWeeklyStrongBacktestMembers`,
  `getSymbolWeeklyStrongSeriesInput`, the index-RS query in
  `market-data.service.ts`, `watchlists.service.ts`,
  `weekly-strong-backtest.generation.ts`'s historical-membership mapping,
  and `market-collection-preparation.service.ts`). All of these already had
  `instrument.id` on hand from their existing DB rows — no new query was
  added anywhere except one per-symbol instrument lookup inside
  `getSymbolWeeklyStrongSeriesInput` (Scanner's live single-symbol path,
  which previously had no instrument row at all). No formula, scoring,
  membership-rule, snapshot, or dashboard-output change. 12 new/updated
  regression tests
- Phase 2C: removed the last normal application candle read/existence
  query still keyed on `exchange + symbol`. `searchChartEligibleBseStocks`'s
  (`market-data.stocks.ts`) per-instrument "has a daily candle" EXISTS
  subquery now joins `candles.instrument_id = instruments.id` instead of
  `candles.exchange = instruments.exchange AND candles.symbol =
  instruments.symbol`. No search/listing filter, sort, pagination,
  NSE/BSE rule, response shape, or unrelated query changed. 2 tests
  updated/added in `market-data.stocks.test.ts` proving the EXISTS clause
  joins by `instrument_id`/`id` and no longer contributes `exchange`/
  `symbol` params
- Phase 3A: Scanner qualification is now standalone from Weekly Strong.
  `evaluateScannerWeeklySeries` (`scanner/rules/scanner-weekly-rule.ts`) is
  a new, Scanner-owned, weekly-close-only rule (`close > rollingMax(close,
  N) * 0.85`, N = 50/150/250, inclusive window, strict `>`) with zero
  dependency on daily candles or the Weekly Strong evaluator. Live Scanner
  (`calculateNear250WeekHighScan`) and Scanner Backtest
  (`computeSymbolBreakoutBacktest`, moved to `scanner/scanner.backtest.ts`)
  both consume this same rule via a new shared, Scanner-owned fetch step
  (`getScannerWeeklySeriesInput`, `scanner/scanner.candles.ts`) instead of
  the former shared `getSymbolWeeklyStrongSeriesInput`/
  `evaluateWeeklyStrongSeries` two-condition path. `deriveScannerLookbackBars`
  (Weekly Strong's daily-bar-ratio helper, now unused) was removed. A live,
  read-only DB audit (RELIANCE, TCS, SENSEX, plus the 3 most-stale active
  BSE instruments by latest daily candle) found: SENSEX's daily/weekly
  data is materially stale (latest daily candle ~5 weeks old); TCS has a
  real partial-week daily gap immediately before "now" (a week with only
  its Monday daily candle, Tue-Fri missing); ZOMATO/TATAMOTORS/LTIM are
  marked active but have not synced in months. None of this was repaired -
  see DECISIONS.md.
- Phase 3A (same-day refinement): the completeness safety check was
  extended from "detect a fully-missing completed week" to "detect a
  fully-missing OR partial completed week," directly closing the gap the
  audit above surfaced (TCS's partial week would not have been caught by
  the original gap-only check). `classifyScannerWeeklySeries`
  (`scanner/rules/scanner-weekly-series-safety.ts`) replaces the original
  `isLatestScannerWeekFresh`/`trimToTrailingContinuousWeeklySeries` pair:
  a completed week with 1-2 daily sessions (out of an expected up-to-5) is
  "partial" and invalid; 0 sessions is "fully missing"; a tolerance floor
  of 3 sessions absorbs legitimate 1-2-holiday weeks (this codebase does
  not model exchange holidays) without misclassifying them as gaps. The
  usable series is trimmed to the trailing run of valid weeks; the latest
  week being partial or missing also marks the live scan "stale" (no
  current match), not merely a shorter window. No candle is fabricated or
  forward-filled. 1x/3x/5x, completed-week exclusion, and the 250->150->50
  live-scan fallback are unchanged; Scanner Backtest still has no such
  fallback (unchanged from before this phase). Direct stored-1W reads
  remain out of scope (Phase 3B); a first pass compared derived-from-daily
  vs stored 1W for RELIANCE/TCS/SENSEX (near-total overlap, 1 close
  mismatch each for RELIANCE/TCS, 0 for SENSEX)
- Phase 3B: replaced Scanner's candle fetch with a bounded, Scanner-owned
  query. New `readScannerDailyCloses` (`market-data.candles.ts`) reads a
  single instrument's `1D` candles selecting only `time`/`close` (not the
  full OHLCV set), with no artificial calendar lower bound - it reads
  exactly the instrument's own stored history, no more, no less (product
  decision: full per-symbol history is preserved for historical yellow
  bands rather than truncated to a fixed lookback window). `getScannerWeeklySeriesInput`
  (`scanner.candles.ts`) no longer goes through the generic multi-symbol
  `readDailyAndWeeklyMetricCandles`/`readMetricCandles` path (which also
  selected all 7 OHLCV columns per row, batched for multi-symbol callers,
  and - a latent issue this phase's removal incidentally fixes - could
  trigger a live provider seed-backfill call when a symbol had zero synced
  daily candles). Weekly derivation is now a small Scanner-owned
  `deriveScannerWeeklyCloses` that reuses the existing
  `aggregateWeeklyCandles` grouping/week-boundary algorithm (feeding it
  close-only rows with placeholder OHLV) rather than duplicating week-math.
  The Phase 3A completeness classifier (`classifyScannerWeeklySeries`) is
  unchanged and still runs on every request. A controlled, read-only DB
  comparison (RELIANCE, TCS, SENSEX; old generic-fetch+classifier path vs
  new bounded-fetch+same-classifier path) found byte-for-byte identical
  Scanner decisions (matched/highlightTimes/backtest signal counts) at all
  three lookback tiers, with identical daily row COUNTS for these three
  symbols specifically (their full history already fit the old fetch
  window) but only 2 columns selected per row instead of 7, and no
  generic multi-symbol batching/provider-fallback code in the path at all.
  6 new/updated regression tests. Stored `1W` was not adopted or modified
  (Phase 3B was explicitly scoped to bounding the `1D` read only)
- Phase 3B.1: fixed a regression where a single missing/partial completed
  week near "now" (BSE/TCS, BSE/LALPATHLAB) caused the ENTIRE Scanner
  history to disappear - the completeness classifier kept only the
  trailing valid segment, so a gap right before the latest week discarded
  all older, otherwise-valid history along with it. Missing/partial
  completed weeks are now treated as hard continuity boundaries that
  PARTITION the weekly series into independent valid segments
  (`classifyScannerWeeklySeries` now returns `{segments, latestSegment,
  isLatestWeekFresh}` instead of a single trailing `validWeeklyRows`
  array; the invalid week itself belongs to no segment). Each segment is
  evaluated independently for historical highlightTimes using the exact
  requested lookback tier (50/150/250) with no smaller-tier fallback and
  no partial leading window - `evaluateScannerWeeklySeries` now forces
  `passes=false` for any index before a full `lookbackWeeks` window
  exists, so no segment can ever emit a signal before it has genuinely
  accumulated the required number of valid weeks, and no rolling window
  can span a gap (each segment has its own independent index space).
  Current/latest qualification is now a wholly separate concern: it
  applies only to `latestSegment`, still using the existing 250->150->50
  live-scan fallback (unchanged, still absent from Backtest), and is
  simply unavailable (`matched: undefined`) when the latest segment is
  stale or too short - this no longer suppresses historical
  `highlightTimes`, which are independent. Scanner Backtest
  (`computeSymbolBreakoutBacktest`) is now segment-aware too: trades are
  built per segment and combined afterward, so a trade can never open in
  one segment and close in another. A controlled, read-only DB check
  confirms TCS and LALPATHLAB now return non-zero historical
  highlightTimes (previously 0/0) while RELIANCE and SENSEX show no
  regression. 9 new/updated regression tests, including a direct
  TCS/LALPATHLAB-class regression test (200+ valid weeks, gap, <50 valid
  weeks after, stale latest week: historical matches survive, current
  verdict stays unavailable, no rolling window crosses the gap)
- Canonical Weekly Candle Timestamp fix: fixed at its source. The shared
  `aggregateWeeklyCandles` (`candle-aggregation.ts`) previously set a
  weekly candle's `time` to whichever daily row happened to be first
  available in that ISO week - if the Monday candle was missing (a real,
  unrepaired data gap, confirmed live on BSE/KOTAKBANK: no `2026-08-31`
  row), the weekly candle was mislabeled with the next available day
  (e.g. `2026-09-01`) instead of the week it actually represents. `time`
  is now always `getIsoWeekRange(time).start` - the canonical Monday of
  that ISO week - reusing the existing `trading-calendar.ts` helper, with
  zero new week-definition logic. OHLCV aggregation itself is completely
  unchanged: open/high/low/close/volume still come only from actual
  stored daily rows, nothing fabricated or forward-filled for the missing
  day. This is a single, global fix affecting every caller of
  `aggregateWeeklyCandles` (the price chart's own 1W rendering, provider
  backfill's stored 1W/1M writes, Relative Strength/Weekly Strong's
  derived weekly series, and Scanner) - all audited and confirmed
  semantically safe: Weekly Strong/Scanner completeness logic and the
  persisted `weekEnding` values were already computed via
  `getWeekEndingFriday`, which is itself invariant to which day within
  the week is used as input, so none of that logic changes. Scanner's own
  local timestamp normalization (added in the prior, Scanner-only-scoped
  fix) is now redundant and was removed - there is one canonical weekly
  timestamp rule, not two independently-maintained ones. `aggregateMonthlyCandles`
  was deliberately left untouched (still buckets by first-available day) -
  out of this fix's scope. A controlled, read-only DB check confirms
  BSE/KOTAKBANK's chart 1W output now reads `2026-08-24`, `2026-08-31`,
  `2026-09-07` (previously `2026-08-24`, `2026-09-01`, `2026-09-07`), and
  that BSE/TCS and BSE/RELIANCE's normal weeks are unaffected except for
  the same canonical-label correction where applicable. 10 new/updated
  tests. No Scanner qualification formula, 1x/3x/5x, 0.85 ratio, Weekly
  Strong formula, schema, or DB write was touched.
- Phase 3B.2: the completeness classifier was too aggressive - a completed
  week with even 1-2 real daily sessions (previously called "partial") was
  treated as a hard continuity boundary, fragmenting a symbol's history
  and resetting the 50/150/250-week rolling window around it (confirmed
  live: BSE/KOTAKBANK and BSE/TCS both fragmented into a short recent
  segment plus a discarded-from-continuity older one, purely because of
  their `2026-08-31` week's low session count). The rule is now: **a
  completed week with at least 1 actual daily candle stays in the
  rolling series and does not break continuity; only a week with zero
  daily candles (no weekly candle exists at all) is a hard boundary.**
  `classifyScannerWeeklySeries` (`scanner-weekly-series-safety.ts`) no
  longer takes daily rows or computes a session count at all - it now
  partitions purely on the >7-day gap between consecutive weekly
  candles' week-endings (the "fully missing week" signal), which is
  exactly what a zero-session week already looks like structurally (no
  weekly candle is ever produced for it in the first place). Freshness
  (`isLatestWeekFresh`) is likewise now purely date-based (does the
  latest segment's last week match the exchange's actual latest
  completed week), no longer additionally gated on session count - a
  latest week backed by just 1 real session is fresh and participates in
  the live verdict. The former `MIN_TRADING_SESSIONS_PER_COMPLETED_WEEK
  = 3` "partial" heuristic and its session-counting helper were removed
  as dead code (nothing consumed the distinction it drew once continuity
  no longer depends on it); the heuristic can be reintroduced later as a
  standalone diagnostic if a real reporting need for it emerges. A
  partial week's weekly close remains exactly the close of its last
  actual daily candle - never fabricated, never forward-filled. A
  controlled, read-only DB check confirms KOTAKBANK and TCS are now each
  a single continuous 1,027-week segment (previously fragmented into
  [138, 887]/[138, 887]), both fresh, both producing full historical
  highlightTimes and a live verdict again; LALPATHLAB (a genuine, fully
  missing latest week) and SENSEX (genuinely stale by calendar
  comparison) correctly retain their prior boundary/staleness behavior -
  proving the fix is scoped to partial weeks only, not fully-missing or
  genuinely-stale ones. 11 new/updated regression tests.
- Phase 3B.2 (exhaustive re-verification pass, same implementation, no
  further code change): confirmed all four audited files
  (`scanner-weekly-series-safety.ts`, `scanner.candles.ts`,
  `near-250-week-high.ts`, `scanner.backtest.ts`) already fully satisfy
  the continuity rule - `MIN_TRADING_SESSIONS_PER_COMPLETED_WEEK` and its
  session-counting helpers do not exist anywhere in the codebase (repo-wide
  search confirmed). Added 7 more regression tests to close explicit
  coverage gaps: a dedicated 5-session/complete-week case, 150-week and
  250-week (not just 50-week) rolling windows spanning a partial week, a
  zero-session week actually blocking an earlier spike from the rolling
  max, the latest week backed by 1 session producing a real
  `matched: true` (not just `isLatestWeekFresh: true`), the latest week
  being entirely missing producing `matched: undefined` through the full
  `calculateNear250WeekHighScan` path, and the still-forming current week
  remaining excluded. A live, read-only, formula-level check
  (week/close/rollingMax/threshold/matched at 5x) for
  KOTAKBANK/LALPATHLAB/TCS/RELIANCE's `2026-08-31` week confirmed:
  KOTAKBANK's `2026-08-31` (close=424.85) now correctly evaluates and
  passes (matched=true) as part of its single 1,027-week segment;
  LALPATHLAB's `2026-08-31` has real data (close=1874.9, not fabricated)
  but sits alone in its own isolated 1-week segment - a *different*,
  genuinely fully-missing week elsewhere in LALPATHLAB's near-term history
  still separates it from the 557-week main segment, so it correctly
  cannot produce a 1x/3x/5x signal on its own (too few weeks in that
  segment) - this is the missing-week boundary working as designed, not a
  partial-week suppression regression. 18/18 tests total (11 from the
  original fix + 7 added this pass).
- Dashboard Weekly Date Unification (frontend-only; no backend code
  touched): audited every dashboard weekly-date source. Root cause of the
  "mixed dates" complaint: Index/Sector/Industry/Stock Harvest cards
  displayed the Relative Strength snapshot's raw `asOfDate` (a daily
  trading-day marker from `getLatestExpectedTradingDay`) directly,
  un-converted, while Harvest Results/Stocks In-Out/Harvest Backtest
  already correctly converted their own dates to the completed week's
  Friday via the existing `resolveCompletedWeekEndingFromTradingDay`/
  `getWeekEndingFriday` helpers (`trading-calendar.ts`, unchanged). Since
  all of these ultimately derive from the same underlying latest-trading-
  day state for the exchange, this was a **display-conversion
  inconsistency**, not a real data mismatch - no backend change was
  needed or made. Fix: added one global "Analysis week: <Friday>" label
  to the dashboard toolbar, sourced from the same
  `getCollectionWeeklyStrongStocks` `weekEnding` field Harvest Results
  already uses (an existing, already-existence-gated - `null` until a
  real Weekly Strong snapshot exists - canonical source); removed the
  four Harvest cards' individual "As of ..." labels entirely (no
  behavioral card logic changed, only the redundant date text); removed
  Harvest Results' now-redundant "Week ending ..." subtitle segment;
  threaded the same canonical week into Harvest Backtest as a preferred
  default (falls back to the latest available backtest week when the
  canonical week has no backtest data yet, since generating one is out
  of scope); Stocks In/Out and Backtest's date selector/options were
  already Friday-based and needed no change, confirmed by audit. "Last
  refreshed" (a client-side fetch timestamp, unrelated to any weekly
  date) was left untouched. No frontend test runner exists in this repo
  (no vitest/jest/`npm test` configured at the project root) - verified
  via `npx tsc --noEmit`, `npm run lint`, and `npm run build`, all clean;
  not verified in a live browser this session.

Current backend:
- `backend/src` remains the production/reference/final backend

Current cleanup state:
- Phase 1A (audit), Phase 1B (rename-handling fix), Phase 1C (abandoned
  schema draft removal), Phase 2A (candle schema/chart-read/write identity),
  Phase 2B (remaining candle read identity), Phase 2C (final normal candle
  symbol identity query), Phase 3A (standalone Scanner rule + candle
  completeness safety), Phase 3B (bounded Scanner 1D query + on-demand
  weekly derivation), Phase 3B.1 (segment-partitioned historical
  evaluation, fixing the historical-highlightTimes-erased-by-a-trailing-gap
  regression), the Canonical Weekly Candle Timestamp fix (weekly
  candle `time` = canonical ISO week start everywhere, not the first
  available daily row), and Phase 3B.2 (partial completed weeks no
  longer break Scanner continuity - only a fully missing week does) done
- all normal candle reads/writes in `backend/src` now key on `instrument_id`;
  `exchange`/`symbol` on `candles` are metadata/provider-coordinate columns
  only, never identity — no remaining normal application candle
  read/existence query uses `exchange + symbol` identity
- remaining `candles.exchange`/`candles.symbol` usages (all reviewed,
  classified allowed/deferred): `market-data.candles.ts`'s
  `readMetricCandles` output projection + display ordering (metadata, not
  identity); `scripts/reconcile-bse-candle-bootstrap-checkpoints.ts`
  (operational bootstrap/checkpoint tooling, explicitly deferred)
- `candle_bootstrap_checkpoints` identity migration deferred to the later
  candle backfill phase (operational/backfill concern, not touched)
- watchlists/alerts and existing fragmented instrument rows (e.g.
  ARIS/ARISINFRA, CEINSYS/CEINSYSTECH) remain deferred from Phase 1A
- Scanner qualification (`close > rollingMax(close, N) * 0.85`, weekly-only)
  is independent from Weekly Strong; Scanner's `1D` read is now bounded to
  a single instrument/lean columns (Phase 3B, done); weekly candles are
  still derived in Node from `1D`, never read from stored `1W` (a future
  Phase 3C switch to direct bounded stored-1W reads is not started -
  stored 1W coverage/freshness needs to be proven safe first, see
  Verification)
- only a FULLY missing completed week (zero daily candles, so no weekly
  candle is ever derived for it at all) is a hard Scanner continuity
  boundary; the weekly series is partitioned into independent valid
  segments only at those points (no rolling window ever crosses such a
  gap). A completed week backed by even a single real daily candle stays
  in the rolling series - it does not fragment history and does not
  disqualify itself from being the current/live week (Phase 3B, revised
  by Phase 3B.2 - superseding Phase 3B.1's stricter "1-2 sessions is also
  a boundary" behavior). Only the LATEST segment's freshness/length
  governs the current/live verdict, so a genuinely stale or too-short
  latest segment still leaves older, still-valid historical highlightTimes
  intact
- the former `MIN_TRADING_SESSIONS_PER_COMPLETED_WEEK = 3` "partial week"
  heuristic no longer exists in the Scanner continuity path (removed,
  Phase 3B.2) - it played no role once partial weeks stopped breaking
  continuity, and per-week session-count/data-quality diagnostics were
  not rebuilt as a separate concern this phase (may be reintroduced
  later if a real reporting need emerges)
- weekly candle identity is canonical everywhere `aggregateWeeklyCandles`
  is used: `time` = the ISO week's Monday (`getIsoWeekRange(...).start`),
  independent of which daily row happened to be first stored for that
  week. This remains separate from continuity/completeness (Phase 3B.2):
  a canonical timestamp says nothing about whether the week is complete
  or how many sessions back it
- candle completeness gaps found live in the current dev DB (SENSEX daily
  data ~5 weeks stale; ZOMATO/TATAMOTORS/LTIM marked active with no sync
  in months) are real and unrepaired - root-cause (provider/sync/
  backfill/checkpoint) investigation and repair is deferred to the
  candle-flow phase, not fixed here. TCS's previously-reported
  `2026-08-31` partial-week gap is likewise still real/unrepaired
  underlying data, but as of Phase 3B.2 no longer degrades its Scanner
  result (continuity is preserved across that week)

Next candidate:
- to be decided with product owner; candidates: daily candle sync cleanup
  (including the newly-found stale/gapped BSE symbols), a future Phase 3C
  (Scanner onto direct bounded stored-1W reads, only once 1W coverage is
  proven safe), resolve existing fragmented instrument rows, or migrate
  `candle_bootstrap_checkpoints` to `instrument_id`

Blocked / decisions needed:
- how to treat existing fragmented instrument rows for the same security
  (deferred, not merged)
- whether/when to migrate `candle_bootstrap_checkpoints` to `instrument_id`
- root cause of the SENSEX/TCS/ZOMATO/TATAMOTORS/LTIM candle staleness and
  gaps found during the Phase 3A audit - not investigated further this
  phase

Verification:
- Phase 3A (including the same-day partial-week refinement): `npm run
  typecheck` clean; `npm run lint` clean; `npm test` — 592/592 pass, fully
  green (63 test files)
- controlled, read-only DB audit (RELIANCE, TCS, SENSEX, plus the 3
  most-stale active BSE instruments by latest daily candle -
  ZOMATO/TATAMOTORS/LTIM): no fully-missing completed weeks in the sampled
  symbols; SENSEX's derived latest completed week is materially stale;
  TCS has a real partial-week daily gap right before the latest completed
  week (now correctly classified invalid by `classifyScannerWeeklySeries`);
  derived-weekly-from-daily vs stored-1W comparison for RELIANCE/TCS/
  SENSEX shows near-total timestamp overlap with 1 close mismatch each for
  RELIANCE/TCS and 0 for SENSEX
- Phase 3B: `npm run typecheck` clean; `npm run lint` clean; `npm test` —
  598/598 pass, fully green (63 test files, 6 new/updated)
- controlled, read-only DB comparison (RELIANCE, TCS, SENSEX) of the old
  fetch mechanism (paired with the same Phase 3A classifier, to isolate
  only the fetch-shape change) vs the new bounded fetch: identical
  `matched`/`highlightTimes`/backtest-signal-count results at 1x/3x/5x for
  all three symbols, identical daily row counts (their full history
  already fit the old window), 2 columns selected per row instead of 7.
  TCS's live/historical Scanner result is empty for both old and new
  paths - its partial week sits immediately before "now", so the
  trailing-valid-segment trim correctly discards its entire usable series;
  this is the completeness guard working as designed on real, still-unfixed
  upstream data, not a Phase 3B regression
- Phase 3B.1: `npm run typecheck` clean; `npm run lint` clean; `npm test`
  — 605/605 pass, fully green (63 test files, 9 new/updated)
- controlled, read-only DB check (TCS, LALPATHLAB, RELIANCE, SENSEX) via
  `getScannerWeeklySeriesInput` + `calculateNear250WeekHighScan` +
  `listScannerResults`, all 1x/3x/5x tiers:
  - TCS: 2 segments (138, 887 weeks), latest stale; 1x historical matches
    704 (was 0 before this fix); current verdict unavailable
  - LALPATHLAB: 1 segment (555 weeks), latest stale; 1x historical matches
    311 (was 0 before this fix); current verdict unavailable
  - RELIANCE: 2 segments (138, 888 weeks), latest fresh; 1x historical
    matches 662, current matched=false at effective 50-week tier — no
    regression (previously non-empty, remains non-empty; the exact count
    differs from the Phase 3A/3B report because the full-window-required
    rule change and the newly-recovered older segment both affect the
    count, not because history was lost)
  - SENSEX: 1 segment (909 weeks), latest stale; 1x historical matches 810;
    current verdict unavailable
- Canonical Weekly Candle Timestamp fix: `npm run typecheck` clean;
  `npm run lint` clean; `npm test` — 617/617 pass, fully green (63 test
  files, 10 new/updated)
- controlled, read-only DB check via `aggregateWeeklyCandles` on real
  stored `1D` rows (the exact function the price chart's own 1W rendering
  uses):
  - BSE/KOTAKBANK, `2026-08-24`..`2026-09-07`: 1D rows present are
    `08-24,25,26,27,28, 09-01,04,07` (no `08-31`, confirming the real gap).
    Derived weekly timestamps: `2026-08-24`, `2026-08-31`, `2026-09-07` -
    no `2026-09-01` weekly candle
  - BSE/TCS: normal weeks unaffected; one week (whose first stored day was
    `09-09`) now correctly labeled `2026-09-07`
  - BSE/RELIANCE: unaffected (its stored data already had a Monday session
    for every observed week in the sample range)
- no schema change, no migration, no provider sync, no candle backfill, no
  5,000+ stock scan run, no candle-query optimization onto stored 1W
- stock search/listing, candle sync/backfill, providers, collections,
  Weekly Strong's own logic/tests, dashboard, and schema were not touched
- Phase 3B.2: `npm run typecheck` clean; `npm run lint` clean; `npm test`
  — 630/630 pass, fully green (63 test files, 11 new/updated)
- controlled, read-only DB check (KOTAKBANK, TCS, LALPATHLAB, RELIANCE,
  SENSEX) via `getScannerWeeklySeriesInput` + `calculateNear250WeekHighScan`
  + `listScannerResults`, all confirming the fix is scoped to partial
  weeks only:
  - KOTAKBANK: now 1 segment of 1,027 weeks (previously fragmented into
    2 segments under Phase 3B.1's stricter rule); latest fresh;
    `2026-08-31` weekly candle present (close=424.85, derived from its
    real daily rows); 5x highlightTimes=561, matched=true
  - TCS: now 1 segment of 1,027 weeks (previously 2, with the latest
    segment stale and unusable); latest fresh; 5x highlightTimes=602,
    matched=false - both current and historical results restored
  - LALPATHLAB: still 2 segments (557, 1 week) - it has a genuinely
    fully-missing latest week (0 daily candles), a real, different case
    from a partial week; correctly still a hard boundary; historical
    highlightTimes from the 557-week segment preserved (5x=74), current
    verdict correctly unavailable (latest segment too short)
  - RELIANCE: 1 segment, 1,027 weeks, latest fresh, no regression
  - SENSEX: 1 segment, 910 weeks, latest genuinely stale by calendar
    comparison (unrelated to session count), current unavailable,
    historical highlightTimes preserved (5x=632) - unaffected by this fix
- no schema change, no migration, no provider sync, no candle backfill, no
  5,000+ stock scan run
- Weekly Strong's own logic/tests, dashboard, schema, and the Scanner
  formula/lookback constants/0.85 ratio were not touched
- Phase 3B.2 re-verification pass: `npm run typecheck` clean; `npm run
  lint` clean; `npm test` — 637/637 pass, fully green (63 test files, 18
  Phase-3B.2 tests total: 11 original + 7 added this pass). No production
  code changed this pass (already correct); repo-wide search confirmed
  `MIN_TRADING_SESSIONS_PER_COMPLETED_WEEK` no longer exists anywhere. A
  live, read-only, formula-level check of `2026-08-31` at 5x
  (week/close/rollingMax/threshold/matched) confirmed KOTAKBANK's
  close=424.85 vs threshold=377.3575 → matched=true, and traced
  LALPATHLAB's isolated 1-week segment explicitly (see Completed above)

## Module status

Statuses are conservative: a module already touched by a past ad-hoc fix
is not marked Done here unless it went through the controlled process in
`RULES.md` (rule 4) end to end.

| Module | Audit | Cleanup | Tests | Verified | Status |
|---|---|---|---|---|---|
| Auth | Not started | Not started | Not started | Not started | Not started |
| Instruments | Done (2026-09-12) | Partial (rename handling, 2026-09-12) | Done (rename handling) | Done (typecheck+test) | In progress |
| Candles | Done (identity, 2026-09-12) | Done (all normal reads/writes on instrument_id, 2026-09-12; shared weekly aggregation timestamp made canonical, 2026-09-13) | Done (identity tests + canonical-weekly-timestamp tests) | Done (typecheck+lint+test+DB verify) | In progress (bootstrap checkpoints deferred) |
| Scanner | Done (2026-09-13) | Done (standalone weekly rule + bounded 1D query + fully-missing-week-only continuity boundary, decoupled from Weekly Strong, 2026-09-13; local weekly-timestamp normalization removed as redundant once fixed at the shared source, 2026-09-13; partial-week continuity fix, 2026-09-13) | Done (rule + safety + backtest-consistency + bounded-query + segment-partition + partial-week-continuity tests) | Done (typecheck+lint+test+DB completeness/comparison/segment/continuity audits) | In progress (Phase 3C stored-1W read + candle staleness/gap repair deferred) |
| Market Data | Not started | Not started | Not started | Not started | Not started |
| Collections | Not started | Not started | Not started | Not started | Not started |
| Analysis | Not started | Not started | Not started | Not started | Not started |
| Dashboard | Not started | Not started | Not started | Not started | Not started |
| Backtests | Not started | Not started | Not started | Not started | Not started |
| Watchlists | Not started | Not started | Not started | Not started | Not started |
| Alerts | Not started | Not started | Not started | Not started | Not started |
| Admin | Not started | Not started | Not started | Not started | Not started |
| Providers | Not started | Not started | Not started | Not started | Not started |
| Jobs | Not started | Not started | Not started | Not started | Not started |
