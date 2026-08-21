import { useMemo, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { ChartGrid } from "@/components/Layout";
import { MissileRangeChart } from "@/components/MissileRangeChart";
import { MissileCombinedChart } from "@/components/MissileCombinedChart";
import { buildSeries, TIME_DOMAIN, TIME_TICKS, DATA_WINDOW, MISSILE_TYPES, MISSILE_REPORTS, type MissileKind, type MissileSeries } from "@/data/missiles";
import {
  colorMap,
  MISSILE_CATEGORY,
  MISSILE_CATEGORY_LABEL,
  MISSILE_CATEGORY_ORDER,
  MISSILE_HIDDEN_DEFAULT,
  type MissileCategory,
} from "@/components/missilePalette";
import { FONTS } from "@/theme";

type View = "production" | "stockpile" | "combined";
const VIEWS: View[] = ["production", "stockpile", "combined"];
const VIEW_PARAM = 'missiles-view';
const KIND: Record<"production" | "stockpile", MissileKind> = { production: "production_monthly", stockpile: "stockpile" };
const UNIT: Record<"production" | "stockpile", string> = { production: "units / month", stockpile: "in stockpile" };

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Render `as_of` at its declared precision so a "mid-May 2025" estimate isn't
// misread as a specific calendar day; mirrors MissileRangeChart.fmtAsOf.
function fmtAsOf(as_of: string, precision: "day" | "mid_month" | "month"): string {
  const [y, m, d] = as_of.split("-");
  if (precision === "day") return `${d}.${m}.${y}`;
  if (precision === "mid_month") return `mid-${MONTH_NAMES[+m]} ${y}`;
  return `${MONTH_NAMES[+m]} ${y}`;
}

// URL-param persistence: mirrors the date/days/weekday pattern used on the
// other pages so a deep link captures what the user was looking at.
function parseEnum<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return raw != null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function getUrlParams() {
  const p = new URLSearchParams(window.location.search);
  return {
    view: parseEnum<View>(p.get(VIEW_PARAM), VIEWS, "combined"),
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
  { g: "◇", label: "derived (from yearly or percentage data)" },
  { g: "✕", label: "suspended (0)" },
];

export function MissilesPage() {
  const { theme: t } = useTheme();
  const initial = useMemo(() => getUrlParams(), []);
  const [view, setViewState] = useState<View>(initial.view);
  const setView = (v: View) => { setViewState(v); setUrlParams({ [VIEW_PARAM]: v }); };
  // Tracked as the *hidden* set so defaults persist across view switches and any
  // newly-appearing type defaults to shown.
  const [hidden, setHidden] = useState<Set<string>>(new Set(MISSILE_HIDDEN_DEFAULT));

  // Lumped buckets (one number spanning >1 type, e.g. Zircon+Oniks) make poor
  // trend panels — single sparse points that don't trend and aren't comparable —
  // so the grid shows single-type series only. The combined measurements stay in
  // reports.json for the source view / heatmap.
  const single = (s: MissileSeries) => s.members.length === 1;
  // Both kinds are cheap to build; the "combined" view overlays them per type,
  // and the checkbox "has data" test unions them.
  const stockByKey = useMemo(() => new Map(buildSeries("stockpile").filter(single).map((s) => [s.key, s])), []);
  const prodByKey = useMemo(() => new Map(buildSeries("production_monthly").filter(single).map((s) => [s.key, s])), []);

  const series = useMemo(
    () => (view === "combined" ? [] : buildSeries(KIND[view]).filter(single)),
    [view],
  );

  // "has data in the current view" — for combined, either metric counts.
  const seriesByKey = useMemo(() => {
    const m = new Map<string, MissileSeries | true>();
    if (view === "combined") {
      for (const k of new Set([...stockByKey.keys(), ...prodByKey.keys()])) m.set(k, true);
    } else {
      for (const s of series) m.set(s.key, s);
    }
    return m;
  }, [view, series, stockByKey, prodByKey]);

  // Combined-view panels: one per type present in either metric, ordered by the
  // canonical declaration order and filtered by the checkbox (hidden) set.
  const combinedPanels = useMemo(() => {
    if (view !== "combined") return [];
    const order = Object.keys(MISSILE_TYPES);
    return [...new Set([...stockByKey.keys(), ...prodByKey.keys()])]
      .filter((k) => !hidden.has(k))
      .sort((a, b) => order.indexOf(a) - order.indexOf(b))
      .map((k) => ({ key: k, stock: stockByKey.get(k), prod: prodByKey.get(k) }));
  }, [view, hidden, stockByKey, prodByKey]);

  // Shared log y-domain for the combined grid: [floor, ceil] snapped to powers
  // of 10 spanning every visible point (both metrics). A log axis can't start at
  // 0, so this common floor is the honest analog of a shared "start at 0" — it
  // stops a narrow-range type (KN-23 ~50) from auto-zooming into a fake wiggle
  // and keeps panel heights comparable. Recomputes as types are toggled.
  const combinedYDomain = useMemo<[number, number] | undefined>(() => {
    if (view !== "combined") return undefined;
    let lo = Infinity, hi = -Infinity;
    for (const p of combinedPanels) {
      for (const s of [p.stock, p.prod]) {
        for (const pt of s?.points ?? []) {
          if (pt.low > 0) lo = Math.min(lo, pt.low);
          hi = Math.max(hi, pt.high);
        }
      }
    }
    if (!isFinite(lo) || !isFinite(hi)) return undefined;
    return [10 ** Math.floor(Math.log10(lo)), 10 ** Math.ceil(Math.log10(hi))];
  }, [view, combinedPanels]);

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
    const out: Record<MissileCategory, string[]> = { cruise: [], lowcost_cruise: [], ballistic: [], other: [], drone: [] };
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
            Ukrainian military intelligence (HUR) estimates · irregular disclosures
            <br />
            <span style={{ color: t.textImportant, border: `2px solid ${t.borderImportant}`, display: "inline-block", marginTop: 2, padding: 4, borderRadius: 4 }}>
              These are intelligence estimates, not counts — every value carries a stated bound (≤, ≥, ~, range). Figures vary by ±10% even between reports weeks apart, and the type breakdown changes over time.
            </span>
          </p>
          <details style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
            <summary style={{ cursor: "pointer", listStyle: "revert" }}>
              Data Availability: {DATA_WINDOW.min} – {DATA_WINDOW.max} · {DATA_WINDOW.reports} disclosures
            </summary>
            <ol style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "flex", flexDirection: "column", gap: 6 }}>
              {MISSILE_REPORTS.map((r, i) => (
                <li key={r.as_of + r.reported_at} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                  <span style={{ color: t.textFaint, minWidth: 28 }}>[{i + 1}]</span>
                  <span style={{ color: t.text, minWidth: 110 }}>{fmtAsOf(r.as_of, r.as_of_precision)}</span>
                  <span style={{ minWidth: 60 }}>{r.source.org}</span>
                  <span style={{ flex: 1 }}>
                    {r.source.via}
                    {r.source.url && (
                      <>
                        {" · "}
                        <a
                          href={r.source.url}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                          style={{ color: t.primary, textDecoration: "underline" }}
                        >
                          source ↗
                        </a>
                        {r.source.paywalled && <span style={{ color: t.textFaint }}> (paywalled)</span>}
                      </>
                    )}
                    {r.source.secondary?.map((s) => (
                      <span key={s.url}>
                        {" · "}
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                          style={{ color: t.primary, textDecoration: "underline" }}
                        >
                          {s.via}
                          {s.covers ? ` (${s.covers})` : ""} ↗
                        </a>
                      </span>
                    ))}
                    {r.reported_at !== r.as_of && (
                      <span style={{ color: t.textFaint }}> · disclosed {r.reported_at}</span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </details>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {pill<View>("combined", view, setView, "COMBINED")}
          {pill<View>("production", view, setView, "PRODUCTION")}
          {pill<View>("stockpile", view, setView, "STOCKPILE")}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted }}>
          {LEGEND.map(({ g, label }) => (
            <span key={label}><span style={{ color: t.text }}>{g}</span> {label}</span>
          ))}
          {view === "combined" && <span><span style={{ color: t.text }}>▬</span> stockpile · <span style={{ color: t.text }}>┄</span> production/mo · log y-axis</span>}
        </div>
      </div>

      {/* Type checkboxes, one row per weapon family. Every canonical type is
          listed regardless of whether it has data in the current view — types
          without data render as disabled with a tooltip. Hiding a type also
          drops it from the shared y-scale, so a hidden outlier (e.g. the AD
          pool ~11k) doesn't squash the axis. */}
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
                  : `No ${view === "combined" ? "stockpile or production" : view} data for ${label} in any HUR/GUR disclosure so far.`;
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

      {view === "combined" && (
        combinedPanels.length > 0
          ? (
            <ChartGrid>
              {combinedPanels.map((p) => (
                <MissileCombinedChart
                  key={p.key}
                  stock={p.stock}
                  prod={p.prod}
                  label={MISSILE_TYPES[p.key]?.name ?? p.key}
                  swatch={colorFor.get(p.key)}
                  timeDomain={TIME_DOMAIN}
                  ticks={TIME_TICKS}
                  yDomain={combinedYDomain}
                />
              ))}
            </ChartGrid>
          )
          : <div style={{ fontFamily: FONTS.mono, fontSize: 12, color: t.textMuted, padding: 40, textAlign: "center" }}>Select at least one missile type.</div>
      )}
      {view !== "combined" && (
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

    </div>
  );
}
