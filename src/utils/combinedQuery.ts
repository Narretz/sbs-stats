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
  GsuaDailyRow,
  RuAdDailyRow,
  RuAirAttacksDailyRow,
  RuLossesDailyRow,
} from "@/types";
import type { CombinedMetric, MetricSource } from "@/utils/combinedMetrics";

export interface CombinedQueries {
  sbs?: (days: number, endDate?: string) => DailyRow[];
  gsua?: (days: number, endDate?: string) => Promise<GsuaDailyRow[]>;
  ruLosses?: (days: number, endDate?: string) => RuLossesDailyRow[];
  ruMod?: (days: number, endDate?: string) => RuAdDailyRow[];
  ruAir?: (days: number, endDate?: string) => RuAirAttacksDailyRow[];
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
  const ruModRows = sources.has("ru-airdef-mod") && queries.ruMod ? queries.ruMod(days, endDate) : null;
  const ruAirRows = sources.has("ru-air-attacks") && queries.ruAir ? queries.ruAir(days, endDate) : null;
  const gsuaRows = sources.has("gsua") && queries.gsua ? await queries.gsua(days, endDate) : null;

  for (const m of metrics) {
    if (m.source === "sbs" && sbsRows) result[m.id] = project(sbsRows as unknown as Array<{ date: string; is_today?: boolean } & Record<string, unknown>>, m.key);
    else if (m.source === "gsua" && gsuaRows) result[m.id] = project(gsuaRows as unknown as Array<{ date: string; is_today?: boolean } & Record<string, unknown>>, m.key);
    else if (m.source === "ru-losses" && ruLossesRows) result[m.id] = project(ruLossesRows as unknown as Array<{ date: string; is_today?: boolean } & Record<string, unknown>>, m.key);
    else if (m.source === "ru-airdef-mod" && ruModRows) result[m.id] = project(ruModRows as unknown as Array<{ date: string; is_today?: boolean } & Record<string, unknown>>, m.key);
    else if (m.source === "ru-air-attacks" && ruAirRows) result[m.id] = project(ruAirRows as unknown as Array<{ date: string; is_today?: boolean } & Record<string, unknown>>, m.key);
    else result[m.id] = [];
  }
  return result;
}
