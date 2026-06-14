import { useCallback, useEffect, useMemo, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useDatabase } from "@/hooks/useDatabase";
import { useDatabaseGsua } from "@/hooks/useDatabaseGsua";
import { useDatabaseRuLosses } from "@/hooks/useDatabaseRuLosses";
import { useDatabaseRuMod } from "@/hooks/useDatabaseRuMod";
import { useDatabaseRuAirAttacks } from "@/hooks/useDatabaseRuAirAttacks";
import { DailyMultiLineChart, type LineSeries } from "@/components/DailyMultiLineChart";
import { DayRangeSelect } from "@/components/DayRangeSelect";
import { DateNav } from "@/components/DateNav";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { MetricPicker } from "@/components/MetricPicker";
import { DAY_OPTIONS, type DayOption, parseDaysParam } from "@/utils/dayRange";
import { findMetric, type CombinedMetric, type MetricSource } from "@/utils/combinedMetrics";
import { fetchCombinedDaily } from "@/utils/combinedQuery";
import type { DailyDataPoint, Site } from "@/types";
import { SITES, SITE_LABELS } from "@/types";
import { FONTS } from "@/theme";

// Stable color palette; metrics are assigned colors by selection order.
// Picked for distinguishability on both light and dark themes.
const PALETTE = [
  "#3b82f6", "#ef4444", "#10b981", "#f59e0b",
  "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16",
  "#f97316", "#a855f7", "#14b8a6", "#eab308",
];

function parseDate(raw: string | null): string {
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

function parseMetrics(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0 && findMetric(s) != null);
}

function getUrlParams() {
  const p = new URLSearchParams(window.location.search);
  return {
    days: parseDaysParam(p.get("days")),
    date: parseDate(p.get("date")),
    metrics: parseMetrics(p.get("metrics")),
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
  const [selectedIds, setSelectedIds] = useState<string[]>(initial.metrics);

  const metrics = useMemo(
    () => selectedIds.map((id) => findMetric(id)).filter((m): m is CombinedMetric => !!m),
    [selectedIds]
  );

  // Which sources are needed right now? Drives the per-hook `enabled` flag so
  // unused DBs are never loaded.
  const needed = useMemo(() => {
    const s = new Set<MetricSource>();
    for (const m of metrics) s.add(m.source);
    return s;
  }, [metrics]);

  // Mount all five daily-capable hooks (Rules of Hooks); each is inert until
  // its source is selected.
  const sbs = useDatabase({ enabled: needed.has("sbs") });
  const gsua = useDatabaseGsua({ enabled: needed.has("gsua") });
  const ruLosses = useDatabaseRuLosses({ enabled: needed.has("ru-losses") });
  const ruMod = useDatabaseRuMod({ enabled: needed.has("ru-airdef-mod") });
  const ruAir = useDatabaseRuAirAttacks({ enabled: needed.has("ru-air-attacks") });

  const [seriesData, setSeriesData] = useState<Record<string, DailyDataPoint[]>>({});

  // Refetch when selection / window changes and every selected source is ready.
  useEffect(() => {
    if (metrics.length === 0) {
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
    fetchCombinedDaily(metrics, days, selectedDate || undefined, {
      sbs: needed.has("sbs") ? sbs.queryDaily : undefined,
      gsua: needed.has("gsua") ? gsua.queryDaily : undefined,
      ruLosses: needed.has("ru-losses") ? ruLosses.queryDaily : undefined,
      ruMod: needed.has("ru-airdef-mod") ? ruMod.queryDaily : undefined,
      ruAir: needed.has("ru-air-attacks") ? ruAir.queryDaily : undefined,
    }).then((data) => {
      if (!cancelled) setSeriesData(data);
    });
    return () => { cancelled = true; };
  }, [metrics, days, selectedDate, needed, sbs.loadState, sbs.queryDaily, gsua.loadState, gsua.queryDaily, ruLosses.loadState, ruLosses.queryDaily, ruMod.loadState, ruMod.queryDaily, ruAir.loadState, ruAir.queryDaily]);

  const updateDays = (d: DayOption) => { setDays(d); setUrlParams({ days: String(d) }); };
  const updateDate = (d: string) => { setSelectedDate(d); setUrlParams({ date: d }); };
  const updateMetrics = (next: string[]) => {
    setSelectedIds(next);
    setUrlParams({ metrics: next.join(",") });
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

  const series: LineSeries[] = useMemo(() => {
    return metrics.map((m, i) => ({
      key: m.id,
      label: m.label,
      color: PALETTE[i % PALETTE.length],
      data: seriesData[m.id] ?? [],
    }));
  }, [metrics, seriesData]);

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
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: t.accent, animation: "blink 2s infinite" }} />
          <span style={{ fontFamily: FONTS.display, fontSize: 13, fontWeight: 700, color: t.text, letterSpacing: "0.06em" }}>
            UA / RU WAR STATISTICS
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
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
            Combined daily chart
          </h1>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 6, maxWidth: 720 }}>
            Pick any combination of daily metrics across the data sources. Sources are loaded only when one of their
            metrics is selected. Single shared Y-axis — magnitudes vary widely between metrics, so expect smaller series
            to look flat next to large ones.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
          <DayRangeSelect options={DAY_OPTIONS} value={days} onChange={updateDays} />
          <DateNav value={selectedDate} max={maxSelectableDate} onChange={updateDate} onShift={shiftSelectedDate} canGoNext={canGoNext} />
          <StatScopeToggle />
          <MetricPicker selected={selectedIds} onChange={updateMetrics} view="daily" />
          {loadingSources.length > 0 && (
            <span style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted }}>
              Loading: {loadingSources.join(", ")}…
            </span>
          )}
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
            No metrics selected. Use <strong style={{ color: t.text }}>+ add metric</strong> above to start a chart.
          </div>
        ) : (
          <DailyMultiLineChart
            title={metrics.length === 1 ? metrics[0].label : "Combined daily metrics"}
            series={series}
            wfull
          />
        )}
      </main>
    </>
  );
}
