import { useState, useMemo, useEffect } from "react";
import { Temporal } from "temporal-polyfill";
import { useGsuaDatabaseContext } from "@/context/useGsuaDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { DailyLineChart } from "@/components/DailyLineChart";
import { DirectionCoverageChart } from "@/components/DirectionCoverageChart";
import { DataWindow } from "@/components/DataWindow";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { WeekdayMultiSelect } from "@/components/WeekdayMultiSelect";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { DateNav } from "@/components/DateNav";
import { DayRangeSelect } from "@/components/DayRangeSelect";
import { DAY_OPTIONS, type DayOption, windowStartDate, parseDaysParam } from "@/utils/dayRange";
import { fillDailyRange, resolvedEndDate } from "@/utils/padTrailing";
import {
  GSUA_METRIC_KEYS,
  GSUA_METRIC_LABELS,
  type GsuaDailyRow,
  type GsuaDirectionRow,
  type GsuaDirectionCoverageRow,
  type GsuaGlobalStats,
  type GsuaMetricKey,
  type EodEstimate,
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

interface Props {
  refreshKey?: number;
}

export function GsuaDailyPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const {
    loadState, error, queryDaily, queryGlobalStats, queryEodProjection,
    queryDirectionList, queryDirectionDaily, queryDirectionCoverage, queryDataWindow,
  } = useGsuaDatabaseContext();
  const [dataWindow, setDataWindow] = useState<{ minDate: string | null; maxDate: string | null; latestSnapshotAt: string | null }>({ minDate: null, maxDate: null, latestSnapshotAt: null });
  useEffect(() => { queryDataWindow().then(setDataWindow); }, [queryDataWindow]);

  const initial = useMemo(() => getUrlParams(), []);
  const [days, setDays] = useState<DayOption>(initial.days);
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>(initial.weekdays);
  const [selectedDate, setSelectedDate] = useState<string>(initial.date);
  const [selectedDirection, setSelectedDirection] = useState<string>(initial.direction);

  const [rows, setRows] = useState<GsuaDailyRow[]>([]);
  const [globalStats, setGlobalStats] = useState<GsuaGlobalStats>({} as GsuaGlobalStats);
  const [directionList, setDirectionList] = useState<string[]>([]);
  const [directionRows, setDirectionRows] = useState<GsuaDirectionRow[]>([]);
  const [coverageRows, setCoverageRows] = useState<GsuaDirectionCoverageRow[]>([]);
  const [eod, setEod] = useState<Partial<Record<GsuaMetricKey, EodEstimate>>>({});
  const [hasData, setHasData] = useState(false);

  const updateDays = (d: DayOption) => { setDays(d); setUrlParams({ days: String(d) }); };
  const updateDate = (d: string) => { setSelectedDate(d); setUrlParams({ date: d }); };
  const updateWeekdays = (next: number[]) => {
    setSelectedWeekdays(next);
    setUrlParams({ weekdays: next.join(",") });
  };
  const updateDirection = (dir: string) => {
    setSelectedDirection(dir);
    setUrlParams({ direction: dir });
  };

  useEffect(() => {
    if (loadState !== "ready") return;
    let cancelled = false;
    (async () => {
      const [gs, dl, ep] = await Promise.all([queryGlobalStats(), queryDirectionList(), queryEodProjection()]);
      if (cancelled) return;
      setGlobalStats(gs);
      setDirectionList(dl);
      setEod(ep);
    })();
    return () => { cancelled = true; };
  }, [loadState, queryGlobalStats, queryDirectionList, queryEodProjection, refreshKey]);

  useEffect(() => {
    if (loadState !== "ready") return;
    let cancelled = false;
    (async () => {
      const daily = await queryDaily(days, selectedDate || undefined);
      if (cancelled) return;
      setRows(daily);
      if (selectedDirection) {
        const dir = await queryDirectionDaily(selectedDirection, days, selectedDate || undefined);
        if (cancelled) return;
        setDirectionRows(dir);
        setCoverageRows([]);
      } else {
        setDirectionRows([]);
        const cov = await queryDirectionCoverage(days, selectedDate || undefined);
        if (cancelled) return;
        setCoverageRows(cov);
      }
      setHasData(true);
    })();
    return () => { cancelled = true; };
  }, [loadState, days, selectedDate, selectedDirection, queryDaily, queryDirectionDaily, queryDirectionCoverage, refreshKey]);

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
    let r = rows;
    if (selectedDate) {
      const startDate = windowStartDate(selectedDate, days);
      r = r.filter((row) => row.date >= startDate && row.date <= selectedDate);
    } else if (selectedWeekdays.length > 0) {
      r = r.filter((row) => selectedWeekdays.includes(new Date(row.date + "T12:00:00").getDay()));
    }
    return r;
  }, [rows, selectedDate, selectedWeekdays, days]);

  const filteredCoverageRows = useMemo(() => {
    let r = coverageRows;
    if (selectedDate) {
      const startDate = windowStartDate(selectedDate, days);
      r = r.filter((row) => row.date >= startDate && row.date <= selectedDate);
    }
    if (selectedWeekdays.length > 0) {
      r = r.filter((row) => selectedWeekdays.includes(new Date(row.date + "T12:00:00").getDay()));
    }
    return r;
  }, [coverageRows, selectedDate, selectedWeekdays, days]);

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

  const endDate = resolvedEndDate(selectedDate);
  const startDate = windowStartDate(endDate, days);
  // Weekday filter is intentional — don't pad dates that the user filtered out.
  const keepDate = selectedWeekdays.length === 0
    ? undefined
    : (iso: string) => selectedWeekdays.includes(new Date(iso + "T12:00:00").getDay());
  const makeDataset = (key: GsuaMetricKey) =>
    fillDailyRange(
      filteredRows.map((d) => ({
        date: d.date,
        value: typeof d[key] === "number" ? (d[key] as number) : null,
        is_today: d.is_today,
      })),
      startDate,
      endDate,
      { keepDate },
    );

  // For the combat_engagements chart in overview mode: show `attributed`
  // (sum of per-direction attacks for the canonical daily report) as a
  // stacked subset of the total. The chart's pairMode="subset" then draws
  // the "unattributed" band as `combat_engagements − attributed` on top,
  // so the reader sees at a glance how big the directionless portion is.
  // Note: paired-direction over-attribution ("На X і Y напрямках N ...")
  // inflates `attributed` on ~75% of days, so the unattributed band is a
  // conservative lower bound of the true directionless share.
  const attributedDataset = fillDailyRange(
    filteredCoverageRows.map((d) => ({
      date: d.date,
      value: d.attributed,
      is_today: d.is_today,
    })),
    startDate,
    endDate,
    { keepDate },
  );

  const directionAttacksDataset = fillDailyRange(
    filteredDirectionRows.map((d) => ({
      date: d.date,
      value: d.attacks,
      is_today: d.is_today,
    })),
    startDate,
    endDate,
    { keepDate },
  );
  const directionOngoingDataset = fillDailyRange(
    filteredDirectionRows.map((d) => ({
      date: d.date,
      value: d.ongoing,
      is_today: d.is_today,
    })),
    startDate,
    endDate,
    { keepDate },
  );
  const directionAttacksStats = useMemo(() => {
    const vals = directionAttacksDataset
      .map((p) => p.value)
      .filter((v): v is number => typeof v === "number")
      .sort((a, b) => a - b);
    return {
      max: vals.length ? vals[vals.length - 1] : 0,
      median: vals.length ? vals[Math.floor(vals.length / 2)] : 0,
      total: vals.reduce((s, n) => s + n, 0),
    };
  }, [directionAttacksDataset]);
  const directionOngoingStats = useMemo(() => {
    const vals = directionOngoingDataset
      .map((p) => p.value)
      .filter((v): v is number => typeof v === "number")
      .sort((a, b) => a - b);
    return {
      max: vals.length ? vals[vals.length - 1] : 0,
      median: vals.length ? vals[Math.floor(vals.length / 2)] : 0,
      total: vals.reduce((s, n) => s + n, 0),
    };
  }, [directionOngoingDataset]);

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
          Daily Combat Stats {selectedDirection ? `— ${selectedDirection}` : ""} - GSUA
        </h1>
        <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
          Last snapshot per day · Via Telegram @GeneralStaffZSU.
        </p>
        <DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="gsua" latestSnapshotAt={dataWindow.latestSnapshotAt} />
      </div>
      <div className="page-controls-sticky" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}>
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
      </div>

      {loadState === "loading" && !hasData && <LoadingScreen message="Loading GSUA database…" />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {(loadState === "ready" || hasData) && !selectedDirection && (
        <ChartGrid>
          {GSUA_METRIC_KEYS.map((k) => {
            // The combat_engagements chart gets the attributed/unattributed
            // stacked split when coverage data is available; other metrics
            // render as plain single-series line charts unchanged.
            const isCombat = k === "combat_engagements";
            const pair = isCombat && filteredCoverageRows.length > 0;
            return (
              <DailyLineChart
                key={k}
                title={GSUA_METRIC_LABELS[k]}
                data={makeDataset(k)}
                globalMax={globalStats[k]?.max ?? 0}
                globalMedian={globalStats[k]?.median ?? 0}
                globalTotal={globalStats[k]?.total ?? 0}
                wfull={isCombat}
                eod={eod[k] ?? null}
                data2={pair ? attributedDataset : undefined}
                primaryLabel={pair ? "Unattributed" : undefined}
                label2={pair ? "With direction" : undefined}
                pairMode={pair ? "subset" : undefined}
              />
            );
          })}
          {filteredCoverageRows.length > 0 && (
            <DirectionCoverageChart data={filteredCoverageRows} wfull />
          )}
        </ChartGrid>
      )}
      {(loadState === "ready" || hasData) && selectedDirection && (
        <ChartGrid>
          <DailyLineChart
            title={`Attacks · ${selectedDirection}`}
            data={directionAttacksDataset}
            globalMax={directionAttacksStats.max}
            globalMedian={directionAttacksStats.median}
            globalTotal={directionAttacksStats.total}
            wfull={false}
          />
          <DailyLineChart
            title={`Ongoing engagements · ${selectedDirection}`}
            data={directionOngoingDataset}
            globalMax={directionOngoingStats.max}
            globalMedian={directionOngoingStats.median}
            globalTotal={directionOngoingStats.total}
            wfull={false}
          />
        </ChartGrid>
      )}
    </div>
  );
}
