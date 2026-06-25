import { useState, useMemo, useEffect } from "react";
import { Temporal } from "temporal-polyfill";
import { useRuAirAttacksDatabaseContext } from "@/context/useRuAirAttacksDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { DailyLineChart } from "@/components/DailyLineChart";
import { DataWindow } from "@/components/DataWindow";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { WeekdayMultiSelect } from "@/components/WeekdayMultiSelect";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { DateNav } from "@/components/DateNav";
import { DayRangeSelect } from "@/components/DayRangeSelect";
import { DAY_OPTIONS, type DayOption, windowStartDate, parseDaysParam } from "@/utils/dayRange";
import { fillDailyRange, resolvedEndDate } from "@/utils/padTrailing";
import {
  ATTACK_DB_CATEGORIES,
  ATTACK_CATEGORY_LABELS,
  FEATURED_MODELS,
  type AttackCategoryKey,
  type AttackDbCategory,
  type ModelBreakdownEntry,
  type RuAirAttacksDailyRow,
  type RuAirAttacksGlobalStats,
  type RuAirAttacksModelDailyRow,
} from "@/types";
import { FONTS } from "@/theme";


function parseWeekdays(raw: string | null): number[] {
  if (!raw) return [];
  const parsed = raw.split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return [...new Set(parsed)].sort((a, b) => a - b);
}

function parseDate(raw: string | null): string {
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

function getUrlParams() {
  const p = new URLSearchParams(window.location.search);
  return {
    days: parseDaysParam(p.get("days")),
    weekdays: parseWeekdays(p.get("weekdays")),
    date: parseDate(p.get("date")),
  };
}

function setUrlParams(params: Record<string, string>) {
  const p = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v === "") p.delete(k);
    else p.set(k, v);
  }
  window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
}

interface Props {
  refreshKey?: number;
}

export function RuAirAttacksDailyPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const { loadState, error, queryDaily, queryGlobalStats, queryDailyByModel, queryDailyBreakdownByCategory, queryDailyAggBreakdown, queryDataWindow } = useRuAirAttacksDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);

  const initial = useMemo(() => getUrlParams(), []);
  const [days, setDays] = useState<DayOption>(initial.days);
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>(initial.weekdays);
  const [selectedDate, setSelectedDate] = useState<string>(initial.date);

  const [rows, setRows] = useState<RuAirAttacksDailyRow[]>([]);
  const [modelRows, setModelRows] = useState<Record<string, RuAirAttacksModelDailyRow[]>>({});
  const [breakdowns, setBreakdowns] = useState<Record<AttackDbCategory, Map<string, ModelBreakdownEntry[]>>>({} as Record<AttackDbCategory, Map<string, ModelBreakdownEntry[]>>);
  const [allBreakdown, setAllBreakdown] = useState<Map<string, ModelBreakdownEntry[]>>(new Map());
  const [globalStats, setGlobalStats] = useState<RuAirAttacksGlobalStats>({} as RuAirAttacksGlobalStats);
  const [hasData, setHasData] = useState(false);

  const updateDays = (d: DayOption) => { setDays(d); setUrlParams({ days: String(d) }); };
  const updateDate = (d: string) => { setSelectedDate(d); setUrlParams({ date: d }); };
  const updateWeekdays = (next: number[]) => {
    setSelectedWeekdays(next);
    setUrlParams({ weekdays: next.join(",") });
  };

  useEffect(() => {
    if (loadState === "ready") setGlobalStats(queryGlobalStats());
  }, [loadState, queryGlobalStats, refreshKey]);

  useEffect(() => {
    if (loadState === "ready") {
      setRows(queryDaily(days, selectedDate || undefined));
      const m: Record<string, RuAirAttacksModelDailyRow[]> = {};
      for (const model of FEATURED_MODELS) {
        m[model] = queryDailyByModel(model, days, selectedDate || undefined);
      }
      setModelRows(m);
      const b = {} as Record<AttackDbCategory, Map<string, ModelBreakdownEntry[]>>;
      for (const cat of ATTACK_DB_CATEGORIES) {
        b[cat] = queryDailyBreakdownByCategory(cat, days, selectedDate || undefined);
      }
      setBreakdowns(b);
      setAllBreakdown(queryDailyAggBreakdown(days, selectedDate || undefined));
      setHasData(true);
    }
  }, [loadState, days, selectedDate, queryDaily, queryDailyByModel, queryDailyBreakdownByCategory, queryDailyAggBreakdown, refreshKey]);

  const todayDow = new Date(new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }) + "T12:00:00").getDay();
  const maxSelectableDate = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

  const shiftSelectedDate = (delta: number) => {
    const base = selectedDate || Temporal.Now.plainDateISO("Europe/Kyiv").toString();
    const next = Temporal.PlainDate.from(base).add({ days: delta }).toString();
    if (next > maxSelectableDate) return;
    updateDate(next);
  };
  const canGoNext = selectedDate !== "" && selectedDate < maxSelectableDate;

  const filteredRows = useMemo(() => {
    if (selectedDate) {
      const startDate = windowStartDate(selectedDate, days);
      return rows.filter((row) => row.date >= startDate && row.date <= selectedDate);
    }
    if (selectedWeekdays.length === 0) return rows;
    return rows.filter((row) => selectedWeekdays.includes(new Date(row.date + "T12:00:00").getDay()));
  }, [rows, selectedWeekdays, selectedDate, days]);

  const endDate = resolvedEndDate(selectedDate);
  const startDate = windowStartDate(endDate, days);
  // Weekday filter is intentional — don't pad dates that the user filtered out.
  const keepDate = selectedWeekdays.length === 0
    ? undefined
    : (iso: string) => selectedWeekdays.includes(new Date(iso + "T12:00:00").getDay());
  const series = (key: AttackCategoryKey, metric: "launched" | "intercepted") =>
    fillDailyRange(
      filteredRows.map((d) => ({
        date: d.date,
        value: typeof d[`${key}_${metric}`] === "number" ? (d[`${key}_${metric}`] as number) : null,
        is_today: d.is_today,
      })),
      startDate,
      endDate,
      { keepDate },
    );

  const filterModelRows = (mrows: RuAirAttacksModelDailyRow[]) => {
    if (selectedDate) return mrows; // SQL already bounded the window
    if (selectedWeekdays.length === 0) return mrows;
    return mrows.filter((r) => selectedWeekdays.includes(new Date(r.date + "T12:00:00").getDay()));
  };
  const modelSeries = (model: string, metric: "launched" | "intercepted") =>
    fillDailyRange(
      filterModelRows(modelRows[model] ?? []).map((r) => ({
        date: r.date,
        value: r[metric],
        is_today: r.is_today,
      })),
      startDate,
      endDate,
      { keepDate },
    );

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
          Daily Russian Missile &amp; UAV Attacks
        </h1>
        <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
          Launched vs intercepted, per Ukrainian Air Force reports · source: piterfm / Kaggle <a target="_blank" href="https://www.kaggle.com/datasets/piterfm/massive-missile-attacks-on-ukraine" rel="nofollow external">"Massive Missile Attacks on Ukraine"</a> · Updated approximately once per week
        </p>
        <DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="ru-air-attacks" />
      </div>
      <div className="page-controls-sticky" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}>
        <DayRangeSelect options={DAY_OPTIONS} value={days} onChange={updateDays} />
        <DateNav value={selectedDate} max={maxSelectableDate} onChange={updateDate} onShift={shiftSelectedDate} canGoNext={canGoNext} />
        <WeekdayMultiSelect selected={selectedWeekdays} onChange={updateWeekdays} todayDow={todayDow} />
        <StatScopeToggle />
      </div>

      {loadState === "loading" && !hasData && <LoadingScreen message="Loading RU air-attacks database…" />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {(loadState === "ready" || hasData) && (
        <ChartGrid>
          {/* Combined: total launched per day (single line), full width.
              Tooltip carries a per-category breakdown for the hovered date. */}
          <DailyLineChart
            key="all"
            title="All — Drones + Missiles · Launched"
            data={series("all", "launched")}
            globalMax={globalStats.all?.launched.max ?? 0}
            globalMedian={globalStats.all?.launched.median ?? 0}
            globalTotal={globalStats.all?.launched.total ?? 0}
            breakdownByDate={allBreakdown}
            breakdownHeader="Category"
            wfull
          />
          {/* Per category: launched (area) with intercepted as a filled subset.
              Tooltip carries a top-N model breakdown for the hovered date. */}
          {ATTACK_DB_CATEGORIES.map((cat) => (
            <DailyLineChart
              key={cat}
              title={ATTACK_CATEGORY_LABELS[cat]}
              data={series(cat, "launched")}
              data2={series(cat, "intercepted")}
              primaryLabel="Launched"
              label2="Intercepted"
              pairMode="subset"
              globalMax={globalStats[cat]?.launched.max ?? 0}
              globalMedian={globalStats[cat]?.launched.median ?? 0}
              globalTotal={globalStats[cat]?.launched.total ?? 0}
              globalMax2={globalStats[cat]?.intercepted.max ?? 0}
              globalMedian2={globalStats[cat]?.intercepted.median ?? 0}
              globalTotal2={globalStats[cat]?.intercepted.total ?? 0}
              breakdownByDate={breakdowns[cat]}
              wfull={false}
            />
          ))}
          {/* Per featured model: bundled "X and Y" rows aren't counted here, so
              standalone-model attribution may read low when piterfm reports a
              mixed-strike row instead of breaking it apart. Reference-line
              stats are window-scoped (no all-time bundle is precomputed for
              per-model series). */}
          {FEATURED_MODELS.map((model) => {
            const ld = modelSeries(model, "launched");
            const id = modelSeries(model, "intercepted");
            const stats = (xs: typeof ld) => {
              const vs = xs.map((p) => p.value).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
              return {
                max: vs.length ? vs[vs.length - 1] : 0,
                median: vs.length ? vs[Math.floor(vs.length / 2)] : 0,
                total: vs.reduce((s, n) => s + n, 0),
              };
            };
            const ls = stats(ld);
            const is = stats(id);
            return (
              <DailyLineChart
                key={`model-${model}`}
                title={model}
                data={ld}
                data2={id}
                primaryLabel="Launched"
                label2="Intercepted"
                pairMode="subset"
                globalMax={ls.max}
                globalMedian={ls.median}
                globalTotal={ls.total}
                globalMax2={is.max}
                globalMedian2={is.median}
                globalTotal2={is.total}
                wfull={false}
              />
            );
          })}
        </ChartGrid>
      )}
    </div>
  );
}
