import { describe, expect, it } from "vitest";
import initSqlJs, { type Database } from "sql.js";
import mediazonaRoles from "@/data/mediazonaRoles.json";
import { MEDIAZONA_ROLE_COLS, MEDIAZONA_ROLE_GROUPS, MEDIAZONA_ROLE_GROUP_KEYS } from "@/types";
import { queryRolesWeekly } from "./mediazonaRoles";

describe("mediazonaRoles.json", () => {
  it("puts every role in exactly one known group, and leaves no group empty", () => {
    const keys = new Set<string>(MEDIAZONA_ROLE_GROUP_KEYS);
    for (const r of mediazonaRoles.roles) expect(keys, r.col).toContain(r.group);
    const grouped = MEDIAZONA_ROLE_GROUP_KEYS.flatMap((k) => MEDIAZONA_ROLE_GROUPS[k].cols);
    expect([...grouped].sort()).toEqual([...MEDIAZONA_ROLE_COLS].sort());
    expect(new Set(MEDIAZONA_ROLE_COLS).size).toBe(MEDIAZONA_ROLE_COLS.length);
    for (const k of MEDIAZONA_ROLE_GROUP_KEYS) expect(MEDIAZONA_ROLE_GROUPS[k].cols, k).not.toHaveLength(0);
  });

  it("has conscripts in a group of their own", () => {
    expect(MEDIAZONA_ROLE_GROUPS.conscripts.cols).toEqual(["conscripts"]);
  });
});

async function dbWith(cols: readonly string[], rows: Record<string, number | string>[]): Promise<Database> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE weekly_roles (week TEXT, scraped_at TEXT, published_at TEXT, total INTEGER,
          ${cols.map((c) => `${c} INTEGER NOT NULL DEFAULT 0`).join(", ")})`);
  for (const r of rows) {
    const names = Object.keys(r);
    db.run(`INSERT INTO weekly_roles (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      Object.values(r));
  }
  return db;
}

describe("queryRolesWeekly", () => {
  it("sums each week's latest version into the groups", async () => {
    const db = await dbWith(MEDIAZONA_ROLE_COLS, [
      { week: "2026-10-01", scraped_at: "a", published_at: "2026-10-23", total: 10, rifle: 6, mob: 4 },
      // The next release reclassified 3 riflemen as conscripts.
      { week: "2026-10-01", scraped_at: "b", published_at: "2026-11-06", total: 10, rifle: 3, mob: 4, conscripts: 3 },
    ]);
    const [row] = queryRolesWeekly(db);
    expect(row).toMatchObject({ week: "2026-10-01", total: 10, infantry: 3, mobilized: 4, conscripts: 3 });
  });

  it("reads a role whose column the DB doesn't have yet as 0", async () => {
    // The site deploys before the next ingest adds the `conscripts` column.
    const db = await dbWith(MEDIAZONA_ROLE_COLS.filter((c) => c !== "conscripts"), [
      { week: "2026-10-01", scraped_at: "a", published_at: "2026-10-23", total: 10, rifle: 6, mob: 4 },
    ]);
    const [row] = queryRolesWeekly(db);
    expect(row).toMatchObject({ infantry: 6, mobilized: 4, conscripts: 0 });
  });
});
