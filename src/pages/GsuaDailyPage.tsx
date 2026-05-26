import { useState, useMemo, useEffect } from "react";
import { Temporal } from "temporal-polyfill";
import { useGsuaDatabaseContext } from "@/context/useGsuaDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { DailyLineChart } from "@/components/DailyLineChart";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { WeekdayMultiSelect } from "@/components/WeekdayMultiSelect";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { DateNav } from "@/components/DateNav";
import { DayRangeSelect } from "@/components/DayRangeSelect";
import { DAY_OPTIONS, type DayOption } from "@/utils/dayRange";
import {
  GSUA_METRIC_KEYS,
  GSUA_METRIC_LABELS,
  type GsuaDailyRow,
  type GsuaDirectionRow,
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
    queryDirectionList, queryDirectionDaily,
  } = useGsuaDatabaseContext();

  const initial = useMemo(() => getUrlParams(), []);
  const [days, setDays] = useState<DayOption>(initial.days);
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>(initial.weekdays);
  const [selectedDate, setSelectedDate] = useState<string>(initial.date);
  const [selectedDirection, setSelectedDirection] = useState<string>(initial.direction);

  const [rows, setRows] = useState<GsuaDailyRow[]>([]);
  const [globalStats, setGlobalStats] = useState<Record<GsuaMetricKey, { max: number; median: number }>>(
    {} as Record<GsuaMetricKey, { max: number; median: number }>
  );
  const [directionList, setDirectionList] = useState<string[]>([]);
  const [directionRows, setDirectionRows] = useState<GsuaDirectionRow[]>([]);
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
      } else {
        setDirectionRows([]);
      }
      setHasData(true);
    })();
    return () => { cancelled = true; };
  }, [loadState, days, selectedDate, selectedDirection, queryDaily, queryDirectionDaily, refreshKey]);

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
      const startDate = shiftDate(selectedDate, -days);
      r = r.filter((row) => row.date >= startDate && row.date <= selectedDate);
    } else if (selectedWeekdays.length > 0) {
      r = r.filter((row) => selectedWeekdays.includes(new Date(row.date + "T12:00:00").getDay()));
    }
    return r;
  }, [rows, selectedDate, selectedWeekdays, days]);

  const filteredDirectionRows = useMemo(() => {
    let r = directionRows;
    if (selectedDate) {
      const startDate = shiftDate(selectedDate, -days);
      r = r.filter((row) => row.date >= startDate && row.date <= selectedDate);
    } else if (selectedWeekdays.length > 0) {
      r = r.filter((row) => selectedWeekdays.includes(new Date(row.date + "T12:00:00").getDay()));
    }
    return r;
  }, [directionRows, selectedDate, selectedWeekdays, days]);

  const makeDataset = (key: GsuaMetricKey) =>
    filteredRows.map((d) => ({
      date: d.date,
      value: typeof d[key] === "number" ? (d[key] as number) : null,
      is_today: d.is_today,
    }));

  const directionAttacksDataset = filteredDirectionRows.map((d) => ({
    date: d.date,
    value: d.attacks,
    is_today: d.is_today,
  }));
  const directionOngoingDataset = filteredDirectionRows.map((d) => ({
    date: d.date,
    value: d.ongoing,
    is_today: d.is_today,
  }));
  const directionAttacksStats = useMemo(() => {
    const vals = directionAttacksDataset
      .map((p) => p.value)
      .filter((v): v is number => typeof v === "number")
      .sort((a, b) => a - b);
    return {
      max: vals.length ? vals[vals.length - 1] : 0,
      median: vals.length ? vals[Math.floor(vals.length / 2)] : 0,
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
    };
  }, [directionOngoingDataset]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
            Daily Combat Stats {selectedDirection ? `— ${selectedDirection}` : ""} - GSUA
          </h1>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
            Last snapshot per day · {new Date().toDateString()}.  Via Telegram @GeneralStaffZSU.
          </p>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <WeekdayMultiSelect selected={selectedWeekdays} onChange={updateWeekdays} todayDow={todayDow} />
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
          <DateNav value={selectedDate} max={maxSelectableDate} onChange={updateDate} onShift={shiftSelectedDate} canGoNext={canGoNext} />
          <DayRangeSelect options={DAY_OPTIONS} value={days} onChange={updateDays} />
          <StatScopeToggle />
        </div>
      </div>

      {loadState === "loading" && !hasData && <LoadingScreen message="Loading GSUA database…" />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {(loadState === "ready" || hasData) && !selectedDirection && (
        <ChartGrid>
          {GSUA_METRIC_KEYS.map((k) => (
            <DailyLineChart
              key={k}
              title={GSUA_METRIC_LABELS[k]}
              data={makeDataset(k)}
              globalMax={globalStats[k]?.max ?? 0}
              globalMedian={globalStats[k]?.median ?? 0}
              wfull={k === "combat_engagements"}
              eod={eod[k] ?? null}
            />
          ))}
        </ChartGrid>
      )}
      {(loadState === "ready" || hasData) && selectedDirection && (
        <ChartGrid>
          <DailyLineChart
            title={`Attacks · ${selectedDirection}`}
            data={directionAttacksDataset}
            globalMax={directionAttacksStats.max}
            globalMedian={directionAttacksStats.median}
            wfull={false}
          />
          <DailyLineChart
            title={`Ongoing engagements · ${selectedDirection}`}
            data={directionOngoingDataset}
            globalMax={directionOngoingStats.max}
            globalMedian={directionOngoingStats.median}
            wfull={false}
          />
        </ChartGrid>
      )}
    </div>
  );
}
