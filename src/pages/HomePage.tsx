import { useCallback, useEffect, useMemo, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useDatabase } from "@/hooks/useDatabase";
import { useDatabaseGsua } from "@/hooks/useDatabaseGsua";
import { useDatabaseRuLosses } from "@/hooks/useDatabaseRuLosses";
import { useDatabaseRuMod } from "@/hooks/useDatabaseRuMod";
import { useDatabaseRuAirAttacks } from "@/hooks/useDatabaseRuAirAttacks";
import { DailyMultiLineChart, type LineSeries, type YAxisMode } from "@/components/DailyMultiLineChart";
import { DayRangeSelect } from "@/components/DayRangeSelect";
import { DateNav } from "@/components/DateNav";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { MetricPicker } from "@/components/MetricPicker";
import { DAY_OPTIONS, type DayOption, parseDaysParam } from "@/utils/dayRange";
import { findMetric, type CombinedMetric, type MetricSource } from "@/utils/combinedMetrics";
import { fetchCombinedDaily, fetchCombinedGlobalStats, statsForMetric, type GlobalStatsBundle } from "@/utils/combinedQuery";
import type { DailyDataPoint, Site } from "@/types";
import { SITES, SITE_LABELS } from "@/types";
import { FONTS } from "@/theme";

// Stable color palette; metrics are assigned colors by selection order within
// a chart. Picked for distinguishability on both light and dark themes.
const PALETTE = [
  "#3b82f6", "#ef4444", "#10b981", "#f59e0b",
  "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16",
  "#f97316", "#a855f7", "#14b8a6", "#eab308",
];

interface ChartConfig {
  // Stable React key only; not persisted to the URL.
  uid: string;
  name: string;
  metricIds: string[];
}

const defaultChartName = (n: number) => `Chart ${n}`;
let chartUidCounter = 0;
const newChartUid = () => `chart-${++chartUidCounter}`;

function parseDate(raw: string | null): string {
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

function parseYMode(raw: string | null): YAxisMode {
  return raw === "log" || raw === "normalized" ? raw : "linear";
}

// URL encoding for `charts=`:
//   <encName>:<id>,<id>;<encName>:<id>;...
// - name is encodeURIComponent'd so it can contain anything safely
// - empty metric list is allowed (chart created but no metrics yet)
function parseCharts(raw: string | null, legacyMetrics: string[]): ChartConfig[] {
  if (!raw) {
    if (legacyMetrics.length > 0) {
      // Migrate the old single-chart `metrics=` URL into a single chart so old
      // shared links still render the user's selection.
      return [{ uid: newChartUid(), name: defaultChartName(1), metricIds: legacyMetrics }];
    }
    return [{ uid: newChartUid(), name: defaultChartName(1), metricIds: [] }];
  }
  const chunks = raw.split(";").filter((c) => c.length > 0);
  if (chunks.length === 0) {
    return [{ uid: newChartUid(), name: defaultChartName(1), metricIds: [] }];
  }
  return chunks.map((chunk, idx) => {
    const colon = chunk.indexOf(":");
    const nameRaw = colon >= 0 ? chunk.slice(0, colon) : chunk;
    const idsRaw = colon >= 0 ? chunk.slice(colon + 1) : "";
    let name = defaultChartName(idx + 1);
    try {
      const decoded = decodeURIComponent(nameRaw);
      if (decoded) name = decoded;
    } catch {
      // Malformed encoding — keep the default name.
    }
    const metricIds = idsRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && findMetric(s) != null);
    return { uid: newChartUid(), name, metricIds };
  });
}

function serializeCharts(charts: ChartConfig[]): string {
  return charts
    .map((c) => `${encodeURIComponent(c.name)}:${c.metricIds.join(",")}`)
    .join(";");
}

// Default state = one empty chart with the default name and no metrics.
// We omit the `charts=` URL param while the state matches this default so
// "/" stays clean for a fresh visitor.
function isDefaultCharts(charts: ChartConfig[]): boolean {
  if (charts.length !== 1) return false;
  const only = charts[0];
  return only.metricIds.length === 0 && only.name === defaultChartName(1);
}

function parseMetricsLegacy(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0 && findMetric(s) != null);
}

function getUrlParams() {
  const p = new URLSearchParams(window.location.search);
  const legacyMetrics = parseMetricsLegacy(p.get("metrics"));
  return {
    days: parseDaysParam(p.get("days")),
    date: parseDate(p.get("date")),
    yMode: parseYMode(p.get("y")),
    charts: parseCharts(p.get("charts"), legacyMetrics),
  };
}

function setUrlParams(params: Record<string, string>) {
  const p = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v === "") p.delete(k);
    else p.set(k, v);
  }
  const qs = p.toString();
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState(null, "", url);
}

interface Props {
  onGoToSite: (site: Site) => void;
}

export function HomePage({ onGoToSite }: Props) {
  const { mode, theme: t, toggle } = useTheme();
  const initial = useMemo(() => getUrlParams(), []);

  const [days, setDays] = useState<DayOption>(initial.days);
  const [selectedDate, setSelectedDate] = useState<string>(initial.date);
  const [yMode, setYMode] = useState<YAxisMode>(initial.yMode);
  const [charts, setCharts] = useState<ChartConfig[]>(initial.charts);

  // Clear the old `metrics=` param once on mount if we migrated from it.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.has("metrics")) {
      p.delete("metrics");
      // Re-serialize charts onto the URL if migration produced non-default state.
      if (!isDefaultCharts(charts)) p.set("charts", serializeCharts(charts));
      const qs = p.toString();
      window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Union of all selected metric IDs across charts; drives the fetcher.
  const allSelectedIds = useMemo(() => {
    const set = new Set<string>();
    for (const c of charts) for (const id of c.metricIds) set.add(id);
    return Array.from(set);
  }, [charts]);

  const allMetrics = useMemo(
    () => allSelectedIds.map((id) => findMetric(id)).filter((m): m is CombinedMetric => !!m),
    [allSelectedIds]
  );

  // Which sources are needed right now? Drives the per-hook `enabled` flag so
  // unused DBs are never loaded.
  const needed = useMemo(() => {
    const s = new Set<MetricSource>();
    for (const m of allMetrics) s.add(m.source);
    return s;
  }, [allMetrics]);

  // Mount all five daily-capable hooks (Rules of Hooks); each is inert until
  // its source is selected.
  const sbs = useDatabase({ enabled: needed.has("sbs") });
  const gsua = useDatabaseGsua({ enabled: needed.has("gsua") });
  const ruLosses = useDatabaseRuLosses({ enabled: needed.has("ru-losses") });
  const ruMod = useDatabaseRuMod({ enabled: needed.has("ru-airdef-mod") });
  const ruAir = useDatabaseRuAirAttacks({ enabled: needed.has("ru-air-attacks") });

  const [seriesData, setSeriesData] = useState<Record<string, DailyDataPoint[]>>({});
  const [globalStats, setGlobalStats] = useState<GlobalStatsBundle>({});

  // Refetch when union of selections / window changes and every needed source
  // is ready. One fetch per source covers every chart that uses it.
  useEffect(() => {
    if (allMetrics.length === 0) {
      setSeriesData({});
      return;
    }
    const allReady = [
      [needed.has("sbs"), sbs.loadState],
      [needed.has("gsua"), gsua.loadState],
      [needed.has("ru-losses"), ruLosses.loadState],
      [needed.has("ru-airdef-mod"), ruMod.loadState],
      [needed.has("ru-air-attacks"), ruAir.loadState],
    ].every(([n, s]) => !n || s === "ready");
    if (!allReady) return;

    let cancelled = false;
    fetchCombinedDaily(allMetrics, days, selectedDate || undefined, {
      sbs: needed.has("sbs") ? sbs.queryDaily : undefined,
      gsua: needed.has("gsua") ? gsua.queryDaily : undefined,
      ruLosses: needed.has("ru-losses") ? ruLosses.queryDaily : undefined,
      ruMod: needed.has("ru-airdef-mod") ? ruMod.queryDaily : undefined,
      ruAir: needed.has("ru-air-attacks") ? ruAir.queryDaily : undefined,
    }).then((data) => {
      if (!cancelled) setSeriesData(data);
    });
    return () => { cancelled = true; };
  }, [allMetrics, days, selectedDate, needed, sbs.loadState, sbs.queryDaily, gsua.loadState, gsua.queryDaily, ruLosses.loadState, ruLosses.queryDaily, ruMod.loadState, ruMod.queryDaily, ruAir.loadState, ruAir.queryDaily]);

  // Refetch whole-dataset stats whenever the set of needed sources grows. The
  // bundle is keyed by source so adding a metric from an already-loaded source
  // doesn't refetch.
  useEffect(() => {
    const sourcesReady: Record<MetricSource, boolean> = {
      "sbs": needed.has("sbs") && sbs.loadState === "ready",
      "gsua": needed.has("gsua") && gsua.loadState === "ready",
      "ru-losses": needed.has("ru-losses") && ruLosses.loadState === "ready",
      "ru-airdef-mod": needed.has("ru-airdef-mod") && ruMod.loadState === "ready",
      "ru-air-attacks": needed.has("ru-air-attacks") && ruAir.loadState === "ready",
      "sbu-alfa": false,
    };
    const readySet = new Set<MetricSource>(
      (Object.keys(sourcesReady) as MetricSource[]).filter((k) => sourcesReady[k]),
    );
    if (readySet.size === 0) return;
    let cancelled = false;
    fetchCombinedGlobalStats(readySet, {
      sbs: sourcesReady.sbs ? sbs.queryGlobalStats : undefined,
      gsua: sourcesReady.gsua ? gsua.queryGlobalStats : undefined,
      ruLosses: sourcesReady["ru-losses"] ? ruLosses.queryGlobalStats : undefined,
      ruMod: sourcesReady["ru-airdef-mod"] ? ruMod.queryGlobalStats : undefined,
      ruAir: sourcesReady["ru-air-attacks"] ? ruAir.queryGlobalStats : undefined,
    }).then((bundle) => {
      if (!cancelled) setGlobalStats((prev) => ({ ...prev, ...bundle }));
    });
    return () => { cancelled = true; };
  }, [needed, sbs.loadState, sbs.queryGlobalStats, gsua.loadState, gsua.queryGlobalStats, ruLosses.loadState, ruLosses.queryGlobalStats, ruMod.loadState, ruMod.queryGlobalStats, ruAir.loadState, ruAir.queryGlobalStats]);

  // Single chart-config mutator. Persists to URL, omitting the `charts=` param
  // when the state matches the default (one empty chart) so "/" stays clean.
  const updateCharts = (next: ChartConfig[]) => {
    setCharts(next);
    setUrlParams({ charts: isDefaultCharts(next) ? "" : serializeCharts(next) });
  };

  const updateDays = (d: DayOption) => { setDays(d); setUrlParams({ days: String(d) }); };
  const updateDate = (d: string) => { setSelectedDate(d); setUrlParams({ date: d }); };
  const updateYMode = (m: YAxisMode) => {
    setYMode(m);
    // Linear is the default — keep the URL clean.
    setUrlParams({ y: m === "linear" ? "" : m });
  };

  const updateChart = (uid: string, patch: Partial<ChartConfig>) => {
    updateCharts(charts.map((c) => (c.uid === uid ? { ...c, ...patch } : c)));
  };
  const removeChart = (uid: string) => {
    const next = charts.filter((c) => c.uid !== uid);
    // Never end up with zero charts — re-seed with a fresh empty one.
    updateCharts(next.length > 0 ? next : [{ uid: newChartUid(), name: defaultChartName(1), metricIds: [] }]);
  };
  const addChart = () => {
    updateCharts([...charts, { uid: newChartUid(), name: defaultChartName(charts.length + 1), metricIds: [] }]);
  };

  const maxSelectableDate = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
  const shiftSelectedDate = (delta: number) => {
    const base = selectedDate || maxSelectableDate;
    const d = new Date(base + "T12:00:00");
    d.setDate(d.getDate() + delta);
    const next = d.toISOString().slice(0, 10);
    if (next > maxSelectableDate) return;
    updateDate(next);
  };
  const canGoNext = selectedDate !== "" && selectedDate < maxSelectableDate;

  const loadingSources = useMemo(() => {
    const states: Array<[MetricSource, string]> = [
      ["sbs", sbs.loadState],
      ["gsua", gsua.loadState],
      ["ru-losses", ruLosses.loadState],
      ["ru-airdef-mod", ruMod.loadState],
      ["ru-air-attacks", ruAir.loadState],
    ];
    return states.filter(([s, st]) => needed.has(s) && st === "loading").map(([s]) => s);
  }, [needed, sbs.loadState, gsua.loadState, ruLosses.loadState, ruMod.loadState, ruAir.loadState]);

  const onSitePick = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v) onGoToSite(v as Site);
  }, [onGoToSite]);

  return (
    <>
      <header
        style={{
          borderBottom: `1px solid ${t.border}`,
          padding: "0 24px",
          height: 52,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: t.headerBg,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontFamily: FONTS.display, fontSize: 13, fontWeight: 700, color: t.text, letterSpacing: "0.06em" }}>
            RU-UA WAR STATISTICS
          </span>
          <select
            value=""
            onChange={onSitePick}
            style={{
              background: t.bgAlt, color: t.text, border: `1px solid ${t.border}`,
              borderRadius: 4, padding: "5px 8px",
              fontFamily: FONTS.mono, fontSize: 11, cursor: "pointer",
            }}
          >
            <option value="">browse by site…</option>
            {SITES.map((s) => (
              <option key={s} value={s}>{SITE_LABELS[s]}</option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={toggle}
            title={`Switch to ${mode === "light" ? "dark" : "light"} mode`}
            style={{
              background: t.bgAlt, border: `1px solid ${t.border}`, borderRadius: 4,
              padding: "5px 10px", cursor: "pointer", fontSize: 14, lineHeight: 1, color: t.text,
            }}
          >
            {mode === "light" ? "🌙" : "☀️"}
          </button>
        </div>
      </header>

      <main style={{ maxWidth: 1400, margin: "0 auto", padding: "32px 20px 64px" }}>
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 26, color: t.text, margin: 0 }}>
            Custom daily charts
          </h1>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 6, maxWidth: 720 }}>
            Pick any combination of daily metrics across the data sources. Add more charts below to compare side by side.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
          <DayRangeSelect options={DAY_OPTIONS} value={days} onChange={updateDays} />
          <DateNav value={selectedDate} max={maxSelectableDate} onChange={updateDate} onShift={shiftSelectedDate} canGoNext={canGoNext} />
          <StatScopeToggle />
          <select
            value={yMode}
            onChange={(e) => updateYMode(e.target.value as YAxisMode)}
            title="Y-axis transform"
            style={{
              background: t.bgAlt, color: t.text, border: `1px solid ${t.border}`,
              borderRadius: 4, padding: "5px 8px",
              fontFamily: FONTS.mono, fontSize: 11, cursor: "pointer",
            }}
          >
            <option value="linear">Y: linear</option>
            <option value="log">Y: log</option>
            <option value="normalized">Y: normalized (0–100%)</option>
          </select>
          {loadingSources.length > 0 && (
            <span style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted }}>
              Loading: {loadingSources.join(", ")}…
            </span>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {charts.map((c, i) => (
            <ChartCard
              key={c.uid}
              config={c}
              isOnlyChart={charts.length === 1}
              indexLabel={`Chart ${i + 1} of ${charts.length}`}
              yMode={yMode}
              seriesData={seriesData}
              globalStats={globalStats}
              onRename={(name) => updateChart(c.uid, { name })}
              onMetricsChange={(metricIds) => updateChart(c.uid, { metricIds })}
              onRemove={() => removeChart(c.uid)}
            />
          ))}
          <div>
            <button
              onClick={addChart}
              style={{
                background: t.bgAlt, color: t.text, border: `1px dashed ${t.border}`,
                borderRadius: 6, padding: "10px 16px",
                fontFamily: FONTS.mono, fontSize: 12, cursor: "pointer", width: "100%",
              }}
            >
              + Add chart
            </button>
          </div>
        </div>
      </main>
    </>
  );
}

interface ChartCardProps {
  config: ChartConfig;
  isOnlyChart: boolean;
  indexLabel: string;
  yMode: YAxisMode;
  seriesData: Record<string, DailyDataPoint[]>;
  globalStats: GlobalStatsBundle;
  onRename: (name: string) => void;
  onMetricsChange: (ids: string[]) => void;
  onRemove: () => void;
}

function ChartCard({
  config, isOnlyChart, indexLabel, yMode, seriesData, globalStats,
  onRename, onMetricsChange, onRemove,
}: ChartCardProps) {
  const { theme: t } = useTheme();

  // Local buffer for the chart-name input. Typing only updates this; the
  // upstream commit (which triggers a re-render of the chart + a URL write)
  // happens on blur, Enter, or after a short idle. Keeps the input snappy
  // even when the chart underneath is heavy.
  const [draftName, setDraftName] = useState(config.name);
  useEffect(() => { setDraftName(config.name); }, [config.name]);
  const commitName = useCallback(() => {
    if (draftName !== config.name) onRename(draftName);
  }, [draftName, config.name, onRename]);
  useEffect(() => {
    if (draftName === config.name) return;
    const tid = setTimeout(commitName, 400);
    return () => clearTimeout(tid);
  }, [draftName, config.name, commitName]);

  const metrics = useMemo(
    () => config.metricIds.map((id) => findMetric(id)).filter((m): m is CombinedMetric => !!m),
    [config.metricIds]
  );
  const series: LineSeries[] = useMemo(() => {
    return metrics.map((m, i) => {
      const stat = statsForMetric(m, globalStats);
      return {
        key: m.id,
        label: m.label,
        color: PALETTE[i % PALETTE.length],
        data: seriesData[m.id] ?? [],
        globalMax: stat?.max,
        globalMedian: stat?.median,
        globalTotal: stat?.total,
      };
    });
  }, [metrics, seriesData, globalStats]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted, letterSpacing: "0.05em" }}>
          {indexLabel}
        </span>
        <input
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.currentTarget.blur(); }
            else if (e.key === "Escape") { setDraftName(config.name); e.currentTarget.blur(); }
          }}
          placeholder="Chart name"
          style={{
            background: t.bgAlt, color: t.text, border: `1px solid ${t.border}`,
            borderRadius: 4, padding: "5px 8px",
            fontFamily: FONTS.mono, fontSize: 12, fontWeight: 400,
            minWidth: 220,
          }}
        />
        <MetricPicker selected={config.metricIds} onChange={onMetricsChange} view="daily" />
        <button
          onClick={onRemove}
          title={isOnlyChart ? "Reset this chart" : "Remove this chart"}
          style={{
            background: t.bgAlt, color: t.textMuted, border: `1px solid ${t.border}`,
            borderRadius: 4, padding: "5px 10px",
            fontFamily: FONTS.mono, fontSize: 11, cursor: "pointer",
          }}
        >
          {isOnlyChart ? "Reset" : "× Remove"}
        </button>
      </div>
      {metrics.length === 0 ? (
        <div
          style={{
            padding: 32,
            border: `1px dashed ${t.border}`,
            borderRadius: 8,
            fontFamily: FONTS.mono,
            fontSize: 12,
            color: t.textMuted,
            textAlign: "center",
          }}
        >
          No metrics selected. Use <strong style={{ color: t.text }}>+ add metric</strong> above to start this chart.
        </div>
      ) : (
        <DailyMultiLineChart
          title={config.name}
          series={series}
          wfull
          yMode={yMode}
        />
      )}
    </div>
  );
}
