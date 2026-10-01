// Cross-source data fetcher for the homepage's configurable chart.
//
// Given a set of selected `CombinedMetric`s and the per-source `queryDaily`
// callbacks (from each useDatabase* hook), produce one
// `DailyDataPoint[]` series per metric. Only the sources that actually
// contribute a selected metric are queried; the rest never see their callback
// invoked, so paired with the hook-level `enabled` flag this means unused
// DBs are never loaded.

import type {
  DailyDataPoint,
  DailyRow,
  GlobalStats,
  GsuaDailyRow,
  GsuaGlobalStats,
  GsuaMonthlyRow,
  MediazonaEstimateRow,
  MediazonaRolesRow,
  MonthlyRow,
  RuAdGlobalStats,
  RuAdDailyRow,
  RuAdMonthlyRow,
  RuAirAttacksDailyRow,
  RuAirAttacksGlobalStats,
  RuAirAttacksMonthlyRow,
  RuLossesDailyRow,
  RuLossesGlobalStats,
  RuLossesMonthlyRow,
  SbuAlfaCounterRow,
  RubikonCounterRow,
  Stat,
  UaLossesDailyRow,
  UaLossesGlobalStats,
  UaLossesMonthlyRow,
  UaLossesRuModDailyRow,
  UaLossesRuModGlobalStats,
  UaLossesRuModMonthlyRow,
  ZelenskyWeekRow,
} from "@/types";
import type { CombinedMetric, MetricSource } from "@/utils/combinedMetrics";
import { windowStartDate } from "@/utils/dayRange";
import { type MonthOption, monthOf, windowStartMonth } from "@/utils/monthRange";
import { fillDailyRange, padTrailingMonthly, resolvedEndDate } from "@/utils/padTrailing";
import { type WeekOption, aggregateWeekly, mondaysBetween, weeklyWindow } from "@/utils/weekRange";

export interface CombinedQueries {
  sbs?: (days: number, endDate?: string) => DailyRow[];
  gsua?: (days: number, endDate?: string) => Promise<GsuaDailyRow[]>;
  ruLosses?: (days: number, endDate?: string) => RuLossesDailyRow[];
  uaLosses?: (days: number, endDate?: string) => UaLossesDailyRow[];
  uaLossesRuMod?: (days: number, endDate?: string) => UaLossesRuModDailyRow[];
  ruMod?: (days: number, endDate?: string) => RuAdDailyRow[];
  ruAir?: (days: number, endDate?: string) => RuAirAttacksDailyRow[];
}

export interface CombinedGlobalQueries {
  sbs?: () => GlobalStats;
  gsua?: () => Promise<GsuaGlobalStats>;
  ruLosses?: () => RuLossesGlobalStats;
  uaLosses?: () => UaLossesGlobalStats;
  uaLossesRuMod?: () => UaLossesRuModGlobalStats;
  ruMod?: () => RuAdGlobalStats;
  ruAir?: () => RuAirAttacksGlobalStats;
}

export interface GlobalStatsBundle {
  sbs?: GlobalStats;
  gsua?: GsuaGlobalStats;
  ruLosses?: RuLossesGlobalStats;
  uaLosses?: UaLossesGlobalStats;
  uaLossesRuMod?: UaLossesRuModGlobalStats;
  ruMod?: RuAdGlobalStats;
  ruAir?: RuAirAttacksGlobalStats;
}

function project(
  rows: Array<{ date: string; is_today?: boolean } & Record<string, unknown>>,
  key: string,
): DailyDataPoint[] {
  return rows.map((r) => {
    const raw = r[key];
    return {
      date: r.date,
      value: typeof raw === "number" ? raw : null,
      is_today: r.is_today === true,
    };
  });
}

export interface CombinedMonthlyQueries {
  sbs?: () => MonthlyRow[];
  // Parameterised, unlike every other entry here: one query per sub-unit, not
  // one per source. The fetcher calls it once for each distinct unit the
  // selected metrics name.
  sbsUnits?: (unitSlug: string) => MonthlyRow[];
  gsua?: () => Promise<GsuaMonthlyRow[]>;
  ruLosses?: () => RuLossesMonthlyRow[];
  uaLosses?: () => UaLossesMonthlyRow[];
  uaLossesRuMod?: () => UaLossesRuModMonthlyRow[];
  ruMod?: () => RuAdMonthlyRow[];
  ruAir?: () => RuAirAttacksMonthlyRow[];
  sbuAlfa?: () => SbuAlfaCounterRow[];
  rubikon?: () => RubikonCounterRow[];
  // Mediazona has two independent monthly queries — pass both; the fetcher
  // routes each metric to the right one by key.
  mediazonaRoles?: () => MediazonaRolesRow[];
  mediazonaEstimate?: () => MediazonaEstimateRow[];
}

// Long-table (period, category, value) → DailyDataPoint[] for one metric.
// Filters by category and groups by period (one row per period normally;
// latest wins if duplicated because of SBU Alfa's derive step). Inclusive
// YYYY-MM window. Shared by SBU Alfa and Rubikon, which store the same shape.
function pivotCounters(
  rows: Array<{ period: string; category: string; value: number }>,
  category: string,
  startMonth: string,
  endMonth: string,
): DailyDataPoint[] {
  const byPeriod = new Map<string, number>();
  for (const r of rows) {
    if (r.category !== category) continue;
    if (r.period < startMonth || r.period > endMonth) continue;
    byPeriod.set(r.period, typeof r.value === "number" ? r.value : 0);
  }
  return [...byPeriod.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, value, is_today: false }));
}

// Mediazona monthly rows carry `week` = "YYYY-MM-01" (the bucket month rolled
// up from weekly rows). Slice to "YYYY-MM" so the chart axis aligns with the
// other monthly sources.
function projectMediazona(
  rows: Array<{ week: string } & Record<string, unknown>>,
  key: string,
  startMonth: string,
  endMonth: string,
): DailyDataPoint[] {
  return rows
    .map((r) => ({ ...r, date: r.week.slice(0, 7) }))
    .filter((r) => r.date >= startMonth && r.date <= endMonth)
    .map((r) => {
      const raw = (r as Record<string, unknown>)[key];
      return {
        date: r.date,
        value: typeof raw === "number" ? raw : null,
        is_today: false,
      };
    });
}

function projectMonthly(
  rows: Array<{ date: string; is_current_month?: boolean } & Record<string, unknown>>,
  key: string,
  startMonth: string,
  endMonth: string,
): DailyDataPoint[] {
  // Inclusive window on the YYYY-MM string sort. Map MonthlyRow → the chart's
  // shared DailyDataPoint shape, carrying `is_current_month` through `is_today`
  // so the chart's "partial last period" dot logic works unchanged. Every
  // monthly hook is required to return `date` as YYYY-MM — we don't slice
  // here so a hook that breaks the contract fails loudly instead of being
  // papered over.
  return rows
    .filter((r) => r.date >= startMonth && r.date <= endMonth)
    .map((r) => {
      const raw = r[key];
      return {
        date: r.date,
        value: typeof raw === "number" ? raw : null,
        is_today: r.is_current_month === true,
      };
    });
}

export async function fetchCombinedMonthly(
  metrics: CombinedMetric[],
  months: MonthOption,
  endDate: string | undefined,
  queries: CombinedMonthlyQueries,
): Promise<Record<string, DailyDataPoint[]>> {
  const sources = new Set<MetricSource>(metrics.map((m) => m.source));
  const result: Record<string, DailyDataPoint[]> = {};

  const endMonth = monthOf(endDate ?? "");
  const startMonth = windowStartMonth(endMonth, months);

  const sbsRows = sources.has("sbs") && queries.sbs ? queries.sbs() : null;

  // One fetch per distinct sub-unit. `sources.has("sbs-unit")` is not enough
  // to know what to load — the unit is part of the metric, so a chart with
  // Fenix and Nemesis series needs two queries and a chart with two Fenix
  // metrics needs one.
  const unitRows = new Map<string, MonthlyRow[]>();
  if (queries.sbsUnits) {
    for (const slug of new Set(
      metrics.filter((m) => m.source === "sbs-unit" && m.unit).map((m) => m.unit as string),
    )) {
      unitRows.set(slug, queries.sbsUnits(slug));
    }
  }

  const ruLossesRows = sources.has("ru-losses") && queries.ruLosses ? queries.ruLosses() : null;
  const uaLossesRows = sources.has("ua-losses") && queries.uaLosses ? queries.uaLosses() : null;
  const uaLossesRuModRows = sources.has("ua-losses-ru-mod") && queries.uaLossesRuMod ? queries.uaLossesRuMod() : null;
  const ruModRows = sources.has("ru-airdef-mod") && queries.ruMod ? queries.ruMod() : null;
  const ruAirRows = sources.has("ru-air-attacks") && queries.ruAir ? queries.ruAir() : null;
  const sbuAlfaRows = sources.has("sbu-alfa") && queries.sbuAlfa ? queries.sbuAlfa() : null;
  const rubikonRows = sources.has("rubikon") && queries.rubikon ? queries.rubikon() : null;
  const mediazonaRolesRows = sources.has("mediazona-roles") && queries.mediazonaRoles ? queries.mediazonaRoles() : null;
  const mediazonaEstimateRows = sources.has("mediazona-estimate") && queries.mediazonaEstimate ? queries.mediazonaEstimate() : null;

  const gsuaRows = sources.has("gsua") && queries.gsua ? await queries.gsua() : null;

  for (const m of metrics) {
    if (m.source === "sbs" && sbsRows) result[m.id] = projectMonthly(sbsRows as unknown as Array<{ date: string; is_current_month?: boolean } & Record<string, unknown>>, m.key, startMonth, endMonth);
    else if (m.source === "sbs-unit" && m.unit && unitRows.has(m.unit)) result[m.id] = projectMonthly(unitRows.get(m.unit) as unknown as Array<{ date: string; is_current_month?: boolean } & Record<string, unknown>>, m.key, startMonth, endMonth);
    else if (m.source === "gsua" && gsuaRows) result[m.id] = projectMonthly(gsuaRows as unknown as Array<{ date: string; is_current_month?: boolean } & Record<string, unknown>>, m.key, startMonth, endMonth);
    else if (m.source === "ru-losses" && ruLossesRows) result[m.id] = projectMonthly(ruLossesRows as unknown as Array<{ date: string; is_current_month?: boolean } & Record<string, unknown>>, m.key, startMonth, endMonth);
    else if (m.source === "ua-losses" && uaLossesRows) result[m.id] = projectMonthly(uaLossesRows as unknown as Array<{ date: string; is_current_month?: boolean } & Record<string, unknown>>, m.key, startMonth, endMonth);
    else if (m.source === "ua-losses-ru-mod" && uaLossesRuModRows) result[m.id] = projectMonthly(uaLossesRuModRows as unknown as Array<{ date: string; is_current_month?: boolean } & Record<string, unknown>>, m.key, startMonth, endMonth);
    else if (m.source === "ru-airdef-mod" && ruModRows) result[m.id] = projectMonthly(ruModRows as unknown as Array<{ date: string; is_current_month?: boolean } & Record<string, unknown>>, m.key, startMonth, endMonth);
    else if (m.source === "ru-air-attacks" && ruAirRows) result[m.id] = projectMonthly(ruAirRows as unknown as Array<{ date: string; is_current_month?: boolean } & Record<string, unknown>>, m.key, startMonth, endMonth);
    else if (m.source === "sbu-alfa" && sbuAlfaRows) result[m.id] = pivotCounters(sbuAlfaRows, m.key, startMonth, endMonth);
    else if (m.source === "rubikon" && rubikonRows) result[m.id] = pivotCounters(rubikonRows, m.key, startMonth, endMonth);
    else if (m.source === "mediazona-roles" && mediazonaRolesRows) result[m.id] = projectMediazona(mediazonaRolesRows as unknown as Array<{ week: string } & Record<string, unknown>>, m.key, startMonth, endMonth);
    else if (m.source === "mediazona-estimate" && mediazonaEstimateRows) result[m.id] = projectMediazona(mediazonaEstimateRows as unknown as Array<{ week: string } & Record<string, unknown>>, m.key, startMonth, endMonth);
    else result[m.id] = [];
    // Extend each series' trailing tail to the chart's end month so a lagging
    // source visibly stops short instead of silently ending where its data does.
    result[m.id] = padTrailingMonthly(
      result[m.id],
      endMonth,
      (date) => ({ date, value: null, is_today: false }),
    );
  }
  return result;
}

export async function fetchCombinedDaily(
  metrics: CombinedMetric[],
  days: number,
  endDate: string | undefined,
  queries: CombinedQueries,
): Promise<Record<string, DailyDataPoint[]>> {
  const sources = new Set<MetricSource>(metrics.map((m) => m.source));
  const result: Record<string, DailyDataPoint[]> = {};

  // Fetch each source's rows at most once (one call per source even if many
  // metrics from it are selected).
  const sbsRows = sources.has("sbs") && queries.sbs ? queries.sbs(days, endDate) : null;
  const ruLossesRows = sources.has("ru-losses") && queries.ruLosses ? queries.ruLosses(days, endDate) : null;
  const uaLossesRows = sources.has("ua-losses") && queries.uaLosses ? queries.uaLosses(days, endDate) : null;
  const uaLossesRuModRows = sources.has("ua-losses-ru-mod") && queries.uaLossesRuMod ? queries.uaLossesRuMod(days, endDate) : null;
  const ruModRows = sources.has("ru-airdef-mod") && queries.ruMod ? queries.ruMod(days, endDate) : null;
  const ruAirRows = sources.has("ru-air-attacks") && queries.ruAir ? queries.ruAir(days, endDate) : null;
  const gsuaRows = sources.has("gsua") && queries.gsua ? await queries.gsua(days, endDate) : null;

  const endDateResolved = resolvedEndDate(endDate);
  const startDateResolved = windowStartDate(endDateResolved, days);
  for (const m of metrics) {
    if (m.source === "sbs" && sbsRows) result[m.id] = project(sbsRows as unknown as Array<{ date: string; is_today?: boolean } & Record<string, unknown>>, m.key);
    else if (m.source === "gsua" && gsuaRows) result[m.id] = project(gsuaRows as unknown as Array<{ date: string; is_today?: boolean } & Record<string, unknown>>, m.key);
    else if (m.source === "ru-losses" && ruLossesRows) result[m.id] = project(ruLossesRows as unknown as Array<{ date: string; is_today?: boolean } & Record<string, unknown>>, m.key);
    else if (m.source === "ua-losses" && uaLossesRows) result[m.id] = project(uaLossesRows as unknown as Array<{ date: string; is_today?: boolean } & Record<string, unknown>>, m.key);
    else if (m.source === "ua-losses-ru-mod" && uaLossesRuModRows) result[m.id] = project(uaLossesRuModRows as unknown as Array<{ date: string; is_today?: boolean } & Record<string, unknown>>, m.key);
    else if (m.source === "ru-airdef-mod" && ruModRows) result[m.id] = project(ruModRows as unknown as Array<{ date: string; is_today?: boolean } & Record<string, unknown>>, m.key);
    else if (m.source === "ru-air-attacks" && ruAirRows) result[m.id] = project(ruAirRows as unknown as Array<{ date: string; is_today?: boolean } & Record<string, unknown>>, m.key);
    else result[m.id] = [];
    // Fill the full window: leading + internal + trailing gaps become explicit
    // null rows so a lagging source (or a mid-window outage) renders as a
    // visible break rather than getting bridged by recharts' category axis.
    result[m.id] = fillDailyRange(result[m.id], startDateResolved, endDateResolved);
  }
  return result;
}

// The weekly grain's queries: every daily query (the daily sources are summed
// into weeks), plus the one source that is natively weekly.
export interface CombinedWeeklyQueries extends CombinedQueries {
  zelensky?: () => ZelenskyWeekRow[];
}

export async function fetchCombinedWeekly(
  metrics: CombinedMetric[],
  weeks: WeekOption,
  endDate: string | undefined,
  queries: CombinedWeeklyQueries,
): Promise<Record<string, DailyDataPoint[]>> {
  const end = resolvedEndDate(endDate);
  const { firstMonday, lastMonday, days } = weeklyWindow(end, weeks);
  const result: Record<string, DailyDataPoint[]> = {};

  // Daily sources: fetch the window's days exactly as a daily chart would
  // (gap-filled with nulls), then roll each series up into weeks.
  const fromDaily = metrics.filter((m) => m.source !== "zelensky");
  if (fromDaily.length) {
    const daily = await fetchCombinedDaily(fromDaily, days, endDate, queries);
    for (const m of fromDaily) result[m.id] = aggregateWeekly(daily[m.id] ?? [], firstMonday, end);
  }

  // The weekly tally: one row per ISO week already (the DB's `weekly` view),
  // keyed by its Monday. A week without a tally — or whose post didn't name
  // this weapon — is a gap, not 0. The week in progress never has a tally
  // (it is posted at the week's end), so nothing here is `is_today`.
  const zRows = metrics.some((m) => m.source === "zelensky") && queries.zelensky ? queries.zelensky() : null;
  if (zRows) {
    const byMonday = new Map(zRows.map((r) => [r.period_start, r]));
    const mondays = mondaysBetween(firstMonday, lastMonday);
    for (const m of metrics) {
      if (m.source !== "zelensky") continue;
      const key = m.key as "drones" | "bombs" | "missiles";
      result[m.id] = mondays.map((date) => ({
        date,
        value: byMonday.get(date)?.[key] ?? null,
        is_today: false,
      }));
    }
  }

  for (const m of metrics) result[m.id] ??= [];
  return result;
}

export async function fetchCombinedGlobalStats(
  needed: Set<MetricSource>,
  queries: CombinedGlobalQueries,
): Promise<GlobalStatsBundle> {
  const bundle: GlobalStatsBundle = {};
  if (needed.has("sbs") && queries.sbs) bundle.sbs = queries.sbs();
  if (needed.has("ru-losses") && queries.ruLosses) bundle.ruLosses = queries.ruLosses();
  if (needed.has("ua-losses") && queries.uaLosses) bundle.uaLosses = queries.uaLosses();
  if (needed.has("ua-losses-ru-mod") && queries.uaLossesRuMod) bundle.uaLossesRuMod = queries.uaLossesRuMod();
  if (needed.has("ru-airdef-mod") && queries.ruMod) bundle.ruMod = queries.ruMod();
  if (needed.has("ru-air-attacks") && queries.ruAir) bundle.ruAir = queries.ruAir();
  if (needed.has("gsua") && queries.gsua) bundle.gsua = await queries.gsua();
  return bundle;
}

// Extract per-metric whole-dataset stats from a bundle. Returns null when the
// source isn't loaded yet — caller leaves globalMax/median/total undefined so
// the chart falls back to window scope.
export function statsForMetric(
  m: CombinedMetric,
  bundle: GlobalStatsBundle,
): Stat | null {
  switch (m.source) {
    case "sbs":
      return bundle.sbs?.[m.key as keyof GlobalStats] ?? null;
    case "gsua":
      return bundle.gsua?.[m.key as keyof GsuaGlobalStats] ?? null;
    case "ru-losses":
      return bundle.ruLosses?.[m.key as keyof RuLossesGlobalStats] ?? null;
    case "ua-losses":
      return bundle.uaLosses?.[m.key as keyof UaLossesGlobalStats] ?? null;
    case "ua-losses-ru-mod":
      return bundle.uaLossesRuMod?.[m.key as keyof UaLossesRuModGlobalStats] ?? null;
    case "ru-airdef-mod":
      return (bundle.ruMod as Record<string, Stat> | undefined)?.[m.key] ?? null;
    case "ru-air-attacks": {
      // m.key is "<category>_launched" or "<category>_intercepted"; split.
      if (!bundle.ruAir) return null;
      const i = m.key.lastIndexOf("_");
      if (i < 0) return null;
      const cat = m.key.slice(0, i);
      const dir = m.key.slice(i + 1) as "launched" | "intercepted";
      const catStats = bundle.ruAir[cat as keyof RuAirAttacksGlobalStats];
      return catStats?.[dir] ?? null;
    }
    default:
      return null;
  }
}

