import { useMemo, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { ChartGrid } from "@/components/Layout";
import { MissileRangeChart } from "@/components/MissileRangeChart";
import { MissileStackedBarChart } from "@/components/MissileStackedBarChart";
import { buildSeries, TIME_DOMAIN, TIME_TICKS, DATA_WINDOW, MISSILE_TYPES, type MissileKind } from "@/data/missiles";
import {
  colorMap,
  MISSILE_CATEGORY,
  MISSILE_CATEGORY_LABEL,
  MISSILE_CATEGORY_ORDER,
  MISSILE_HIDDEN_DEFAULT,
  type MissileCategory,
} from "@/components/missilePalette";
import { FONTS } from "@/theme";

type View = "production" | "stockpile";
type Layout = "grid" | "bars";
const VIEWS: View[] = ["production", "stockpile"];
const LAYOUTS: Layout[] = ["grid", "bars"];
const VIEW_PARAM = 'missiles-view';
const LAYOUT_PARAM = 'missiles-layout';
const KIND: Record<View, MissileKind> = { production: "production_monthly", stockpile: "stockpile" };
const UNIT: Record<View, string> = { production: "units / month", stockpile: "in stockpile" };

// URL-param persistence: mirrors the date/days/weekday pattern used on the
// other pages so a deep link captures what the user was looking at.
function parseEnum<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return raw != null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function getUrlParams() {
  const p = new URLSearchParams(window.location.search);
  return {
    view: parseEnum<View>(p.get(VIEW_PARAM), VIEWS, "production"),
    layout: parseEnum<Layout>(p.get(LAYOUT_PARAM), LAYOUTS, "grid"),
  };
}

function setUrlParams(params: Record<string, string>) {
  const p = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(params)) p.set(k, v);
  window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
}

// The bound→glyph key, shown once so the per-panel dot shapes are legible.
const LEGEND: Array<{ g: string; label: string }> = [
  { g: "▽", label: "up to (ceiling)" },
  { g: "△", label: "at least (floor)" },
  { g: "●", label: "approx / range" },
  { g: "■", label: "exact" },
  { g: "○", label: "planned" },
];

export function MissilesPage() {
  const { theme: t } = useTheme();
  const initial = useMemo(() => getUrlParams(), []);
  const [view, setViewState] = useState<View>(initial.view);
  const [layout, setLayoutState] = useState<Layout>(initial.layout);
  const setView = (v: View) => { setViewState(v); setUrlParams({ [VIEW_PARAM]: v }); };
  const setLayout = (l: Layout) => { setLayoutState(l); setUrlParams({ [LAYOUT_PARAM]: l }); };
  // Tracked as the *hidden* set so defaults persist across view switches and any
  // newly-appearing type defaults to shown.
  const [hidden, setHidden] = useState<Set<string>>(new Set(MISSILE_HIDDEN_DEFAULT));

  // Lumped buckets (one number spanning >1 type, e.g. Zircon+Oniks) make poor
  // trend panels — single sparse points that don't trend and aren't comparable —
  // so the grid shows single-type series only. The combined measurements stay in
  // reports.json for the source view / heatmap.
  const series = useMemo(
    () => buildSeries(KIND[view]).filter((s) => s.members.length === 1),
    [view],
  );

  const seriesByKey = useMemo(() => {
    const m = new Map<string, (typeof series)[number]>();
    for (const s of series) m.set(s.key, s);
    return m;
  }, [series]);

  // Colours assigned over the FULL canonical type list (not just types present
  // in the current view) so a checkbox's swatch stays consistent across
  // production ↔ stockpile toggling and never changes when a type appears.
  const colorFor = useMemo(() => colorMap(Object.keys(MISSILE_CATEGORY)), []);

  // Types that show up as a standalone single-type measurement in at least one
  // view (production OR stockpile) across the whole report set. Anything that
  // ONLY ever appears inside a lumped combined bucket (today: just Kh-55, only
  // in the 2024-12-28 Kh-101+Kh-35+Kh-55 entry) is dropped from the checkbox
  // list entirely — a permanently-disabled row adds clutter without value. If
  // a future disclosure breaks that type out standalone, it auto-reappears.
  const everHasStandaloneData = useMemo(() => {
    const set = new Set<string>();
    for (const kind of ["production_monthly", "stockpile"] as const) {
      for (const s of buildSeries(kind)) {
        if (s.members.length === 1) set.add(s.key);
      }
    }
    return set;
  }, []);

  // Checkbox rows enumerate every canonical type that's ever been reported
  // standalone; types missing from the current view (but present in the other)
  // render as disabled with a "no data" hover hint.
  const grouped = useMemo(() => {
    const out: Record<MissileCategory, string[]> = { cruise: [], ballistic: [], other: [] };
    for (const k of Object.keys(MISSILE_CATEGORY)) {
      if (!everHasStandaloneData.has(k)) continue;
      out[MISSILE_CATEGORY[k]].push(k);
    }
    return out;
  }, [everHasStandaloneData]);

  const visibleSeries = useMemo(() => series.filter((s) => !hidden.has(s.key)), [series, hidden]);
  const toggleHidden = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  // Shared y-max across the grid so panel heights are comparable; padded 15%.
  // Only the *visible* series feed it — hiding an outlier (e.g. the AD pool's
  // ~11k) lets the grid rescale to the remaining types automatically.
  const sharedMax = useMemo(
    () => Math.ceil(Math.max(1, ...visibleSeries.flatMap((s) => s.points.map((p) => p.high))) * 1.15),
    [visibleSeries],
  );

  const pill = <T extends string>(value: T, current: T, set: (v: T) => void, label: string) => (
    <button
      key={value}
      onClick={() => set(value)}
      style={{
        background: current === value ? t.primary : "transparent",
        color: current === value ? "#fff" : t.textMuted,
        border: `1px solid ${current === value ? t.primary : t.border}`,
        borderRadius: 4, padding: "5px 14px", fontFamily: FONTS.display, fontSize: 12,
        fontWeight: current === value ? 700 : 400, cursor: "pointer", letterSpacing: "0.04em",
      }}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
            RU Missile Stockpiles & Production
          </h1>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
            Ukrainian military intelligence (HUR/GUR) estimates · irregular disclosures (~2×/yr) · one panel per missile type
            <br />
            <span style={{ color: t.textImportant, border: `2px solid ${t.borderImportant}`, display: "inline-block", marginTop: 2, padding: 4, borderRadius: 4 }}>
              These are intelligence estimates, not counts — every value carries a stated bound (≤, ≥, ~, range). Figures vary by ±10% even between reports weeks apart, and the type breakdown changes over time. A missing report is a gap, not a zero.
            </span>
          </p>
          <div style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
            Data Availability: {DATA_WINDOW.min} – {DATA_WINDOW.max} · {DATA_WINDOW.reports} disclosures
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {pill<View>("production", view, setView, "PRODUCTION")}
          {pill<View>("stockpile", view, setView, "STOCKPILE")}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted }}>
          {layout === "grid" && LEGEND.map(({ g, label }) => (
            <span key={label}><span style={{ color: t.text }}>{g}</span> {label}</span>
          ))}
          {layout === "bars" && <span>Segments = central estimate · hover a type to trace it · *totals not comparable (later reports itemise more types)</span>}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted }}>View as:</span>
          {pill<Layout>("grid", layout, setLayout, "GRID")}
          {pill<Layout>("bars", layout, setLayout, "BARS")}
        </div>
      </div>

      {/* Type checkboxes, one row per weapon family. Every canonical type is
          listed regardless of whether it has data in the current view — types
          without data render as disabled with a tooltip. Filters both grid and
          bars so a hidden outlier (e.g. the AD pool ~11k) doesn't squash the
          y-axis. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
        {MISSILE_CATEGORY_ORDER.map((cat) => {
          const list = grouped[cat];
          if (list.length === 0) return null;
          return (
            <div key={cat} style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontFamily: FONTS.display, fontSize: 11, fontWeight: 700, color: t.textMuted, letterSpacing: "0.04em", minWidth: 150 }}>
                {MISSILE_CATEGORY_LABEL[cat].toUpperCase()}
              </span>
              {list.map((key) => {
                const hasData = seriesByKey.has(key);
                const label = MISSILE_TYPES[key]?.name ?? key;
                const on = !hidden.has(key);
                const color = colorFor.get(key);
                const labelColor = !hasData ? t.textFaint : on ? t.text : t.textFaint;
                const title = hasData
                  ? undefined
                  : `No ${view} data for ${label} in any HUR/GUR disclosure so far.`;
                return (
                  <label key={key} title={title} style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    cursor: hasData ? "pointer" : "not-allowed",
                    fontFamily: FONTS.mono, fontSize: 11, color: labelColor,
                    opacity: hasData ? 1 : 0.7,
                  }}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!hasData}
                      onChange={() => toggleHidden(key)}
                      style={{ cursor: hasData ? "pointer" : "not-allowed" }}
                    />
                    <span style={{
                      width: 12, height: 12, borderRadius: 2, flexShrink: 0,
                      background: on && hasData ? color : "transparent",
                      border: `1px solid ${color}`,
                    }} />
                    {label}
                  </label>
                );
              })}
            </div>
          );
        })}
      </div>

      {layout === "grid" && (
        visibleSeries.length > 0
          ? (
            <ChartGrid>
              {visibleSeries.map((s) => (
                <MissileRangeChart
                  key={s.key}
                  series={s}
                  unit={UNIT[view]}
                  timeDomain={TIME_DOMAIN}
                  ticks={TIME_TICKS}
                  yMax={sharedMax}
                  swatch={colorFor.get(s.key)}
                />
              ))}
            </ChartGrid>
          )
          : <div style={{ fontFamily: FONTS.mono, fontSize: 12, color: t.textMuted, padding: 40, textAlign: "center" }}>Select at least one missile type.</div>
      )}
      {layout === "bars" && (
        visibleSeries.length > 0
          ? <MissileStackedBarChart series={visibleSeries} unit={UNIT[view]} timeDomain={TIME_DOMAIN} ticks={TIME_TICKS} colorFor={colorFor} />
          : <div style={{ fontFamily: FONTS.mono, fontSize: 12, color: t.textMuted, padding: 40, textAlign: "center" }}>Select at least one missile type.</div>
      )}
    </div>
  );
}
