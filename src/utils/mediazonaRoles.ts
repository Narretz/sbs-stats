// Mediazona's weekly roles: the latest version of each week, its raw role
// columns summed into the display groups. Lifted out of useDatabaseMediazona
// so it can be run against a real table in a unit test.

import type { Database } from "sql.js";
import type { MediazonaRoleGroupKey, MediazonaRolesRow } from "@/types";
import { MEDIAZONA_ROLE_COLS, MEDIAZONA_ROLE_GROUPS, MEDIAZONA_ROLE_GROUP_KEYS } from "@/types";
import { queryRows } from "@/hooks/sqlLoader";

// Both tables are append-only / edit-versioned: a week can have multiple rows
// (one per Mediazona release that changed it). Every read resolves to the
// latest version per week — by release (`published_at`), then by ingest
// (`scraped_at`), because releases aren't ingested in order: the backfill adds
// old ones after newer ones. Same ordering as `latest_per_week` in the ingest.
export const latestPerWeek = (table: string) => `(
  SELECT * FROM (
    SELECT d.*, ROW_NUMBER() OVER (
      PARTITION BY week ORDER BY published_at DESC, scraped_at DESC) AS rn
    FROM ${table} d
  ) WHERE rn = 1
) latest`;

// Each raw role column's display group.
const COL_TO_GROUP = new Map<string, MediazonaRoleGroupKey>();
for (const key of MEDIAZONA_ROLE_GROUP_KEYS)
  for (const col of MEDIAZONA_ROLE_GROUPS[key].cols) COL_TO_GROUP.set(col, key);

/** One row per week, oldest first. */
export function queryRolesWeekly(db: Database): MediazonaRolesRow[] {
  // `*`, not the role list: a role added to mediazonaRoles.json reaches the
  // site before the next ingest adds its column, and a missing column must
  // read as 0, not fail the query.
  const rows = queryRows<Record<string, number>>(
    db,
    `SELECT * FROM ${latestPerWeek("weekly_roles")} ORDER BY week ASC`,
  );
  return rows.map((r) => {
    const grouped = MEDIAZONA_ROLE_GROUP_KEYS.reduce((acc, k) => {
      acc[k] = 0;
      return acc;
    }, {} as Record<MediazonaRoleGroupKey, number>);
    for (const col of MEDIAZONA_ROLE_COLS) {
      const g = COL_TO_GROUP.get(col);
      if (g) grouped[g] += typeof r[col] === "number" ? r[col] : 0;
    }
    return { week: String(r.week), total: typeof r.total === "number" ? r.total : 0, ...grouped };
  });
}
