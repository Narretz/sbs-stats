// The homepage's chart model: the curated defaults read out of
// src/data/defaultCharts.json, and the codec that round-trips a chart list
// through the `charts=` URL param.
//
// It lives beside the page rather than inside it because it is pure — strings
// and plain objects in, strings and plain objects out, no React and no
// `window` — which is what lets src/home/charts.test.ts cover the delimiter
// and malformed-input cases that are impractical to reach through a browser.
// HomePage keeps the parts that genuinely touch the URL (reading
// `window.location`, writing history entries).
import type { YAxisMode, ChartGranularity } from "@/components/DailyMultiLineChart";
import { type DayOption } from "@/utils/dayRange";
import { type MonthOption } from "@/utils/monthRange";
import { type StatScope } from "@/hooks/useStatScope";
import { findMetric } from "@/utils/combinedMetrics";
import defaultChartsConfig from "@/data/defaultCharts.json";

// Curated homepage defaults — shown to first-time visitors. Editable in
// src/data/defaultCharts.json. Per-chart specs are filtered through findMetric
// at load time so renames or removals in the metric registry fail gracefully.
// Global JSON settings: `days` + `months` are per-granularity defaults for
// newly-created charts; `scope` / `yMode` / `cumulative` are still global.
export interface DefaultChartSpec {
  name: string;
  granularity: ChartGranularity;
  metricIds: string[];
  // Resolved opening window; falls back to the global per-granularity default
  // when the JSON entry omits `window`.
  window: DayOption | MonthOption;
  // Per-chart Y-axis override. undefined = inherit the global yMode.
  yMode?: YAxisMode;
}
interface DefaultsFile {
  days?: number;
  months?: number;
  scope?: StatScope;
  yMode?: YAxisMode;
  cumulative?: boolean;
  charts: Array<{
    name: string;
    granularity?: ChartGranularity;
    metricIds: string[];
    // Optional per-chart opening window: a positive integer, or "all" (monthly
    // only). Omit to inherit the global `days` / `months` default.
    window?: number | "all";
    // Optional per-chart Y-axis transform. Omit to inherit the global `yMode`.
    yMode?: YAxisMode;
  }>;
}
const RAW_DEFAULTS = defaultChartsConfig as DefaultsFile;
export const DEFAULT_DAYS = (typeof RAW_DEFAULTS.days === "number" && RAW_DEFAULTS.days > 0)
  ? RAW_DEFAULTS.days : 30;
export const DEFAULT_MONTHS = (typeof RAW_DEFAULTS.months === "number" && RAW_DEFAULTS.months > 0)
  ? RAW_DEFAULTS.months : 12;
export const DEFAULT_SCOPE: StatScope = RAW_DEFAULTS.scope === "all" ? "all" : "window";
export const DEFAULT_Y_MODE: YAxisMode = RAW_DEFAULTS.yMode === "log" || RAW_DEFAULTS.yMode === "normalized"
  ? RAW_DEFAULTS.yMode : "linear";
export const DEFAULT_CUMULATIVE = RAW_DEFAULTS.cumulative === true;
// Resolve a JSON `window` value against the chart's granularity. Returns the
// global default when the entry is absent or invalid.
function resolveSpecWindow(
  g: ChartGranularity,
  raw: number | "all" | undefined,
): DayOption | MonthOption {
  if (g === "monthly") {
    if (raw === "all") return "all";
    if (typeof raw === "number" && raw > 0) return raw as MonthOption;
    return DEFAULT_MONTHS;
  }
  if (typeof raw === "number" && raw > 0) return raw as DayOption;
  return DEFAULT_DAYS;
}

function resolveSpecYMode(raw: unknown): YAxisMode | undefined {
  return raw === "linear" || raw === "log" || raw === "normalized" ? raw : undefined;
}

export const DEFAULT_CHART_SPECS: DefaultChartSpec[] = RAW_DEFAULTS.charts.map((c) => {
  const granularity: ChartGranularity = c.granularity === "monthly" ? "monthly" : "daily";
  const window = resolveSpecWindow(granularity, c.window);
  return {
    name: c.name,
    granularity,
    metricIds: c.metricIds.filter((id) => {
      const m = findMetric(id);
      return m != null && m.views.includes(granularity);
    }),
    window,
    yMode: resolveSpecYMode(c.yMode),
  };
});

// Per-chart defaults derive from the global JSON. New chart defaults to daily
// + DEFAULT_DAYS; switching to monthly resets to DEFAULT_MONTHS.
export function defaultWindowFor(g: ChartGranularity): DayOption | MonthOption {
  return g === "monthly" ? DEFAULT_MONTHS : DEFAULT_DAYS;
}

// Metrics are assigned colors by selection order within a chart, from the app's
// shared qualitative palette (see chartColors.ts).

export interface ChartConfig {
  // Stable React key only; not persisted to the URL.
  uid: string;
  name: string;
  granularity: ChartGranularity;
  // Days when granularity === "daily"; months ("all" sentinel allowed) when
  // granularity === "monthly". Single field so it round-trips through URL +
  // JSON without a discriminated-union dance — the granularity is the
  // discriminator.
  window: DayOption | MonthOption;
  // Per-chart Y-axis transform. undefined = inherit the homepage-global yMode.
  yMode?: YAxisMode;
  metricIds: string[];
}

export const defaultChartName = (n: number) => `Chart ${n}`;
let chartUidCounter = 0;
export const newChartUid = () => `chart-${++chartUidCounter}`;

export function makeDefaultCharts(): ChartConfig[] {
  return DEFAULT_CHART_SPECS.map((c) => ({
    uid: newChartUid(),
    name: c.name,
    granularity: c.granularity,
    window: c.window,
    yMode: c.yMode,
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
// - spec is `d<days>` or `m<months|all>` (e.g. `d60`, `m12`, `mall`), with an
//   optional `y<lin|log|norm>` suffix carrying a per-chart Y-axis override
//   (e.g. `d60ylog`, `mallynorm`). No suffix = inherit the global yMode.
// - when omitted (legacy URL shape), defaults to daily + DEFAULT_DAYS
// - spec is also omitted on output when the chart matches the per-granularity
//   default window AND has no yMode override (so default URLs stay short)
// - empty metric list is allowed (chart created but no metrics yet)
const SPEC_RE = /^([dm])(\d+|all)(?:y(lin|log|norm))?$/;
const YMODE_TO_TOKEN: Record<YAxisMode, string> = { linear: "lin", log: "log", normalized: "norm" };
const TOKEN_TO_YMODE: Record<string, YAxisMode> = { lin: "linear", log: "log", norm: "normalized" };

export function encodeChartName(s: string): string {
  // Just our 3 problem chars — encodeURIComponent of `:`/`;`/`%` yields
  // `%3A`/`%3B`/`%25`. After URLSearchParams.set/.get one-pass round-trip,
  // those escapes survive intact so chunk/field splits stay unambiguous.
  return s.replace(/[%:;]/g, encodeURIComponent);
}

export function decodeChartName(s: string): string {
  // Reverse encodeChartName. URLSearchParams.get has already done one decode
  // pass, so our `%25`/`%3A`/`%3B` literals are what's left to undo.
  return s.replace(/%(25|3A|3B)/gi, (m) => decodeURIComponent(m));
}

export function parseSpec(
  raw: string,
): { granularity: ChartGranularity; window: DayOption | MonthOption; yMode?: YAxisMode } | null {
  const m = SPEC_RE.exec(raw);
  if (!m) return null;
  const granularity: ChartGranularity = m[1] === "m" ? "monthly" : "daily";
  const yMode = m[3] ? TOKEN_TO_YMODE[m[3]] : undefined;
  if (m[2] === "all") {
    return granularity === "monthly" ? { granularity, window: "all", yMode } : null;
  }
  const n = Number(m[2]);
  if (!Number.isInteger(n) || n <= 0) return null;
  return { granularity, window: n, yMode };
}

export function formatSpec(c: ChartConfig): string {
  const base = c.granularity === "monthly"
    ? `m${c.window === "all" ? "all" : c.window}`
    : `d${c.window}`;
  return c.yMode ? `${base}y${YMODE_TO_TOKEN[c.yMode]}` : base;
}

export function parseCharts(raw: string | null, legacyMetrics: string[]): ChartConfig[] {
  if (!raw) {
    if (legacyMetrics.length > 0) {
      // Migrate the old single-chart `metrics=` URL into a single chart so old
      // shared links still render the user's selection.
      return [{
        uid: newChartUid(),
        name: defaultChartName(1),
        granularity: "daily",
        window: DEFAULT_DAYS,
        metricIds: legacyMetrics,
      }];
    }
    // No URL state — fall back to the curated defaults from JSON.
    return makeDefaultCharts();
  }
  const chunks = raw.split(";").filter((c) => c.length > 0);
  if (chunks.length === 0) {
    return makeDefaultCharts();
  }
  return chunks.map((chunk, idx) => {
    const parts = chunk.split(":");
    const nameRaw = parts[0] ?? "";
    let granularity: ChartGranularity = "daily";
    let windowVal: DayOption | MonthOption = DEFAULT_DAYS;
    let yModeVal: YAxisMode | undefined;
    let idsRaw = "";
    if (parts.length >= 3) {
      const maybeSpec = parseSpec(parts[1]);
      if (maybeSpec) {
        granularity = maybeSpec.granularity;
        windowVal = maybeSpec.window;
        yModeVal = maybeSpec.yMode;
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
    return { uid: newChartUid(), name, granularity, window: windowVal, yMode: yModeVal, metricIds };
  });
}

export function serializeCharts(charts: ChartConfig[]): string {
  return charts
    .map((c) => {
      // Omit the spec when this chart is daily + default-window + no yMode
      // override — matches the legacy shape so unchanged links stay unchanged.
      const isLegacyShape = c.granularity === "daily" && c.window === DEFAULT_DAYS && c.yMode == null;
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
export function isDefaultCharts(charts: ChartConfig[]): boolean {
  if (charts.length !== DEFAULT_CHART_SPECS.length) return false;
  for (let i = 0; i < charts.length; i++) {
    const c = charts[i];
    const spec = DEFAULT_CHART_SPECS[i];
    if (c.name !== spec.name) return false;
    if (c.granularity !== spec.granularity) return false;
    if (c.window !== spec.window) return false;
    if ((c.yMode ?? undefined) !== (spec.yMode ?? undefined)) return false;
    if (c.metricIds.length !== spec.metricIds.length) return false;
    for (let j = 0; j < spec.metricIds.length; j++) {
      if (c.metricIds[j] !== spec.metricIds[j]) return false;
    }
  }
  return true;
}

export function parseMetricsLegacy(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0 && findMetric(s) != null);
}
