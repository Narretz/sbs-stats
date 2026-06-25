import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useDatabase } from "@/hooks/useDatabase";
import { useDatabaseGsua } from "@/hooks/useDatabaseGsua";
import { useDatabaseRuLosses } from "@/hooks/useDatabaseRuLosses";
import { useDatabaseRuMod } from "@/hooks/useDatabaseRuMod";
import { useDatabaseRuAirAttacks } from "@/hooks/useDatabaseRuAirAttacks";
import { useDatabaseSbuAlfa } from "@/hooks/useDatabaseSbuAlfa";
import { useDatabaseMediazona } from "@/hooks/useDatabaseMediazona";
import { DailyMultiLineChart, type LineSeries, type YAxisMode, type ChartGranularity } from "@/components/DailyMultiLineChart";
import { DayRangeSelect } from "@/components/DayRangeSelect";
import { MonthRangeSelect } from "@/components/MonthRangeSelect";
import { DateNav } from "@/components/DateNav";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { MetricPicker } from "@/components/MetricPicker";
import { RefreshIndicator } from "@/components/RefreshIndicator";
import { DAY_OPTIONS, type DayOption, parseDaysParam } from "@/utils/dayRange";
import { MONTH_OPTIONS, type MonthOption } from "@/utils/monthRange";
import { useStatScope, type StatScope } from "@/hooks/useStatScope";
import { findMetric, type CombinedMetric, type MetricSource } from "@/utils/combinedMetrics";
import { fetchCombinedDaily, fetchCombinedMonthly, fetchCombinedGlobalStats, statsForMetric, type GlobalStatsBundle } from "@/utils/combinedQuery";
import type { DailyDataPoint, Site } from "@/types";
import { SITES, SITE_LABELS } from "@/types";
import { FONTS } from "@/theme";
import defaultChartsConfig from "@/data/defaultCharts.json";

// Curated homepage defaults — shown to first-time visitors. Editable in
// src/data/defaultCharts.json. Per-chart specs are filtered through findMetric
// at load time so renames or removals in the metric registry fail gracefully.
// Global JSON settings: `days` + `months` are per-granularity defaults for
// newly-created charts; `scope` / `yMode` / `cumulative` are still global.
interface DefaultChartSpec { name: string; granularity: ChartGranularity; metricIds: string[] }
interface DefaultsFile {
  days?: number;
  months?: number;
  scope?: StatScope;
  yMode?: YAxisMode;
  cumulative?: boolean;
  charts: Array<{ name: string; granularity?: ChartGranularity; metricIds: string[] }>;
}
const RAW_DEFAULTS = defaultChartsConfig as DefaultsFile;
const DEFAULT_DAYS = (typeof RAW_DEFAULTS.days === "number" && RAW_DEFAULTS.days > 0)
  ? RAW_DEFAULTS.days : 30;
const DEFAULT_MONTHS = (typeof RAW_DEFAULTS.months === "number" && RAW_DEFAULTS.months > 0)
  ? RAW_DEFAULTS.months : 12;
const DEFAULT_SCOPE: StatScope = RAW_DEFAULTS.scope === "all" ? "all" : "window";
const DEFAULT_Y_MODE: YAxisMode = RAW_DEFAULTS.yMode === "log" || RAW_DEFAULTS.yMode === "normalized"
  ? RAW_DEFAULTS.yMode : "linear";
const DEFAULT_CUMULATIVE = RAW_DEFAULTS.cumulative === true;
const DEFAULT_CHART_SPECS: DefaultChartSpec[] = RAW_DEFAULTS.charts.map((c) => ({
  name: c.name,
  granularity: c.granularity === "monthly" ? "monthly" : "daily",
  metricIds: c.metricIds.filter((id) => {
    const m = findMetric(id);
    return m != null && m.views.includes(c.granularity === "monthly" ? "monthly" : "daily");
  }),
}));

// Per-chart defaults derive from the global JSON. New chart defaults to daily
// + DEFAULT_DAYS; switching to monthly resets to DEFAULT_MONTHS.
function defaultWindowFor(g: ChartGranularity): DayOption | MonthOption {
  return g === "monthly" ? DEFAULT_MONTHS : DEFAULT_DAYS;
}

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
  granularity: ChartGranularity;
  // Days when granularity === "daily"; months ("all" sentinel allowed) when
  // granularity === "monthly". Single field so it round-trips through URL +
  // JSON without a discriminated-union dance — the granularity is the
  // discriminator.
  window: DayOption | MonthOption;
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

function parseCumulative(raw: string | null): boolean {
  return raw === "1";
}

function makeDefaultCharts(globalDaysOverride?: number): ChartConfig[] {
  return DEFAULT_CHART_SPECS.map((c) => ({
    uid: newChartUid(),
    name: c.name,
    granularity: c.granularity,
    window: c.granularity === "monthly"
      ? DEFAULT_MONTHS
      : (globalDaysOverride ?? DEFAULT_DAYS),
    metricIds: [...c.metricIds],
  }));
}

// URL encoding for `charts=`:
//   <encName>[:<spec>]:<id>,<id>;<encName>:<id>;...
//
// - name is escaped MINIMALLY — only our delimiters (`:`, `;`) and `%` itself.
//   URLSearchParams handles the rest (spaces → +, unicode, etc) with its own
//   single encode/decode pass, so encoding the full name with encodeURIComponent
//   on top would double-encode common chars (e.g. " " → "%20" → "%2520").
// - spec is `d<days>` or `m<months|all>` (e.g. `d60`, `m12`, `mall`)
// - when omitted (legacy URL shape), defaults to daily + DEFAULT_DAYS
// - spec is also omitted on output when the chart matches the per-granularity
//   default window (so default-window URLs stay short)
// - empty metric list is allowed (chart created but no metrics yet)
const SPEC_RE = /^([dm])(\d+|all)$/;

function encodeChartName(s: string): string {
  // Just our 3 problem chars — encodeURIComponent of `:`/`;`/`%` yields
  // `%3A`/`%3B`/`%25`. After URLSearchParams.set/.get one-pass round-trip,
  // those escapes survive intact so chunk/field splits stay unambiguous.
  return s.replace(/[%:;]/g, encodeURIComponent);
}

function decodeChartName(s: string): string {
  // Reverse encodeChartName. URLSearchParams.get has already done one decode
  // pass, so our `%25`/`%3A`/`%3B` literals are what's left to undo.
  return s.replace(/%(25|3A|3B)/gi, (m) => decodeURIComponent(m));
}

function parseSpec(raw: string): { granularity: ChartGranularity; window: DayOption | MonthOption } | null {
  const m = SPEC_RE.exec(raw);
  if (!m) return null;
  const granularity: ChartGranularity = m[1] === "m" ? "monthly" : "daily";
  if (m[2] === "all") {
    return granularity === "monthly" ? { granularity, window: "all" } : null;
  }
  const n = Number(m[2]);
  if (!Number.isInteger(n) || n <= 0) return null;
  return { granularity, window: n };
}

function formatSpec(c: ChartConfig): string {
  if (c.granularity === "monthly") {
    return `m${c.window === "all" ? "all" : c.window}`;
  }
  return `d${c.window}`;
}

function parseCharts(raw: string | null, legacyMetrics: string[], legacyDays: number | null): ChartConfig[] {
  if (!raw) {
    if (legacyMetrics.length > 0) {
      // Migrate the old single-chart `metrics=` URL into a single chart so old
      // shared links still render the user's selection.
      return [{
        uid: newChartUid(),
        name: defaultChartName(1),
        granularity: "daily",
        window: legacyDays ?? DEFAULT_DAYS,
        metricIds: legacyMetrics,
      }];
    }
    // No URL state — fall back to the curated defaults from JSON. A legacy
    // `?days=N` (without a `charts=` param) overrides the daily window of the
    // curated defaults so old shared links still feel right.
    return makeDefaultCharts(legacyDays ?? undefined);
  }
  const chunks = raw.split(";").filter((c) => c.length > 0);
  if (chunks.length === 0) {
    return makeDefaultCharts(legacyDays ?? undefined);
  }
  return chunks.map((chunk, idx) => {
    const parts = chunk.split(":");
    const nameRaw = parts[0] ?? "";
    let granularity: ChartGranularity = "daily";
    let windowVal: DayOption | MonthOption = DEFAULT_DAYS;
    let idsRaw = "";
    if (parts.length >= 3) {
      const maybeSpec = parseSpec(parts[1]);
      if (maybeSpec) {
        granularity = maybeSpec.granularity;
        windowVal = maybeSpec.window;
        idsRaw = parts.slice(2).join(":");
      } else {
        // Spec field doesn't match — treat as legacy (entire tail is IDs).
        idsRaw = parts.slice(1).join(":");
      }
    } else if (parts.length === 2) {
      idsRaw = parts[1];
    }
    let name = defaultChartName(idx + 1);
    try {
      const decoded = decodeChartName(nameRaw);
      if (decoded) name = decoded;
    } catch {
      // Malformed encoding — keep the default name.
    }
    const metricIds = idsRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => {
        if (s.length === 0) return false;
        const m = findMetric(s);
        return m != null && m.views.includes(granularity);
      });
    return { uid: newChartUid(), name, granularity, window: windowVal, metricIds };
  });
}

function isDefaultWindow(c: ChartConfig): boolean {
  if (c.granularity === "monthly") return c.window === DEFAULT_MONTHS;
  return c.window === DEFAULT_DAYS;
}

function serializeCharts(charts: ChartConfig[]): string {
  return charts
    .map((c) => {
      // Omit the spec when this chart is daily + default-window — matches the
      // legacy shape so unchanged links stay unchanged.
      const isLegacyShape = c.granularity === "daily" && c.window === DEFAULT_DAYS;
      const head = isLegacyShape
        ? encodeChartName(c.name)
        : `${encodeChartName(c.name)}:${formatSpec(c)}`;
      return `${head}:${c.metricIds.join(",")}`;
    })
    .join(";");
}

// State matches the curated JSON defaults? When true we omit the `charts=`
// URL param so "/" stays clean — and so changes to defaultCharts.json reach
// every clean visitor without their bookmarks freezing the old defaults.
function isDefaultCharts(charts: ChartConfig[]): boolean {
  if (charts.length !== DEFAULT_CHART_SPECS.length) return false;
  for (let i = 0; i < charts.length; i++) {
    const c = charts[i];
    const spec = DEFAULT_CHART_SPECS[i];
    if (c.name !== spec.name) return false;
    if (c.granularity !== spec.granularity) return false;
    if (!isDefaultWindow(c)) return false;
    if (c.metricIds.length !== spec.metricIds.length) return false;
    for (let j = 0; j < spec.metricIds.length; j++) {
      if (c.metricIds[j] !== spec.metricIds[j]) return false;
    }
  }
  return true;
}

function parseMetricsLegacy(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0 && findMetric(s) != null);
}

function getUrlParams() {
  const p = new URLSearchParams(window.location.search);
  const legacyMetrics = parseMetricsLegacy(p.get("metrics"));
  // `days` is no longer a homepage-wide setting — windows are per-chart. The
  // value still has a legacy migration role: if the URL has `?days=N` without
  // a `charts=` param, it seeds the default daily window of the curated
  // default charts. Otherwise it's ignored.
  const rawDays = p.get("days");
  const legacyDays = rawDays != null ? parseDaysParam(rawDays) : null;
  return {
    date: parseDate(p.get("date")),
    yMode: p.get("y") != null ? parseYMode(p.get("y")) : DEFAULT_Y_MODE,
    cumulative: p.get("cum") != null ? parseCumulative(p.get("cum")) : DEFAULT_CUMULATIVE,
    charts: parseCharts(p.get("charts"), legacyMetrics, legacyDays),
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

  const [selectedDate, setSelectedDate] = useState<string>(initial.date);
  const [yMode, setYMode] = useState<YAxisMode>(initial.yMode);
  const [cumulative, setCumulative] = useState<boolean>(initial.cumulative);
  const [charts, setCharts] = useState<ChartConfig[]>(initial.charts);

  // StatScope lives in a global localStorage-backed context so it can be
  // shared with per-site pages. On homepage mount, apply the JSON-default
  // scope unless the URL carries an explicit `?scope=` override. Later
  // toggles flow through the existing StatScopeToggle as usual.
  const { scope, setScope } = useStatScope();
  useEffect(() => {
    const urlScope = new URLSearchParams(window.location.search).get("scope");
    const desired: StatScope = urlScope === "all" || urlScope === "window"
      ? urlScope
      : DEFAULT_SCOPE;
    if (desired !== scope) setScope(desired);
    // intentionally on mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Are all global settings + the chart list at their JSON defaults? Used by
  // the homepage's "showing curated defaults" notice. `scope` is included
  // because it's part of the JSON spec even though it doesn't roundtrip
  // through the URL. Per-chart granularity + window are folded into
  // isDefaultCharts.
  const showingDefaults =
    scope === DEFAULT_SCOPE &&
    yMode === DEFAULT_Y_MODE &&
    cumulative === DEFAULT_CUMULATIVE &&
    isDefaultCharts(charts);

  // Clear the legacy `metrics=` / `days=` params once on mount if we migrated.
  // Re-serialize charts onto the URL if migration produced non-default state.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    let dirty = false;
    if (p.has("metrics")) { p.delete("metrics"); dirty = true; }
    if (p.has("days")) { p.delete("days"); dirty = true; }
    if (dirty) {
      if (!isDefaultCharts(charts)) p.set("charts", serializeCharts(charts));
      const qs = p.toString();
      window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Union of all selected metric IDs across charts; drives the per-hook
  // `enabled` flag so unused DBs are never loaded.
  const allMetrics = useMemo(() => {
    const set = new Set<string>();
    for (const c of charts) for (const id of c.metricIds) set.add(id);
    return Array.from(set)
      .map((id) => findMetric(id))
      .filter((m): m is CombinedMetric => !!m);
  }, [charts]);

  const needed = useMemo(() => {
    const s = new Set<MetricSource>();
    for (const m of allMetrics) s.add(m.source);
    return s;
  }, [allMetrics]);

  // Mount every source's hook (Rules of Hooks); each is inert until selected.
  // The five daily-capable sources are usable in both granularities; SBU Alfa
  // and Mediazona are monthly-only and only appear in the picker when a
  // chart's granularity is "monthly".
  const sbs = useDatabase({ enabled: needed.has("sbs") });
  const gsua = useDatabaseGsua({ enabled: needed.has("gsua") });
  const ruLosses = useDatabaseRuLosses({ enabled: needed.has("ru-losses") });
  const ruMod = useDatabaseRuMod({ enabled: needed.has("ru-airdef-mod") });
  const ruAir = useDatabaseRuAirAttacks({ enabled: needed.has("ru-air-attacks") });
  const sbuAlfa = useDatabaseSbuAlfa({ enabled: needed.has("sbu-alfa") });
  // Mediazona's two MetricSource values share one underlying DB hook.
  const mediazonaNeeded = needed.has("mediazona-roles") || needed.has("mediazona-estimate");
  const mediazona = useDatabaseMediazona({ enabled: mediazonaNeeded });

  // Per-chart series data — each chart has its own window so they can't share
  // a fetch. Keyed by chartUid → { metricId → points[] }.
  const [seriesByChart, setSeriesByChart] = useState<Record<string, Record<string, DailyDataPoint[]>>>({});
  const [globalStats, setGlobalStats] = useState<GlobalStatsBundle>({});

  // Holds the latest fetch-key string per chart so a stale promise can't write
  // over a newer result if the user toggles granularity mid-flight.
  const latestKeyRef = useRef<Record<string, string>>({});

  // Build a stable "fetch key" per chart that changes only when something that
  // affects the chart's series changes — granularity, window, end-date, and
  // its specific metric-id selection.
  const chartFetchKeys = useMemo(() => {
    const out: Record<string, { key: string; ids: string }> = {};
    for (const c of charts) {
      const ids = [...c.metricIds].sort().join(",");
      out[c.uid] = {
        key: `${c.granularity}|${c.window}|${selectedDate}|${ids}`,
        ids,
      };
    }
    return out;
  }, [charts, selectedDate]);

  // One fetch per chart. We do not batch across charts because their windows
  // can differ; the per-source `enabled` gating means the hook still loads
  // each DB at most once.
  useEffect(() => {
    const allReady = [
      [needed.has("sbs"), sbs.loadState],
      [needed.has("gsua"), gsua.loadState],
      [needed.has("ru-losses"), ruLosses.loadState],
      [needed.has("ru-airdef-mod"), ruMod.loadState],
      [needed.has("ru-air-attacks"), ruAir.loadState],
      [needed.has("sbu-alfa"), sbuAlfa.loadState],
      [mediazonaNeeded, mediazona.loadState],
    ].every(([n, s]) => !n || s === "ready");
    if (!allReady) return;

    let cancelled = false;
    const liveUids = new Set(charts.map((c) => c.uid));

    // Drop entries for charts that no longer exist so memory doesn't grow.
    setSeriesByChart((prev) => {
      const next: typeof prev = {};
      let changed = false;
      for (const uid of Object.keys(prev)) {
        if (liveUids.has(uid)) next[uid] = prev[uid];
        else changed = true;
      }
      return changed ? next : prev;
    });

    for (const c of charts) {
      if (c.metricIds.length === 0) {
        latestKeyRef.current[c.uid] = chartFetchKeys[c.uid].key;
        continue;
      }
      const metrics = c.metricIds
        .map((id) => findMetric(id))
        .filter((m): m is CombinedMetric => !!m && m.views.includes(c.granularity));
      if (metrics.length === 0) continue;
      const key = chartFetchKeys[c.uid].key;
      latestKeyRef.current[c.uid] = key;
      const promise = c.granularity === "monthly"
        ? fetchCombinedMonthly(metrics, c.window as MonthOption, selectedDate || undefined, {
            sbs: needed.has("sbs") ? sbs.queryMonthly : undefined,
            gsua: needed.has("gsua") ? gsua.queryMonthly : undefined,
            ruLosses: needed.has("ru-losses") ? ruLosses.queryMonthly : undefined,
            ruMod: needed.has("ru-airdef-mod") ? ruMod.queryMonthly : undefined,
            ruAir: needed.has("ru-air-attacks") ? ruAir.queryMonthly : undefined,
            sbuAlfa: needed.has("sbu-alfa") ? sbuAlfa.queryCounters : undefined,
            mediazonaRoles: needed.has("mediazona-roles") ? mediazona.queryRolesMonthly : undefined,
            mediazonaEstimate: needed.has("mediazona-estimate") ? mediazona.queryEstimateMonthly : undefined,
          })
        : fetchCombinedDaily(metrics, c.window as DayOption, selectedDate || undefined, {
            sbs: needed.has("sbs") ? sbs.queryDaily : undefined,
            gsua: needed.has("gsua") ? gsua.queryDaily : undefined,
            ruLosses: needed.has("ru-losses") ? ruLosses.queryDaily : undefined,
            ruMod: needed.has("ru-airdef-mod") ? ruMod.queryDaily : undefined,
            ruAir: needed.has("ru-air-attacks") ? ruAir.queryDaily : undefined,
          });
      promise.then((data) => {
        if (cancelled) return;
        if (latestKeyRef.current[c.uid] !== key) return;
        setSeriesByChart((prev) => ({ ...prev, [c.uid]: data }));
      });
    }
    return () => { cancelled = true; };
  }, [charts, chartFetchKeys, selectedDate, needed, mediazonaNeeded,
      sbs.loadState, sbs.queryDaily, sbs.queryMonthly,
      gsua.loadState, gsua.queryDaily, gsua.queryMonthly,
      ruLosses.loadState, ruLosses.queryDaily, ruLosses.queryMonthly,
      ruMod.loadState, ruMod.queryDaily, ruMod.queryMonthly,
      ruAir.loadState, ruAir.queryDaily, ruAir.queryMonthly,
      sbuAlfa.loadState, sbuAlfa.queryCounters,
      mediazona.loadState, mediazona.queryRolesMonthly, mediazona.queryEstimateMonthly]);

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
      // SBU Alfa + Mediazona are monthly-only; the daily global-stats bundle
      // doesn't carry them. Their charts fall back to window stats either way.
      "sbu-alfa": false,
      "mediazona-roles": false,
      "mediazona-estimate": false,
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
  // when the chart list matches the curated JSON defaults so "/" stays clean.
  const updateCharts = (next: ChartConfig[]) => {
    setCharts(next);
    setUrlParams({ charts: isDefaultCharts(next) ? "" : serializeCharts(next) });
  };

  const updateDate = (d: string) => { setSelectedDate(d); setUrlParams({ date: d }); };
  const updateYMode = (m: YAxisMode) => {
    setYMode(m);
    // Linear is the default — keep the URL clean.
    setUrlParams({ y: m === "linear" ? "" : m });
  };
  const updateCumulative = (c: boolean) => {
    setCumulative(c);
    setUrlParams({ cum: c ? "1" : "" });
  };

  const updateChart = (uid: string, patch: Partial<ChartConfig>) => {
    updateCharts(charts.map((c) => (c.uid === uid ? { ...c, ...patch } : c)));
  };

  // Granularity changes reset the window to the new granularity's default and
  // drop any selected metrics that don't support the new granularity. The
  // caller sees only a granularity prop change — the dropped-metrics side
  // effect is signalled via the inline notice in ChartCard.
  const changeChartGranularity = (uid: string, g: ChartGranularity) => {
    updateCharts(charts.map((c) => {
      if (c.uid !== uid) return c;
      if (c.granularity === g) return c;
      const keptIds = c.metricIds.filter((id) => {
        const m = findMetric(id);
        return m != null && m.views.includes(g);
      });
      return {
        ...c,
        granularity: g,
        window: defaultWindowFor(g),
        metricIds: keptIds,
      };
    }));
  };

  const removeChart = (uid: string) => {
    const next = charts.filter((c) => c.uid !== uid);
    // Never end up with zero charts — re-seed with a fresh empty one.
    updateCharts(next.length > 0 ? next : [{
      uid: newChartUid(),
      name: defaultChartName(1),
      granularity: "daily",
      window: DEFAULT_DAYS,
      metricIds: [],
    }]);
  };
  const addChart = () => {
    updateCharts([...charts, {
      uid: newChartUid(),
      name: defaultChartName(charts.length + 1),
      granularity: "daily",
      window: DEFAULT_DAYS,
      metricIds: [],
    }]);
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
    const states: Array<[string, string, boolean]> = [
      ["sbs", sbs.loadState, needed.has("sbs")],
      ["gsua", gsua.loadState, needed.has("gsua")],
      ["ru-losses", ruLosses.loadState, needed.has("ru-losses")],
      ["ru-airdef-mod", ruMod.loadState, needed.has("ru-airdef-mod")],
      ["ru-air-attacks", ruAir.loadState, needed.has("ru-air-attacks")],
      ["sbu-alfa", sbuAlfa.loadState, needed.has("sbu-alfa")],
      // Both Mediazona sources share one underlying DB hook — collapse to a
      // single "mediazona" label so we don't double-report.
      ["mediazona", mediazona.loadState, mediazonaNeeded],
    ];
    return states.filter(([, st, isNeeded]) => isNeeded && st === "loading").map(([s]) => s);
  }, [needed, mediazonaNeeded, sbs.loadState, gsua.loadState, ruLosses.loadState, ruMod.loadState, ruAir.loadState, sbuAlfa.loadState, mediazona.loadState]);

  // Cross-source refresh state for the header indicator. Each underlying hook
  // has its own auto-refresh cadence, so a single combined countdown would be
  // misleading — we render the indicator in manual-only mode (no intervalMs).
  // `lastRefreshed` is the OLDEST timestamp across the needed sources (the
  // freshness floor: "all your data is at least this fresh"); `isLoading` is
  // any needed source still mid-fetch; `refresh()` fans out to every needed
  // source. Sources not currently needed by any chart are excluded so a
  // refresh doesn't fetch databases we aren't using.
  const sourceHandles = useMemo(() => ([
    { needed: needed.has("sbs"),               h: sbs       },
    { needed: needed.has("gsua"),              h: gsua      },
    { needed: needed.has("ru-losses"),         h: ruLosses  },
    { needed: needed.has("ru-airdef-mod"),     h: ruMod     },
    { needed: needed.has("ru-air-attacks"),    h: ruAir     },
    { needed: needed.has("sbu-alfa"),          h: sbuAlfa   },
    { needed: mediazonaNeeded,                 h: mediazona },
  ]), [needed, mediazonaNeeded, sbs, gsua, ruLosses, ruMod, ruAir, sbuAlfa, mediazona]);

  const refreshAggregated = useMemo(() => {
    const active = sourceHandles.filter((s) => s.needed);
    const stamps = active
      .map((s) => s.h.lastRefreshed)
      .filter((d): d is Date => d instanceof Date);
    return {
      lastRefreshed: stamps.length
        ? new Date(Math.min(...stamps.map((d) => d.getTime())))
        : null,
      isLoading: active.some((s) => s.h.loadState === "loading"),
      refreshCount: active.reduce((acc, s) => acc + s.h.refreshCount, 0),
      onRefresh: () => active.forEach((s) => s.h.refresh()),
    };
  }, [sourceHandles]);

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
          <RefreshIndicator
            lastRefreshed={refreshAggregated.lastRefreshed}
            refreshCount={refreshAggregated.refreshCount}
            onRefresh={refreshAggregated.onRefresh}
            isLoading={refreshAggregated.isLoading}
          />
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
            Custom charts
          </h1>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 6, maxWidth: 720 }}>
            {showingDefaults && "Currently showing the default charts. "}Pick any combination of metrics across the data sources. Each chart has its own granularity and time window — switch a chart to Monthly to compare longer trends.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
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
          <select
            value={cumulative ? "cumulative" : "per-period"}
            onChange={(e) => updateCumulative(e.target.value === "cumulative")}
            title="Values for each period (day or month) vs running cumulative sum within the chart's window"
            style={{
              background: t.bgAlt, color: t.text, border: `1px solid ${t.border}`,
              borderRadius: 4, padding: "5px 8px",
              fontFamily: FONTS.mono, fontSize: 11, cursor: "pointer",
            }}
          >
            <option value="per-period">Display: per-period</option>
            <option value="cumulative">Display: cumulative</option>
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
              cumulative={cumulative}
              seriesData={seriesByChart[c.uid] ?? {}}
              globalStats={globalStats}
              onRename={(name) => updateChart(c.uid, { name })}
              onMetricsChange={(metricIds) => updateChart(c.uid, { metricIds })}
              onGranularityChange={(g) => changeChartGranularity(c.uid, g)}
              onWindowChange={(w) => updateChart(c.uid, { window: w })}
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
  cumulative: boolean;
  seriesData: Record<string, DailyDataPoint[]>;
  globalStats: GlobalStatsBundle;
  onRename: (name: string) => void;
  onMetricsChange: (ids: string[]) => void;
  onGranularityChange: (g: ChartGranularity) => void;
  onWindowChange: (w: DayOption | MonthOption) => void;
  onRemove: () => void;
}

// Window-relative running sum. Each point's value becomes the cumulative
// total up to and including that point. Internal nulls don't add but keep
// the prior running total (so a single missing day doesn't open a gap);
// trailing nulls (padded to extend the axis to the chart's end) become null
// so the line stops where real data stops instead of extending flat to today.
function toCumulative(points: DailyDataPoint[]): DailyDataPoint[] {
  let lastReal = -1;
  for (let i = points.length - 1; i >= 0; i--) {
    if (typeof points[i].value === "number") { lastReal = i; break; }
  }
  let sum = 0;
  return points.map((p, i) => {
    if (typeof p.value === "number") sum += p.value;
    return { ...p, value: i > lastReal ? null : sum };
  });
}

function ChartCard({
  config, isOnlyChart, indexLabel, yMode, cumulative, seriesData, globalStats,
  onRename, onMetricsChange, onGranularityChange, onWindowChange, onRemove,
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

  // Watch granularity changes so we can flash an inline notice when switching
  // to a granularity that dropped some previously-selected metrics. Tracks
  // the prior granularity + selection length to detect the change.
  const prevGranRef = useRef<ChartGranularity>(config.granularity);
  const prevIdsRef = useRef<string[]>(config.metricIds);
  const [droppedNotice, setDroppedNotice] = useState<number>(0);
  useEffect(() => {
    if (prevGranRef.current !== config.granularity) {
      const dropped = prevIdsRef.current.filter((id) => !config.metricIds.includes(id)).length;
      if (dropped > 0) setDroppedNotice(dropped);
      // Clear the notice after a few seconds.
      const tid = setTimeout(() => setDroppedNotice(0), 5000);
      prevGranRef.current = config.granularity;
      prevIdsRef.current = config.metricIds;
      return () => clearTimeout(tid);
    }
    prevIdsRef.current = config.metricIds;
  }, [config.granularity, config.metricIds]);

  const metrics = useMemo(
    () => config.metricIds.map((id) => findMetric(id)).filter((m): m is CombinedMetric => !!m),
    [config.metricIds]
  );
  const series: LineSeries[] = useMemo(() => {
    return metrics.map((m, i) => {
      // Whole-dataset stats only matter for daily charts (the monthly bundle
      // isn't fetched). For monthly the chart falls back to window stats.
      const stat = config.granularity === "daily" ? statsForMetric(m, globalStats) : null;
      const raw = seriesData[m.id] ?? [];
      const data = cumulative ? toCumulative(raw) : raw;
      return {
        key: m.id,
        label: m.label,
        color: PALETTE[i % PALETTE.length],
        data,
        globalMax: stat?.max,
        globalMedian: stat?.median,
        globalTotal: stat?.total,
      };
    });
  }, [metrics, seriesData, globalStats, cumulative, config.granularity]);

  const ctrlStyle = {
    background: t.bgAlt, color: t.text, border: `1px solid ${t.border}`,
    borderRadius: 4, padding: "5px 8px",
    fontFamily: FONTS.mono, fontSize: 11, cursor: "pointer",
  } as const;

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
        <select
          value={config.granularity}
          onChange={(e) => onGranularityChange(e.target.value as ChartGranularity)}
          title="Time granularity for this chart"
          style={ctrlStyle}
        >
          <option value="daily">Daily</option>
          <option value="monthly">Monthly</option>
        </select>
        {config.granularity === "monthly" ? (
          <MonthRangeSelect
            options={MONTH_OPTIONS}
            value={config.window as MonthOption}
            onChange={(w) => onWindowChange(w)}
          />
        ) : (
          <DayRangeSelect
            options={DAY_OPTIONS}
            value={config.window as DayOption}
            onChange={(w) => onWindowChange(w)}
          />
        )}
        <MetricPicker selected={config.metricIds} onChange={onMetricsChange} view={config.granularity} />
        <button
          onClick={() => {
            const msg = isOnlyChart
              ? `Reset "${config.name}" to an empty default chart?`
              : `Remove "${config.name}"?`;
            if (window.confirm(msg)) onRemove();
          }}
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
      {droppedNotice > 0 && (
        <div style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted }}>
          {droppedNotice} metric{droppedNotice === 1 ? "" : "s"} dropped — not available in {config.granularity} granularity.
        </div>
      )}
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
          cumulative={cumulative}
          granularity={config.granularity}
        />
      )}
    </div>
  );
}
