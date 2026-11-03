// SQL for the RU air-attacks DB that the hook installs over its in-memory copy
// and the ingest writes into the file (scripts/missile_attacks/ingest.py) —
// the two must agree, which airAttacksSql.test.ts holds them to.

// Shahed-class strike drones: what the national overnight report's UAV count
// covers. Geran-* are Russia's names, used by Air Command West since
// 2026-09-29: Geran-2 is the Shahed-136, Geran-4/5 its jet-powered successors.
// Same set as SHAHED_CLASS_MODELS in the ingest.
export const SHAHED_CLASS_MODELS = ["Geran-2", "Geran-4", "Geran-5", "Shahed-136/131"] as const;

// Posts that carry the national figure: the Air Force's own, and the General
// Staff's when it published the night's count instead (2026-10-07). Same as
// NATIONAL_SOURCE_PREFIXES in the ingest.
export const NATIONAL_SOURCE_PREFIXES = ["kpszsu/", "GeneralStaff.ua/"] as const;

// `latest` minus the regional reports' Shahed-class rows that sit inside a
// national drone report's window. A regional command reports the Shaheds it
// shot down over its region as its own row, and that row is part of the
// national figure, not on top of it: on 13→14 Oct 2026 the national post's
// "128 drones of various types", 115 down, is exactly its own row, and Air
// Command West's Geran-4 37/37 is inside those 115. A regional command's other
// rows — tactical drones over the front, missiles — aren't in the national
// report and count. Windows are compared only when both carry a time.
//
// Two steps: the national drone reports' windows (`nationalDroneWindowsSql`),
// then the rows of `latest` with no regional repeat among them
// (`countedSql`). The hook builds both as tables at load. As a view, the
// per-row window check re-evaluates `latest` (itself a GROUP BY join) for every
// row, on every query that reads it.
const timed = (a: string) => `LENGTH(${a}.time_start) > 10 AND LENGTH(${a}.time_end) > 10`;
const isNational = (a: string) =>
  `(${NATIONAL_SOURCE_PREFIXES.map((p) => `${a}.source LIKE '${p}%'`).join(" OR ")})`;

export function nationalDroneWindowsSql(latest: string): string {
  return `SELECT t.time_start, t.time_end FROM ${latest} t
    WHERE ${isNational("t")} AND t.category = 'drone' AND ${timed("t")}`;
}

export function countedSql(latest: string, nationalWindows: string): string {
  let toks = "'|' || REPLACE(t.model, ' and ', '||') || '|'";
  for (const m of SHAHED_CLASS_MODELS) toks = `REPLACE(${toks}, '|${m}|', '')`;
  return `SELECT t.* FROM ${latest} t
    WHERE NOT (NOT ${isNational("t")}
      AND ${toks} = '' AND ${timed("t")}
      AND EXISTS (SELECT 1 FROM ${nationalWindows} n
        WHERE n.time_start < t.time_end AND t.time_start < n.time_end))`;
}
