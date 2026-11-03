/// <reference types="node" />
// The regional-repeat rule (countedSql) on in-memory sql.js: the thing
// under test is the SQL itself, and the ingest must apply the same one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import initSqlJs, { type Database } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  countedSql, NATIONAL_SOURCE_PREFIXES, nationalDroneWindowsSql, SHAHED_CLASS_MODELS,
} from "@/utils/airAttacksSql";

const ROOT = join(__dirname, "..", "..");

type Row = [string, string, string, string, string, number]; // start, end, model, category, source, launched

// 13→14 Oct 2026 in miniature, plus the cases the rule must leave alone.
const ROWS: Row[] = [
  ["2026-10-13 18:00", "2026-10-14 09:00", "Shahed-136/131", "drone", "kpszsu/posts/n", 128],
  // Air Command West's slice of that night → not summed
  ["2026-10-13 18:00", "2026-10-14 09:00", "Geran-4", "drone", "PvkZahid/posts/w", 37],
  ["2026-10-13 20:00", "2026-10-14 06:00", "Geran-2 and Geran-4", "drone", "PvkZahid/posts/w3", 5],
  // tactical drones over the front, and a bundle with one → counted
  ["2026-10-13 18:00", "2026-10-14 09:00", "Unknown UAV", "drone", "PvKPivden/posts/s", 20],
  ["2026-10-13 18:00", "2026-10-14 09:00", "Shahed-136/131 and Lancet", "drone", "PvKPivden/posts/s2", 3],
  // a regional Shahed row on a night the national report gave only missiles
  ["2026-10-15 18:00", "2026-10-16 09:00", "Geran-2", "drone", "PvkZahid/posts/w2", 6],
  ["2026-10-15 18:00", "2026-10-16 09:00", "Iskander-M", "ballistic", "kpszsu/posts/n2", 2],
  // the night's national figure posted by the General Staff instead
  ["2026-10-07 18:00", "2026-10-08 09:00", "Shahed-136/131", "drone", "GeneralStaff.ua/posts/g", 142],
  ["2026-10-07 18:00", "2026-10-08 09:00", "Geran-4 and Geran-5", "drone", "PvkZahid/posts/w4", 11],
  // a date-only regional row can't be placed against a night
  ["2026-10-13", "2026-10-13", "Shahed-136/131", "drone", "PvKPivden/posts/d", 4],
];

let db: Database;
beforeAll(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  db.run(`CREATE TABLE latest (time_start TEXT, time_end TEXT, model TEXT, category TEXT, source TEXT, launched INTEGER)`);
  for (const r of ROWS) db.run("INSERT INTO latest VALUES (?, ?, ?, ?, ?, ?)", r);
  db.run(`CREATE TABLE windows AS ${nationalDroneWindowsSql("latest")}`);
  db.run(`CREATE TABLE counted AS ${countedSql("latest", "windows")}`);
});

const counted = () => (db.exec("SELECT source FROM counted")[0]?.values ?? []).map((v) => String(v[0]));

describe("countedSql", () => {
  it("leaves out a regional Shahed-class row inside a national drone report's window", () => {
    expect(counted()).not.toContain("PvkZahid/posts/w");
    expect(counted()).not.toContain("PvkZahid/posts/w3");
  });

  it("keeps the national row, regional tactical drones and mixed bundles", () => {
    expect(counted()).toEqual(expect.arrayContaining(["kpszsu/posts/n", "PvKPivden/posts/s", "PvKPivden/posts/s2"]));
  });

  it("keeps a regional Shahed row when no national drone report covers its night", () => {
    expect(counted()).toContain("PvkZahid/posts/w2");
  });

  it("treats the General Staff's post of the national figure as national", () => {
    expect(counted()).toContain("GeneralStaff.ua/posts/g");
    expect(counted()).not.toContain("PvkZahid/posts/w4");
  });

  it("keeps a date-only regional row", () => {
    expect(counted()).toContain("PvKPivden/posts/d");
  });

  it("names the same Shahed-class models as the ingest", () => {
    const py = readFileSync(join(ROOT, "scripts/missile_attacks/ingest.py"), "utf8");
    const set = py.match(/^SHAHED_CLASS_MODELS = \{([^}]*)\}/m)?.[1] ?? "";
    const names = [...set.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(names).toEqual([...SHAHED_CLASS_MODELS].sort());
    const prefixes = py.match(/^NATIONAL_SOURCE_PREFIXES = \(([^)]*)\)/m)?.[1] ?? "";
    expect([...prefixes.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([...NATIONAL_SOURCE_PREFIXES]);
  });
});
