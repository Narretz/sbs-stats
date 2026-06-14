import { useMemo, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
import {
  COMBINED_METRICS,
  SOURCE_LABELS,
  type CombinedMetric,
  type MetricSource,
  type MetricView,
} from "@/utils/combinedMetrics";

interface Props {
  selected: string[];
  onChange: (next: string[]) => void;
  view: MetricView;
}

const SOURCE_ORDER: MetricSource[] = [
  "sbs",
  "gsua",
  "ru-losses",
  "ru-airdef-mod",
  "ru-air-attacks",
  "sbu-alfa",
];

export function MetricPicker({ selected, onChange, view }: Props) {
  const { theme: t } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const available = useMemo(
    () => COMBINED_METRICS.filter((m) => m.views.includes(view)),
    [view]
  );

  const filtered = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return available;
    // Token-AND match: every whitespace-separated token must appear somewhere
    // in the haystack. Means "sbs person" matches "SBS · Personnel Killed".
    return available.filter((m) => {
      const haystack = `${m.label} ${m.source} ${m.key}`.toLowerCase();
      return tokens.every((tok) => haystack.includes(tok));
    });
  }, [available, query]);

  const grouped = useMemo(() => {
    const map = new Map<MetricSource, CombinedMetric[]>();
    for (const m of filtered) {
      if (!map.has(m.source)) map.set(m.source, []);
      map.get(m.source)!.push(m);
    }
    return SOURCE_ORDER.flatMap((s) => {
      const list = map.get(s);
      return list ? [{ source: s, metrics: list }] : [];
    });
  }, [filtered]);

  const selectedSet = new Set(selected);
  const toggle = (id: string) => {
    if (selectedSet.has(id)) onChange(selected.filter((x) => x !== id));
    else onChange([...selected, id]);
  };

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          background: t.bgAlt,
          color: t.text,
          border: `1px solid ${t.border}`,
          borderRadius: 4,
          padding: "5px 10px",
          fontFamily: FONTS.mono,
          fontSize: 11,
          cursor: "pointer",
        }}
      >
        {selected.length === 0 ? "+ add metric" : `${selected.length} metric${selected.length === 1 ? "" : "s"} ▾`}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 100,
            background: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: 6,
            padding: 8,
            width: 360,
            maxHeight: 480,
            overflowY: "auto",
            boxShadow: "0 4px 20px rgba(0,0,0,0.22)",
          }}
        >
          <input
            autoFocus
            placeholder="Search metrics…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: t.bgAlt,
              color: t.text,
              border: `1px solid ${t.border}`,
              borderRadius: 4,
              padding: "5px 8px",
              fontFamily: FONTS.mono,
              fontSize: 11,
              marginBottom: 8,
            }}
          />
          {grouped.length === 0 && (
            <div style={{ color: t.textMuted, fontFamily: FONTS.mono, fontSize: 11, padding: 6 }}>
              No matches.
            </div>
          )}
          {grouped.map(({ source, metrics }) => (
            <div key={source} style={{ marginBottom: 8 }}>
              <div
                style={{
                  fontFamily: FONTS.display,
                  fontSize: 10,
                  fontWeight: 700,
                  color: t.textMuted,
                  letterSpacing: "0.07em",
                  textTransform: "uppercase",
                  padding: "4px 4px 2px",
                }}
              >
                {SOURCE_LABELS[source]}
              </div>
              {metrics.map((m) => {
                const on = selectedSet.has(m.id);
                return (
                  <label
                    key={m.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "4px 6px",
                      fontFamily: FONTS.mono,
                      fontSize: 11,
                      cursor: "pointer",
                      borderRadius: 3,
                      color: on ? t.text : t.textMuted,
                      background: on ? t.bgAlt : "transparent",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(m.id)}
                      style={{ cursor: "pointer" }}
                    />
                    <span>{m.metricLabel}</span>
                  </label>
                );
              })}
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
            <button
              onClick={() => setOpen(false)}
              style={{
                background: t.bgAlt,
                color: t.text,
                border: `1px solid ${t.border}`,
                borderRadius: 4,
                padding: "4px 10px",
                fontFamily: FONTS.mono,
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
