import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  useRubikonDatabaseContext,
  useSbsDatabaseContext,
  useSbuAlfaDatabaseContext,
} from "@/context/databases";
import { useTheme } from "@/hooks/useTheme";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { LoadingScreen, ErrorScreen } from "@/components/Layout";
import { FONTS } from "@/theme";
import {
  COMPARE_ENTITIES,
  SBS_COLUMNS,
  ENTITY_LABELS,
  GROUP_LABELS,
  UNMAPPED_NATIVES,
  fmtPct,
  fmtValue,
  pctChange,
  sumNatives,
  visibleRowsFor,
  type AnyNativeKey,
  type CompareEntityId,
  type CompareGroup,
  type CompareValue,
  type EntitySnapshot,
  type FlatRow,
  type SbsNativeKey,
} from "@/compare/registry";
import type {
  MonthlyRow,
  RubikonCounterRow,
  SbuAlfaBound,
  SbuAlfaCounterRow,
} from "@/types";

interface Props {
  // `?view=sbs-vs-sbu-alfa` is the old hardcoded page's URL. It still resolves,
  // and seeds the two columns it used to show, so saved links land on the same
  // content instead of an empty table.
  preset?: "sbs-vs-sbu-alfa";
}

// A column is one (entity, month) pair. Two columns of the same entity with
// different months IS the month-to-month comparison — no separate mode needed.
interface Column {
  id: number;
  entity: CompareEntityId;
  month: string;
}

// Soft green tint for the largest value in a row. Works as an overlay on both
// themes; not a semantic "success" — it just marks the biggest number.
const HIGHLIGHT_BG = "rgba(34, 197, 94, 0.15)";

const MONTH_RE = /^\d{4}-\d{2}$/;

function readColumnsFromUrl(): Column[] {
  const raw = new URLSearchParams(window.location.search).get("cols");
  if (!raw) return [];
  const out: Column[] = [];
  for (const part of raw.split(",")) {
    const [entity, month] = part.split(":");
    if ((COMPARE_ENTITIES as readonly string[]).includes(entity) && MONTH_RE.test(month ?? "")) {
      out.push({ id: out.length, entity: entity as CompareEntityId, month });
    }
  }
  return out;
}

// Column set lives in the URL so a comparison is linkable. Tweaking columns is
// not a navigation, so replaceState — same rule the homepage uses for its
// filter params.
function writeColumnsToUrl(columns: Column[]) {
  const p = new URLSearchParams(window.location.search);
  if (columns.length) p.set("cols", columns.map((c) => `${c.entity}:${c.month}`).join(","));
  else p.delete("cols");
  window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
}

export function ComparePage({ preset }: Props) {
  const { theme: t } = useTheme();
  useDocumentTitle("Compare");

  const sbs = useSbsDatabaseContext();
  const sbu = useSbuAlfaDatabaseContext();
  const rubikon = useRubikonDatabaseContext();

  const [sbsRows, setSbsRows] = useState<MonthlyRow[]>([]);
  const [sbuRows, setSbuRows] = useState<SbuAlfaCounterRow[]>([]);
  const [rubikonRows, setRubikonRows] = useState<RubikonCounterRow[]>([]);

  useEffect(() => {
    if (sbs.loadState === "ready") setSbsRows(sbs.queryMonthly());
  }, [sbs]);
  useEffect(() => {
    if (sbu.loadState === "ready") setSbuRows(sbu.queryCounters());
  }, [sbu]);
  useEffect(() => {
    if (rubikon.loadState === "ready") setRubikonRows(rubikon.queryCounters());
  }, [rubikon]);

  // ─── Snapshots ────────────────────────────────────────────────────────────
  // Each dataset's rows, reshaped into the one lookup the table needs. Past
  // this point nothing in the page branches on which entity it is holding.
  const sbsSnapshot = useMemo<EntitySnapshot>(() => {
    const byMonth = new Map(sbsRows.map((r) => [r.date, r]));
    return {
      id: "sbs",
      months: [...byMonth.keys()].sort(),
      get(month, key) {
        const row = byMonth.get(month) as Record<string, unknown> | undefined;
        // Rows address SBS by slug ("copter_uav"); the DB column is the target
        // id ("hit_24"). Only SBS keys ever reach this snapshot, so the cast is
        // the union-to-member narrowing the call site already guarantees.
        const v = row?.[SBS_COLUMNS[key as SbsNativeKey]];
        return typeof v === "number" ? { value: v, bound: "exact", derived: false } : null;
      },
    };
  }, [sbsRows]);

  const sbuSnapshot = useMemo<EntitySnapshot>(() => {
    const byKey = new Map(sbuRows.map((r) => [`${r.period}|${r.category}`, r]));
    return {
      id: "sbu-alfa",
      months: [...new Set(sbuRows.map((r) => r.period))].sort(),
      get(month, key) {
        const r = byKey.get(`${month}|${key}`);
        if (!r) return null;
        return {
          value: r.value,
          bound: r.bound,
          derived: r.derived ?? false,
          note: r.derived ? r.derivation_note : (r.raw_label ?? undefined),
        };
      },
    };
  }, [sbuRows]);

  const rubikonSnapshot = useMemo<EntitySnapshot>(() => {
    const byKey = new Map(rubikonRows.map((r) => [`${r.period}|${r.category}`, r]));
    return {
      id: "rubikon",
      months: [...new Set(rubikonRows.map((r) => r.period))].sort(),
      get(month, key) {
        const r = byKey.get(`${month}|${key}`);
        if (!r) return null;
        // Rubikon publishes bare counts — no "понад"-style qualifiers anywhere
        // in the recap, so every value is `exact`.
        return {
          value: r.value,
          bound: "exact" as SbuAlfaBound,
          derived: r.derived ?? false,
          note: r.derived ? r.derivation_note : (r.raw_label ?? undefined),
        };
      },
    };
  }, [rubikonRows]);

  const snapshots = useMemo<Record<CompareEntityId, EntitySnapshot>>(
    () => ({ sbs: sbsSnapshot, "sbu-alfa": sbuSnapshot, rubikon: rubikonSnapshot }),
    [sbsSnapshot, sbuSnapshot, rubikonSnapshot],
  );

  // ─── Columns ──────────────────────────────────────────────────────────────
  const [columns, setColumns] = useState<Column[]>(readColumnsFromUrl);
  const nextId = useRef(1000);
  useEffect(() => { writeColumnsToUrl(columns); }, [columns]);

  // Seed the old page's two columns once the data needed to pick a month is in.
  const presetDone = useRef(false);
  useEffect(() => {
    if (presetDone.current || preset !== "sbs-vs-sbu-alfa") return;
    if (columns.length || readColumnsFromUrl().length) { presetDone.current = true; return; }
    const common = sbsSnapshot.months.filter((m) => sbuSnapshot.months.includes(m));
    if (!common.length) return;
    const month = common[common.length - 1];
    presetDone.current = true;
    setColumns([
      { id: nextId.current++, entity: "sbs", month },
      { id: nextId.current++, entity: "sbu-alfa", month },
    ]);
  }, [preset, columns.length, sbsSnapshot, sbuSnapshot]);

  // Every month any dataset covers — the global picker's options. A month one
  // entity lacks is still selectable; that column just reads "—", which is the
  // honest answer.
  const allMonths = useMemo(() => {
    const set = new Set<string>();
    for (const e of COMPARE_ENTITIES) snapshots[e].months.forEach((m) => set.add(m));
    return [...set].sort().reverse();
  }, [snapshots]);

  // The global control shows a month only when every column already agrees on
  // one; otherwise it sits on "Mixed" until used.
  const globalMonth = useMemo(() => {
    if (!columns.length) return "";
    const first = columns[0].month;
    return columns.every((c) => c.month === first) ? first : "";
  }, [columns]);

  const setAllMonths = (month: string) =>
    setColumns((cs) => cs.map((c) => ({ ...c, month })));

  const addColumn = (entity: CompareEntityId) => {
    const months = snapshots[entity].months;
    // New columns follow the global month when there is one, so adding an
    // entity to an existing comparison lines up by default.
    const month =
      (globalMonth && months.includes(globalMonth) ? globalMonth : "") ||
      months[months.length - 1] ||
      allMonths[0];
    if (!month) return;
    setColumns((cs) => [...cs, { id: nextId.current++, entity, month }]);
  };

  const setColumnMonth = (id: number, month: string) =>
    setColumns((cs) => cs.map((c) => (c.id === id ? { ...c, month } : c)));

  const removeColumn = (id: number) => setColumns((cs) => cs.filter((c) => c.id !== id));

  // ─── Cell values ──────────────────────────────────────────────────────────
  // Canonical rows: only those at least one selected entity can actually fill.
  // A row no column maps (Aircraft with Rubikon-only columns) would be a line
  // of dashes that never populates, so it's dropped rather than shown empty.
  const entitiesInUse = useMemo(
    () => [...new Set(columns.map((c) => c.entity))],
    [columns],
  );

  const visibleRows = useMemo(() => visibleRowsFor(entitiesInUse), [entitiesInUse]);

  const valueFor = (col: Column, keys: readonly AnyNativeKey[] | undefined): CompareValue | null =>
    sumNatives(snapshots[col.entity], col.month, keys);

  // A scope caveat describes the entity's bucket, not the month, so repeating
  // it under every column of the same entity is noise
  const firstColOfEntity = useMemo(() => {
    const seen = new Map<CompareEntityId, number>();
    columns.forEach((c, i) => { if (!seen.has(c.entity)) seen.set(c.entity, i); });
    return seen;
  }, [columns]);

  const scopesFor = (row: FlatRow) =>
    columns.map((c, i) =>
      firstColOfEntity.get(c.entity) === i ? row.scope?.[c.entity] : undefined,
    );

  // "Only in <entity>" sections, in the order their entities first appear as
  // columns. A native counter is listed only if it actually carries a non-zero
  // value in one of that entity's selected months — SBS alone has ~20 target
  // ids outside the shared mapping, most of them empty in any given month.
  const unmappedSections = useMemo(() => {
    return entitiesInUse.map((entity) => {
      const cols = columns.filter((c) => c.entity === entity);
      const natives = UNMAPPED_NATIVES[entity].filter((n) =>
        cols.some((c) => {
          const v = snapshots[entity].get(c.month, n.key);
          return v != null && v.value !== 0;
        }),
      );
      return { entity, natives };
    }).filter((s) => s.natives.length > 0);
  }, [entitiesInUse, columns, snapshots]);

  const loading =
    sbs.loadState === "loading" || sbu.loadState === "loading" || rubikon.loadState === "loading";
  const errored =
    sbs.loadState === "error" || sbu.loadState === "error" || rubikon.loadState === "error";
  const errorMsg = sbs.error ?? sbu.error ?? rubikon.error ?? "";

  // ─── Render helpers ───────────────────────────────────────────────────────
  const cellStyle = (highlight: boolean) => ({
    padding: "6px 16px",
    textAlign: "right" as const,
    fontVariantNumeric: "tabular-nums" as const,
    background: highlight ? HIGHLIGHT_BG : undefined,
    borderBottom: `1px solid ${t.border}`,
    verticalAlign: "top" as const,
  });

  // One table row: values across every column, the largest tinted, and — from
  // the second column on — its change against the leftmost one.
  function renderCells(values: (CompareValue | null)[], scopes?: (string | undefined)[]) {
    const nums = values.filter((v): v is CompareValue => v != null).map((v) => v.value);
    const max = nums.length > 1 ? Math.max(...nums) : null;
    const uniqueMax = max != null && nums.filter((n) => n === max).length === 1;
    const base = values[0];
    return values.map((v, i) => {
      const pct = i === 0 ? null : pctChange(base, v);
      return (
        <td key={i} style={cellStyle(uniqueMax && v != null && v.value === max)}>
          <div title={v?.note ?? undefined}>
            {v != null ? fmtValue(v) : "—"}
            {pct != null && (
              <span style={{ color: t.textMuted, marginLeft: 6, fontSize: 11 }}>
                ({fmtPct(pct)})
              </span>
            )}
            {v?.derived && (
              <span style={{ color: t.textFaint, marginLeft: 4 }} title="Derived by this app, not stated by the source">*</span>
            )}
          </div>
          {scopes?.[i] && (
            <div style={{ fontSize: 10, color: t.textMuted, marginTop: 2, fontStyle: "italic" }}>
              {scopes[i]}
            </div>
          )}
        </td>
      );
    });
  }

  const sectionHeader = (label: string, topBorder: boolean) => (
    <tr>
      <td colSpan={columns.length + 1} style={{
        padding: "10px 16px 4px",
        fontFamily: FONTS.display, fontWeight: 700, fontSize: 11,
        textTransform: "uppercase", letterSpacing: "0.08em",
        color: t.textMuted,
        borderTop: topBorder ? `1px solid ${t.border}` : undefined,
        background: t.bgAlt,
      }}>
        {label}
      </td>
    </tr>
  );

  const selectStyle = {
    fontFamily: FONTS.mono, fontSize: 11,
    padding: "4px 6px",
    background: t.surface, color: t.text,
    border: `1px solid ${t.border}`, borderRadius: 4,
  };

  const groups: CompareGroup[] = ["activity", "personnel", "struck"];

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexDirection: "column", marginBottom: 16 }}>
        <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
          Compare units
        </h1>
        <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3, maxWidth: 900, lineHeight: 1.55 }}>
          Side-by-side monthly claims. Add a column per unit and month — two columns of the same
          unit compare its months against each other. Every figure is a unit self-report: treat
          them as claims, not verified counts, and note that the same physical target is often
          claimed by more than one unit. The units also differ enormously in size (SBS is a whole
          branch; «Альфа» and «Рубикон» are single formations) and «Рубикон» reports Ukrainian
          losses where the other two report Russian ones, so a row is a comparison of claims, not
          of the same objects.
        </p>
      </div>

      {/* Toolbar: global month + add column. Always visible, including on the
          empty table, since it is the only way to populate it. */}
      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}>
        <label style={{ fontFamily: FONTS.mono, fontSize: 12, color: t.textMuted }}>
          Month (all columns):{" "}
          <select
            data-testid="compare-global-month"
            value={globalMonth}
            onChange={(e) => e.target.value && setAllMonths(e.target.value)}
            disabled={!columns.length}
            style={selectStyle}
          >
            {!globalMonth && <option value="">{columns.length ? "Mixed" : "—"}</option>}
            {allMonths.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>

        <label style={{ fontFamily: FONTS.mono, fontSize: 12, color: t.textMuted }}>
          Add column:{" "}
          <select
            data-testid="compare-add-column"
            value=""
            onChange={(e) => {
              if (e.target.value) addColumn(e.target.value as CompareEntityId);
              e.target.value = "";
            }}
            style={selectStyle}
          >
            <option value="">+ pick a unit…</option>
            {COMPARE_ENTITIES.map((e) => (
              <option key={e} value={e}>{ENTITY_LABELS[e]}</option>
            ))}
          </select>
        </label>

        {columns.length > 1 && (
          <span style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted }}>
            % change is against the baseline column
          </span>
        )}
      </div>

      {loading && !sbsRows.length && !sbuRows.length && !rubikonRows.length && (
        <LoadingScreen message="Loading databases…" />
      )}
      {errored && <ErrorScreen message={errorMsg} />}

      {columns.length === 0 && !loading && (
        <div style={{
          background: t.surface, border: `1px dashed ${t.border}`, borderRadius: 8,
          padding: "28px 16px", textAlign: "center",
          fontFamily: FONTS.mono, fontSize: 12, color: t.textMuted,
        }}>
          Empty comparison — add a column above to begin.
        </div>
      )}

      {columns.length > 0 && (
        <>
          <div style={{
            background: t.surface, border: `1px solid ${t.surfaceBorder}`, borderRadius: 8,
            padding: "8px 0", boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
            overflowX: "auto",
          }}>
            <table style={{
              width: "100%", borderCollapse: "collapse",
              fontFamily: FONTS.mono, fontSize: 13,
            }}>
              <thead>
                <tr style={{ color: t.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  <th style={{ textAlign: "left", padding: "8px 16px", borderBottom: `1px solid ${t.border}` }}>
                    Category
                  </th>
                  {columns.map((c, i) => (
                    <th key={c.id} style={{
                      textAlign: "right", padding: "8px 16px",
                      borderBottom: `1px solid ${t.border}`, verticalAlign: "top",
                      whiteSpace: "nowrap",
                    }}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}>
                        <span style={{ color: t.text }}>{ENTITY_LABELS[c.entity]}</span>
                        <button
                          onClick={() => removeColumn(c.id)}
                          title="Remove column"
                          style={{
                            background: "none", border: "none", cursor: "pointer",
                            color: t.textMuted, fontSize: 13, lineHeight: 1, padding: "0 2px",
                          }}
                        >
                          ✕
                        </button>
                      </div>
                      <div style={{ marginTop: 4 }}>
                        <select
                          value={c.month}
                          onChange={(e) => setColumnMonth(c.id, e.target.value)}
                          style={{ ...selectStyle, textTransform: "none" }}
                        >
                          {/* A month the global picker set but this entity
                              never covered still needs an option, or the
                              select would render blank. */}
                          {!snapshots[c.entity].months.includes(c.month) && (
                            <option value={c.month}>{c.month} (no data)</option>
                          )}
                          {[...snapshots[c.entity].months].reverse().map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      </div>
                      {i === 0 && columns.length > 1 && (
                        <div style={{ marginTop: 4, color: t.textFaint, fontSize: 9, textTransform: "none", letterSpacing: 0 }}>
                          baseline
                        </div>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((group, gi) => {
                  const rowsInGroup = visibleRows.filter((r) => r.group === group);
                  if (!rowsInGroup.length) return null;
                  return (
                    <Fragment key={group}>
                      {sectionHeader(GROUP_LABELS[group], gi > 0)}
                      {rowsInGroup.map((r) => (
                        <tr key={r.id}>
                          <td style={{
                            padding: r.indent ? "6px 16px 6px 32px" : "6px 16px",
                            color: r.indent ? t.textMuted : t.text,
                            borderBottom: `1px solid ${t.border}`,
                            verticalAlign: "top",
                          }}>
                            {r.label}
                          </td>
                          {renderCells(
                            columns.map((c) => valueFor(c, r.map[c.entity])),
                            scopesFor(r),
                          )}
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}

                {unmappedSections.map(({ entity, natives }) => (
                  <Fragment key={`unmapped-${entity}`}>
                    {sectionHeader(`Only in ${ENTITY_LABELS[entity]}`, true)}
                    {natives.map((n) => (
                      <tr key={`${entity}-${n.key}`}>
                        <td style={{
                          padding: "6px 16px", color: t.text,
                          borderBottom: `1px solid ${t.border}`, verticalAlign: "top",
                        }}>
                          {n.label}
                        </td>
                        {renderCells(
                          columns.map((c) => (c.entity === entity ? snapshots[entity].get(c.month, n.key) : null)),
                        )}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
