import { useMemo, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { ChartGrid } from "@/components/Layout";
import { MissileRangeChart } from "@/components/MissileRangeChart";
import { MissileStackedBarChart } from "@/components/MissileStackedBarChart";
import { buildSeries, TIME_DOMAIN, TIME_TICKS, DATA_WINDOW, type MissileKind } from "@/data/missiles";
import { colorMap } from "@/components/missilePalette";
import { FONTS } from "@/theme";

// Outliers hidden by default in the bar view: the S-300/400 figure is the whole
// air-defence pool (~11,000, a different quantity from strike missiles) and the
// Kh-29/31/35/58/59 entry is itself a 5-way lump — both swamp the stack.
const BAR_HIDDEN_DEFAULT = ["s300_s400_ad", "kh_tactical"];

type View = "production" | "stockpile";
type ScaleMode = "shared" | "fit";
type Layout = "grid" | "bars";
const KIND: Record<View, MissileKind> = { production: "production_monthly", stockpile: "stockpile" };
const UNIT: Record<View, string> = { production: "units / month", stockpile: "in stockpile" };

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
  const [view, setView] = useState<View>("production");
  const [scaleMode, setScaleMode] = useState<ScaleMode>("shared");
  const [layout, setLayout] = useState<Layout>("grid");
  // Tracked as the *hidden* set so defaults persist across view switches and any
  // newly-appearing type defaults to shown.
  const [hidden, setHidden] = useState<Set<string>>(new Set(BAR_HIDDEN_DEFAULT));

  // Lumped buckets (one number spanning >1 type, e.g. Zircon+Oniks) make poor
  // trend panels — single sparse points that don't trend and aren't comparable —
  // so the grid shows single-type series only. The combined measurements stay in
  // reports.json for the source view / heatmap.
  const series = useMemo(
    () => buildSeries(KIND[view]).filter((s) => s.members.length === 1),
    [view],
  );

  // Colours assigned over the full type list (stable per type regardless of
  // which are checked) and shared with the checkbox swatches.
  const colorFor = useMemo(() => colorMap(series.map((s) => s.key)), [series]);
  const barSeries = useMemo(() => series.filter((s) => !hidden.has(s.key)), [series, hidden]);
  const toggleHidden = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  // Shared y-max across the grid so panel heights are comparable; padded 15%.
  const sharedMax = useMemo(
    () => Math.ceil(Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.high))) * 1.15),
    [series],
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
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          {layout === "grid" && (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted }}>Y-axis:</span>
              {pill<ScaleMode>("shared", scaleMode, setScaleMode, "SHARED")}
              {pill<ScaleMode>("fit", scaleMode, setScaleMode, "FIT EACH")}
            </div>
          )}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted }}>View as:</span>
            {pill<Layout>("grid", layout, setLayout, "GRID")}
            {pill<Layout>("bars", layout, setLayout, "BARS")}
          </div>
        </div>
      </div>

      {layout === "grid" && (
        <ChartGrid>
          {series.map((s) => (
            <MissileRangeChart
              key={s.key}
              series={s}
              unit={UNIT[view]}
              timeDomain={TIME_DOMAIN}
              ticks={TIME_TICKS}
              yMax={scaleMode === "shared" ? sharedMax : undefined}
            />
          ))}
        </ChartGrid>
      )}
      {layout === "bars" && (
        <>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 14 }}>
            {series.map((s) => {
              const on = !hidden.has(s.key);
              return (
                <label key={s.key} style={{
                  display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer",
                  fontFamily: FONTS.mono, fontSize: 11, color: on ? t.text : t.textFaint,
                }}>
                  <input type="checkbox" checked={on} onChange={() => toggleHidden(s.key)} style={{ cursor: "pointer" }} />
                  <span style={{
                    width: 10, height: 10, borderRadius: 2, flexShrink: 0,
                    background: on ? colorFor.get(s.key) : "transparent",
                    border: `1px solid ${colorFor.get(s.key)}`,
                  }} />
                  {s.label}
                </label>
              );
            })}
          </div>
          {barSeries.length > 0
            ? <MissileStackedBarChart series={barSeries} unit={UNIT[view]} timeDomain={TIME_DOMAIN} ticks={TIME_TICKS} colorFor={colorFor} />
            : <div style={{ fontFamily: FONTS.mono, fontSize: 12, color: t.textMuted, padding: 40, textAlign: "center" }}>Select at least one missile type.</div>}
        </>
      )}
    </div>
  );
}
