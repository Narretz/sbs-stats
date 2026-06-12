import { useState, useMemo, useEffect } from "react";
import { Temporal } from "temporal-polyfill";
import { useGsuaDatabaseContext } from "@/context/useGsuaDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { HourlyLineChart, type TooltipSortMode } from "@/components/HourlyLineChart";
import { DataWindow } from "@/components/DataWindow";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { WeekdayMultiSelect } from "@/components/WeekdayMultiSelect";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { DateNav } from "@/components/DateNav";
import { DayRangeSelect } from "@/components/DayRangeSelect";
import { TooltipSortSelect } from "@/components/TooltipSortSelect";
import { DAY_OPTIONS, type DayOption, windowStartDate } from "@/utils/dayRange";
import {
  GSUA_METRIC_KEYS,
  GSUA_METRIC_LABELS,
  type GsuaDailyRow,
  type GsuaMetricKey,
  type GsuaDirectionRow,
  type EodEstimate,
} from "@/types";
import type { DailyDaySeries } from "@/types";
import { FONTS } from "@/theme";

const SORT_OPTIONS: TooltipSortMode[] = ["value", "date"];

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
  const d = Number(p.get("days"));
  const s = p.get("sort");
  return {
    days: (DAY_OPTIONS as readonly number[]).includes(d) ? (d as DayOption) : 30,
    sort: (SORT_OPTIONS.includes(s as TooltipSortMode) ? s : "value") as TooltipSortMode,
    weekdays: parseWeekdays(p.get("weekdays")),
    date: parseDate(p.get("date")),
    direction: p.get("direction") ?? "",
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

// Snapshot timestamp like "2026-05-23T08:00:00" → hour 8.
function hourOf(snapshot_at: string): number {
  const m = /T(\d{2})/.exec(snapshot_at);
  return m ? parseInt(m[1], 10) : 0;
}
// snapshot_at can fall the morning *after* report-date — that's an end-of-day
// total. Anchor it to hour 23 of the report-date so it stays in-frame.
function effectiveHour(date: string, snapshot_at: string): number {
  if (!snapshot_at) return 0;
  const snapDate = snapshot_at.slice(0, 10);
  if (snapDate > date) return 23;
  return Math.min(23, Math.max(0, hourOf(snapshot_at)));
}

interface Props {
  refreshKey?: number;
}

export function GsuaHourlyPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const {
    loadState, error, querySnapshots, queryDirectionList, queryDirectionSnapshots, queryEodProjection, queryDataWindow,
  } = useGsuaDatabaseContext();
  const [dataWindow, setDataWindow] = useState<{ minDate: string | null; maxDate: string | null; latestSnapshotAt: string | null }>({ minDate: null, maxDate: null, latestSnapshotAt: null });
  useEffect(() => { queryDataWindow().then(setDataWindow); }, [queryDataWindow]);

  const initial = useMemo(() => getUrlParams(), []);
  const [days, setDays] = useState<DayOption>(initial.days);
  const [tooltipSort, setTooltipSort] = useState<TooltipSortMode>(initial.sort);
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>(initial.weekdays);
  const [selectedDate, setSelectedDate] = useState<string>(initial.date);
  const [selectedDirection, setSelectedDirection] = useState<string>(initial.direction);

  const [rows, setRows] = useState<GsuaDailyRow[]>([]);
  const [directionRows, setDirectionRows] = useState<GsuaDirectionRow[]>([]);
  const [directionList, setDirectionList] = useState<string[]>([]);
  const [eod, setEod] = useState<Partial<Record<GsuaMetricKey, EodEstimate>>>({});
  const [hasData, setHasData] = useState(false);

  const updateDays = (d: DayOption) => { setDays(d); setUrlParams({ days: String(d) }); };
  const updateDate = (d: string) => { setSelectedDate(d); setUrlParams({ date: d }); };
  const updateSort = (s: TooltipSortMode) => { setTooltipSort(s); setUrlParams({ sort: s }); };
  const updateWeekdays = (next: number[]) => {
    setSelectedWeekdays(next);
    setUrlParams({ weekdays: next.join(",") });
  };
  const updateDirection = (dir: string) => {
    setSelectedDirection(dir);
    setUrlParams({ direction: dir });
  };

  const maxSelectableDate = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
  const shiftSelectedDate = (delta: number) => {
    const base = selectedDate || Temporal.Now.plainDateISO("Europe/Kyiv").toString();
    const next = Temporal.PlainDate.from(base).add({ days: delta }).toString();
    if (next > maxSelectableDate) return;
    updateDate(next);
  };
  const canGoNext = selectedDate !== "" && selectedDate < maxSelectableDate;

  useEffect(() => {
    if (loadState !== "ready") return;
    let cancelled = false;
    (async () => {
      const [dl, ep] = await Promise.all([queryDirectionList(), queryEodProjection()]);
      if (cancelled) return;
      setDirectionList(dl);
      setEod(ep);
    })();
    return () => { cancelled = true; };
  }, [loadState, queryDirectionList, queryEodProjection, refreshKey]);

  useEffect(() => {
    if (loadState !== "ready") return;
    let cancelled = false;
    (async () => {
      const snaps = await querySnapshots(days, selectedDate || undefined);
      if (cancelled) return;
      setRows(snaps);
      if (selectedDirection) {
        const dir = await queryDirectionSnapshots(selectedDirection, days, selectedDate || undefined);
        if (cancelled) return;
        setDirectionRows(dir);
      } else {
        setDirectionRows([]);
      }
      setHasData(true);
    })();
    return () => { cancelled = true; };
  }, [loadState, days, selectedDate, selectedDirection, querySnapshots, queryDirectionSnapshots, refreshKey]);

  const todayDow = new Date(new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }) + "T12:00:00").getDay();

  const filteredRows = useMemo(() => {
    let r = rows;
    if (selectedDate) {
      const startDate = windowStartDate(selectedDate, days);
      r = r.filter((row) => row.date >= startDate && row.date <= selectedDate);
    } else if (selectedWeekdays.length > 0) {
      r = r.filter((row) => selectedWeekdays.includes(new Date(row.date + "T12:00:00").getDay()));
    }
    // Keep telegram-source rows preferentially: if telegram exists for a (date,snap),
    // drop facebook duplicates. Identify by (date, snapshot_at).
    const tgKeys = new Set<string>();
    for (const row of r) if (row.source === "telegram") tgKeys.add(`${row.date}|${row.snapshot_at}`);
    return r.filter((row) => row.source === "telegram" || !tgKeys.has(`${row.date}|${row.snapshot_at}`));
  }, [rows, selectedDate, selectedWeekdays, days]);

  const makeDataset = (key: GsuaMetricKey): DailyDaySeries[] => {
    const map = new Map<string, DailyDaySeries>();
    for (const row of filteredRows) {
      if (!map.has(row.date)) map.set(row.date, { date: row.date, is_today: row.is_today, points: [] });
      map.get(row.date)!.points.push({
        hour: effectiveHour(row.date, row.snapshot_at),
        value: typeof row[key] === "number" ? (row[key] as number) : null,
      });
    }
    for (const s of map.values()) s.points.sort((a, b) => a.hour - b.hour);
    return Array.from(map.values()).sort((a, b) => {
      if (a.is_today) return 1;
      if (b.is_today) return -1;
      return a.date.localeCompare(b.date);
    });
  };

  const chartStats = useMemo(() => {
    const result = {} as Record<GsuaMetricKey, { max: number; median: number }>;
    // Use the daily-final values (last snapshot per date) to size the y-axis.
    const lastByDate = new Map<string, GsuaDailyRow>();
    for (const row of filteredRows) {
      const cur = lastByDate.get(row.date);
      if (!cur || row.snapshot_at > cur.snapshot_at) lastByDate.set(row.date, row);
    }
    const deduped = Array.from(lastByDate.values());
    for (const key of GSUA_METRIC_KEYS) {
      const vals = deduped
        .map((r) => r[key])
        .filter((v): v is number => typeof v === "number")
        .sort((a, b) => a - b);
      result[key] = {
        max: vals.length ? vals[vals.length - 1] : 0,
        median: vals.length ? vals[Math.floor(vals.length / 2)] : 0,
      };
    }
    return result;
  }, [filteredRows]);

  // Direction view: per-snapshot attacks/ongoing, telegram-preferred dedup, +
  // weekday / date-window filters mirroring the aggregate view.
  const filteredDirectionRows = useMemo(() => {
    let r = directionRows;
    if (selectedDate) {
      const startDate = windowStartDate(selectedDate, days);
      r = r.filter((row) => row.date >= startDate && row.date <= selectedDate);
    } else if (selectedWeekdays.length > 0) {
      r = r.filter((row) => selectedWeekdays.includes(new Date(row.date + "T12:00:00").getDay()));
    }
    return r;
  }, [directionRows, selectedDate, selectedWeekdays, days]);

  const directionSeries = (which: "attacks" | "ongoing"): DailyDaySeries[] => {
    const map = new Map<string, DailyDaySeries>();
    for (const row of filteredDirectionRows) {
      if (!map.has(row.date)) map.set(row.date, { date: row.date, is_today: row.is_today, points: [] });
      map.get(row.date)!.points.push({
        hour: effectiveHour(row.date, row.snapshot_at),
        value: typeof row[which] === "number" ? (row[which] as number) : null,
      });
    }
    for (const s of map.values()) s.points.sort((a, b) => a.hour - b.hour);
    return Array.from(map.values()).sort((a, b) => {
      if (a.is_today) return 1;
      if (b.is_today) return -1;
      return a.date.localeCompare(b.date);
    });
  };

  const directionStats = useMemo(() => {
    const peakByDate = new Map<string, { attacks: number | null; ongoing: number | null }>();
    for (const row of filteredDirectionRows) {
      const cur = peakByDate.get(row.date) ?? { attacks: null, ongoing: null };
      if (typeof row.attacks === "number" && (cur.attacks ?? -1) < row.attacks) cur.attacks = row.attacks;
      if (typeof row.ongoing === "number" && (cur.ongoing ?? -1) < row.ongoing) cur.ongoing = row.ongoing;
      peakByDate.set(row.date, cur);
    }
    const stat = (vals: (number | null)[]) => {
      const xs = vals.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
      return {
        max: xs.length ? xs[xs.length - 1] : 0,
        median: xs.length ? xs[Math.floor(xs.length / 2)] : 0,
      };
    };
    const peaks = Array.from(peakByDate.values());
    return {
      attacks: stat(peaks.map((p) => p.attacks)),
      ongoing: stat(peaks.map((p) => p.ongoing)),
    };
  }, [filteredDirectionRows]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
            Hourly Combat Stats {selectedDirection ? `— ${selectedDirection}` : ""} - GSUA
          </h1>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
            Each line = one day · X-axis = hour-of-snapshot · GS posts run cumulative totals throughout the day. Via Telegram @GeneralStaffZSU.
          </p>
          <DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="gsua" latestSnapshotAt={dataWindow.latestSnapshotAt} />
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <DayRangeSelect options={DAY_OPTIONS} value={days} onChange={updateDays} />
          <DateNav value={selectedDate} max={maxSelectableDate} onChange={updateDate} onShift={shiftSelectedDate} canGoNext={canGoNext} />
          <WeekdayMultiSelect selected={selectedWeekdays} onChange={updateWeekdays} todayDow={todayDow} />
      <span style={{ fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted, letterSpacing: "0.04em" }}>
        Direction
      </span>
          <select
            data-testid="direction-picker"
            value={selectedDirection}
            onChange={(e) => updateDirection(e.target.value)}
            style={{
              background: selectedDirection ? t.primary : t.bgAlt,
              color: selectedDirection ? "#fff" : t.textMuted,
              border: `1px solid ${selectedDirection ? t.primary : t.border}`,
              borderRadius: 4, padding: "5px 8px",
              fontFamily: FONTS.mono, fontSize: 11, cursor: "pointer",
            }}
          >
            <option value="">All Ukraine (overview)</option>
            {directionList.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <StatScopeToggle />
          <TooltipSortSelect value={tooltipSort} onChange={updateSort} />
        </div>
      </div>

      {loadState === "loading" && !hasData && <LoadingScreen message="Loading GSUA database…" />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {(loadState === "ready" || hasData) && !selectedDirection && (
        <ChartGrid>
          {GSUA_METRIC_KEYS.map((k) => (
            <HourlyLineChart
              key={k}
              title={GSUA_METRIC_LABELS[k]}
              data={makeDataset(k)}
              globalMax={chartStats[k]?.max ?? 0}
              globalMedian={chartStats[k]?.median ?? 0}
              wfull={k === "combat_engagements"}
              tooltipSort={tooltipSort}
              highlight={!!selectedDate}
              selectedDate={selectedDate}
              eod={eod[k] ?? null}
            />
          ))}
        </ChartGrid>
      )}
      {(loadState === "ready" || hasData) && selectedDirection && (
        <ChartGrid>
          <HourlyLineChart
            title={`Attacks · ${selectedDirection}`}
            data={directionSeries("attacks")}
            globalMax={directionStats.attacks.max}
            globalMedian={directionStats.attacks.median}
            wfull={false}
            tooltipSort={tooltipSort}
            highlight={!!selectedDate}
            selectedDate={selectedDate}
          />
          <HourlyLineChart
            title={`Ongoing · ${selectedDirection}`}
            data={directionSeries("ongoing")}
            globalMax={directionStats.ongoing.max}
            globalMedian={directionStats.ongoing.median}
            wfull={false}
            tooltipSort={tooltipSort}
            highlight={!!selectedDate}
            selectedDate={selectedDate}
          />
        </ChartGrid>
      )}
    </div>
  );
}
