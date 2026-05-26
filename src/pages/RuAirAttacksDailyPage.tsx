import { useState, useMemo, useEffect } from "react";
import { Temporal } from "temporal-polyfill";
import { useRuAirAttacksDatabaseContext } from "@/context/useRuAirAttacksDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { DailyLineChart } from "@/components/DailyLineChart";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { WeekdayMultiSelect } from "@/components/WeekdayMultiSelect";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { DateNav } from "@/components/DateNav";
import { DayRangeSelect } from "@/components/DayRangeSelect";
import { DAY_OPTIONS, type DayOption } from "@/utils/dayRange";
import {
  ATTACK_DB_CATEGORIES,
  ATTACK_CATEGORY_LABELS,
  type AttackCategoryKey,
  type RuAirAttacksDailyRow,
  type RuAirAttacksGlobalStats,
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

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function getUrlParams() {
  const p = new URLSearchParams(window.location.search);
  const d = Number(p.get("days"));
  return {
    days: (DAY_OPTIONS as readonly number[]).includes(d) ? (d as DayOption) : 30,
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
  const { loadState, error, queryDaily, queryGlobalStats } = useRuAirAttacksDatabaseContext();

  const initial = useMemo(() => getUrlParams(), []);
  const [days, setDays] = useState<DayOption>(initial.days);
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>(initial.weekdays);
  const [selectedDate, setSelectedDate] = useState<string>(initial.date);

  const [rows, setRows] = useState<RuAirAttacksDailyRow[]>([]);
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
      setHasData(true);
    }
  }, [loadState, days, selectedDate, queryDaily, refreshKey]);

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
      const startDate = shiftDate(selectedDate, -days);
      return rows.filter((row) => row.date >= startDate && row.date <= selectedDate);
    }
    if (selectedWeekdays.length === 0) return rows;
    return rows.filter((row) => selectedWeekdays.includes(new Date(row.date + "T12:00:00").getDay()));
  }, [rows, selectedWeekdays, selectedDate, days]);

  const series = (key: AttackCategoryKey, metric: "launched" | "intercepted") =>
    filteredRows.map((d) => ({
      date: d.date,
      value: typeof d[`${key}_${metric}`] === "number" ? (d[`${key}_${metric}`] as number) : null,
      is_today: d.is_today,
    }));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
            Daily Russian Missile &amp; UAV Attacks
          </h1>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
            Launched vs intercepted, per Ukrainian Air Force reports · source: piterfm / Kaggle "Massive Missile Attacks on Ukraine" · {new Date().toDateString()}
          </p>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <DayRangeSelect options={DAY_OPTIONS} value={days} onChange={updateDays} />
          <DateNav value={selectedDate} max={maxSelectableDate} onChange={updateDate} onShift={shiftSelectedDate} canGoNext={canGoNext} />
          <WeekdayMultiSelect selected={selectedWeekdays} onChange={updateWeekdays} todayDow={todayDow} />
          <StatScopeToggle />
        </div>
      </div>

      {loadState === "loading" && !hasData && <LoadingScreen message="Loading RU air-attacks database…" />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {(loadState === "ready" || hasData) && (
        <ChartGrid>
          {/* Combined: total launched per day (single line), full width. */}
          <DailyLineChart
            key="all"
            title="All — Drones + Missiles · Launched"
            data={series("all", "launched")}
            globalMax={globalStats.all?.launched.max ?? 0}
            globalMedian={globalStats.all?.launched.median ?? 0}
            wfull
          />
          {/* Per category: launched (area) with intercepted as a filled subset. */}
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
              globalMax2={globalStats[cat]?.intercepted.max ?? 0}
              globalMedian2={globalStats[cat]?.intercepted.median ?? 0}
              wfull={false}
            />
          ))}
        </ChartGrid>
      )}
    </div>
  );
}
