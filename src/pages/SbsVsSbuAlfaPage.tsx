import { Fragment, useEffect, useMemo, useState } from "react";
import { useSbsDatabaseContext } from "@/context/databases";
import { useSbuAlfaDatabaseContext } from "@/context/databases";
import { useTheme } from "@/hooks/useTheme";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { LoadingScreen, ErrorScreen } from "@/components/Layout";
import { FONTS } from "@/theme";
import type {
  MonthlyRow,
  SbuAlfaCategoryKey,
  SbuAlfaCounterRow,
  StatKey,
} from "@/types";

// One row in the comparison table. The SBS side aggregates one or more
// `hit_<id>` columns (or personnel_killed for the Personnel group); the SBU
// side reads one category value from the recap. Groups map to a header row
// above their members so the reader sees WHICH measurement axis the row
// belongs to — personnel are "killed" (no hit/damaged distinction), all the
// equipment rows are "struck" (уражено = hit, includes damaged).
type CompareGroup = "killed" | "struck";
interface Row {
  group: CompareGroup;
  label: string;
  indent?: boolean;
  sbu: SbuAlfaCategoryKey;
  sbs: StatKey[]; // summed
  // Small caveats shown under each side's number so the reader knows what's
  // in the bucket (and — importantly — what's in one side but not the other,
  // e.g. SBU's drone total also folding in ground robotic complexes).
  sbsScope?: string;
  sbuScope?: string;
}

// Descriptions were transcribed from src/types/index.ts TARGET_LABELS (SBS
// side) and scripts/sbu_alfa/parse.py category regexes / SBU raw phrasing
// (SBU side). Only rows where the scope is non-obvious carry a note.
const ROWS: Row[] = [
  {
    group: "killed", label: "Personnel", sbu: "enemy_kia", sbs: ["personnel_killed"],
    sbsScope: "personnel_killed",
    sbuScope: 'always phrased "понад N" (floor)',
  },
  {
    group: "struck", label: "Drones (UAVs + UGVs)", sbu: "drones",
    // id 26 = "Ворожі НРК" (enemy UGVs / ground robotic complexes).
    // Summed in so both sides count the same "БпЛА + наземних
    // роботизованих комплексів" bucket SBU's monthly recap uses.
    sbs: ["hit_24", "hit_25", "hit_30", "hit_31", "hit_26"],
    sbsScope: "Copters + Fixed-wing + Shahed + Gerbera + UGVs",
    sbuScope: "БпЛА та наземних роботизованих комплексів різного типу (НРК)",
  },
  {
    group: "struck", label: "Vehicles (autos)", sbu: "vehicles_auto_total", sbs: ["hit_7", "hit_19"],
    sbsScope: "Vehicles + Military buggies — excludes motorcycles",
    sbuScope: 'одиниць автомобільної техніки; may bundle motorcycles',
  },
  {
    group: "struck", label: "Artillery / SPGs", sbu: "artillery", sbs: ["hit_3", "hit_4"],
    sbsScope: "Cannons/Howitzers + Self-Propelled Artillery",
    sbuScope: "артилерійських систем і САУ",
  },
  {
    group: "struck", label: "Armored (total)", sbu: "armored_total", sbs: ["hit_1", "hit_2"],
    sbsScope: "Tanks + APCs / IFVs / ACVs",
    sbuScope: "одиниць броньованої техніки (танки + ББМ)",
  },
  { group: "struck", label: "Tanks", sbu: "tanks", sbs: ["hit_1"], indent: true },
  {
    group: "struck", label: "IFVs / APCs", sbu: "ifvs", sbs: ["hit_2"], indent: true,
    sbsScope: "APCs / IFVs / ACVs",
    sbuScope: "бойових броньованих машин",
  },
  {
    group: "struck", label: "Air defense", sbu: "air_defense", sbs: ["hit_32", "hit_33"],
    sbsScope: "SAM + AA guns",
    sbuScope: "засобів ППО / протиповітряної оборони",
  },
  {
    group: "struck", label: "MLRS", sbu: "mlrs", sbs: ["hit_5"],
    sbsScope: "MLRS",
    sbuScope: "РСЗВ",
  },
  {
    // SBU switched from bare "N РЛС" (Apr/May) to "N засоби РЛС та РЕБ" (Jun);
    // parser stores both under `radar`. SBS's closest bucket is id 9 (vehicle-
    // mounted radar/ELINT/comms complexes) — slightly broader than pure РЛС
    // but the tightest match. hit_8 (trench radar/comms) is deliberately left
    // out — it would inflate SBS with static installations SBU wouldn't count.
    group: "struck", label: "Radars", sbu: "radar", sbs: ["hit_9"],
    sbsScope: "РЛС, РЕР та зв'язок (комплекси) — vehicle-mounted",
    sbuScope: "РЛС (Apr/May); від Jun bundles РЕБ (EW)",
  },
  {
    group: "struck", label: "Aircraft", sbu: "aircraft", sbs: ["hit_29", "hit_41"],
    sbsScope: "Helicopters + Fixed-wing planes",
    sbuScope: "літак / одиниць авіаційної техніки",
  },
  {
    group: "struck", label: "Fleet / watercraft", sbu: "watercraft", sbs: ["hit_42"],
    sbsScope: "Флот (id 42) — naval targets",
    sbuScope: "одиниць водного транспорту",
  },
];

const GROUP_LABELS: Record<CompareGroup, string> = {
  killed: "Killed",
  struck: "Hit / struck (уражено)",
};

// Soft green tint for the higher of the two values. Works on both light and
// dark themes as an overlay; not a semantic "success" — it just marks the
// winner cell.
const HIGHLIGHT_BG = "rgba(34, 197, 94, 0.22)";

function fmt(n: number): string {
  return n.toLocaleString();
}

// Bound prefix mirrors the SBU chart tooltips — "≥" for "понад", etc.
function withBound(v: number, bound: SbuAlfaCounterRow["bound"] | undefined): string {
  const s = fmt(v);
  if (bound === "at_least") return `≥ ${s}`;
  if (bound === "approx") return `~${s}`;
  if (bound === "up_to") return `≤ ${s}`;
  return s;
}

function sumStatCols(row: MonthlyRow, cols: StatKey[]): number | null {
  let total = 0;
  let anyPresent = false;
  for (const c of cols) {
    const v = row[c];
    if (typeof v === "number") {
      total += v;
      anyPresent = true;
    }
  }
  return anyPresent ? total : null;
}

export function SbsVsSbuAlfaPage() {
  const { theme: t } = useTheme();
  useDocumentTitle("SBS (USF) vs SBU «Альфа»");
  const sbs = useSbsDatabaseContext();
  const sbu = useSbuAlfaDatabaseContext();

  const [sbsRows, setSbsRows] = useState<MonthlyRow[]>([]);
  const [sbuRows, setSbuRows] = useState<SbuAlfaCounterRow[]>([]);

  useEffect(() => {
    if (sbs.loadState === "ready") setSbsRows(sbs.queryMonthly());
  }, [sbs]);
  useEffect(() => {
    if (sbu.loadState === "ready") setSbuRows(sbu.queryCounters());
  }, [sbu]);

  // Months present in BOTH datasets, descending (newest default). SBU's
  // `period` is already YYYY-MM; SBS's queryMonthly returns YYYY-MM as `date`.
  const commonMonths = useMemo(() => {
    const sbsMonths = new Set(sbsRows.map((r) => r.date));
    const sbuMonths = new Set(sbuRows.map((r) => r.period));
    return [...sbsMonths].filter((m) => sbuMonths.has(m)).sort().reverse();
  }, [sbsRows, sbuRows]);

  const [month, setMonth] = useState<string | null>(null);
  useEffect(() => {
    if (month == null && commonMonths.length) setMonth(commonMonths[0]);
  }, [commonMonths, month]);

  const sbsMonthRow = useMemo(
    () => sbsRows.find((r) => r.date === month) ?? null,
    [sbsRows, month],
  );
  const sbuByCategory = useMemo(() => {
    const map = new Map<SbuAlfaCategoryKey, SbuAlfaCounterRow>();
    for (const r of sbuRows) if (r.period === month) map.set(r.category, r);
    return map;
  }, [sbuRows, month]);

  const loading = sbs.loadState === "loading" || sbu.loadState === "loading";
  const errored = sbs.loadState === "error" || sbu.loadState === "error";
  const errorMsg = sbs.error ?? sbu.error ?? "";

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexDirection: "column", marginBottom: 16 }}>
        <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
          SBS (USF) vs SBU «Альфа»
        </h1>
        <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3, maxWidth: 900, lineHeight: 1.55 }}>
          Side-by-side monthly claim comparison. SBU «Альфа» is one SSU special-ops formation; SBS
          (Сили безпілотних систем / Ukraine's Unmanned Systems Forces) is a whole branch. Both are
          unit self-reports — treat as claims, not verified counts, and note that the same physical
          target is often claimed by more than one unit. Fortifications are excluded because SBS
          reports them at roughly 10× SBU's scale, which doesn't fit the "same measurement"
          intuition of the table.
        </p>
      </div>

      {loading && sbsRows.length === 0 && <LoadingScreen message="Loading SBS + SBU Alfa databases…" />}
      {errored && <ErrorScreen message={errorMsg} />}

      {commonMonths.length > 0 && month && (
        <>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}>
            <label style={{ fontFamily: FONTS.mono, fontSize: 12, color: t.textMuted }}>
              Month:{" "}
              <select
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                style={{
                  fontFamily: FONTS.mono, fontSize: 12,
                  padding: "4px 8px",
                  background: t.surface, color: t.text,
                  border: `1px solid ${t.border}`, borderRadius: 4,
                }}
              >
                {commonMonths.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
            <span style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted }}>
              {commonMonths.length} month{commonMonths.length === 1 ? "" : "s"} available in both datasets
            </span>
          </div>

          <div style={{
            background: t.surface, border: `1px solid ${t.surfaceBorder}`, borderRadius: 8,
            padding: "8px 0", boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
            overflow: "hidden",
          }}>
            <table style={{
              width: "100%", borderCollapse: "collapse",
              fontFamily: FONTS.mono, fontSize: 13,
            }}>
              <thead>
                <tr style={{ color: t.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  <th style={{ textAlign: "left",  padding: "8px 16px", borderBottom: `1px solid ${t.border}` }}>Category</th>
                  <th style={{ textAlign: "right", padding: "8px 16px", borderBottom: `1px solid ${t.border}` }}>SBS (USF)</th>
                  <th style={{ textAlign: "right", padding: "8px 16px", borderBottom: `1px solid ${t.border}` }}>SBU «Альфа»</th>
                </tr>
              </thead>
              <tbody>
                {(["killed", "struck"] as CompareGroup[]).map((group) => {
                  const rowsInGroup = ROWS.filter((r) => r.group === group);
                  return (
                    <Fragment key={group}>
                      <tr>
                        <td colSpan={3} style={{
                          padding: "10px 16px 4px",
                          fontFamily: FONTS.display, fontWeight: 700, fontSize: 11,
                          textTransform: "uppercase", letterSpacing: "0.08em",
                          color: t.textMuted,
                          borderTop: group === "struck" ? `1px solid ${t.border}` : undefined,
                          background: t.bgAlt,
                        }}>
                          {GROUP_LABELS[group]}
                        </td>
                      </tr>
                      {rowsInGroup.map((r) => {
                        const sbsVal = sbsMonthRow ? sumStatCols(sbsMonthRow, r.sbs) : null;
                        const sbuRow = sbuByCategory.get(r.sbu);
                        const sbuVal = sbuRow ? sbuRow.value : null;
                        // "Higher" comparison uses raw magnitude — even if the
                        // SBU value carries a "≥" bound, we still compare on
                        // the stated number for the highlight.
                        const sbsHigher = sbsVal != null && sbuVal != null && sbsVal >  sbuVal;
                        const sbuHigher = sbsVal != null && sbuVal != null && sbuVal >  sbsVal;
                        return (
                          <tr key={r.label}>
                            <td style={{
                              padding: r.indent ? "6px 16px 6px 32px" : "6px 16px",
                              color: r.indent ? t.textMuted : t.text,
                              borderBottom: `1px solid ${t.border}`,
                              verticalAlign: "top",
                            }}>
                              {r.label}
                            </td>
                            <td style={{
                              padding: "6px 16px", textAlign: "right",
                              fontVariantNumeric: "tabular-nums",
                              background: sbsHigher ? HIGHLIGHT_BG : undefined,
                              borderBottom: `1px solid ${t.border}`,
                              verticalAlign: "top",
                            }}>
                              <div>{sbsVal != null ? fmt(sbsVal) : "—"}</div>
                              {r.sbsScope && (
                                <div style={{
                                  fontSize: 10, color: t.textMuted, marginTop: 2,
                                  fontStyle: "italic", fontWeight: 400,
                                }}>
                                  {r.sbsScope}
                                </div>
                              )}
                            </td>
                            <td style={{
                              padding: "6px 16px", textAlign: "right",
                              fontVariantNumeric: "tabular-nums",
                              background: sbuHigher ? HIGHLIGHT_BG : undefined,
                              borderBottom: `1px solid ${t.border}`,
                              verticalAlign: "top",
                            }}>
                              <div>{sbuVal != null ? withBound(sbuVal, sbuRow?.bound) : "—"}</div>
                              {r.sbuScope && (
                                <div style={{
                                  fontSize: 10, color: t.textMuted, marginTop: 2,
                                  fontStyle: "italic", fontWeight: 400,
                                }}>
                                  {r.sbuScope}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p style={{ fontFamily: FONTS.mono, fontSize: 10, color: t.textMuted, marginTop: 10, lineHeight: 1.55 }}>
            SBS values sum the source's <code>hit_*</code> columns (target IDs mapped in <code>src/types/index.ts</code>).
            SBU values come from its monthly recap; the <code>≥</code> prefix marks the "понад" bound.
            Highlight = larger stated value; the tie case leaves both uncoloured.
          </p>
        </>
      )}
    </div>
  );
}
