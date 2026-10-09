import { describe, expect, it } from "vitest";
import { mediazonaWindow, unionSpan } from "@/utils/mediazonaWindow";
import type { MediazonaEstimateRow, MediazonaRolesRow } from "@/types";

const role = (month: string) => ({ week: `${month}-01`, total: 1 }) as MediazonaRolesRow;
const est = (month: string): MediazonaEstimateRow => ({ week: `${month}-01`, documented: 1, estimate: 2 });

// Names run to June, the estimate stops at March — the shape of the real data.
const ROLES = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"].map(role);
const ESTIMATE = ["2025-12", "2026-01", "2026-02", "2026-03"].map(est);
const months = (rows: { week: string }[]) => rows.map((r) => r.week.slice(0, 7));

describe("unionSpan", () => {
  it("spans every month either series has", () => {
    expect(unionSpan(ROLES, ESTIMATE)).toEqual({ first: "2025-12", last: "2026-06", count: 7 });
    expect(unionSpan([], [])).toEqual({ first: "", last: "", count: 0 });
  });
});

describe("mediazonaWindow", () => {
  it("ends a live window at the later series' last month, for both", () => {
    const w = mediazonaWindow(ROLES, ESTIMATE, 3, "");
    expect(months(w.roles)).toEqual(["2026-04", "2026-05", "2026-06"]);
    // Past the estimate's end: the months are there, empty.
    expect(months(w.estimate)).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(w.estimate.every((r) => r.estimate == null && r.documented == null)).toBe(true);
  });

  it("ends the window at the end month", () => {
    const w = mediazonaWindow(ROLES, ESTIMATE, 2, "2026-02");
    expect(months(w.roles)).toEqual(["2026-01", "2026-02"]);
    expect(w.estimate).toEqual([est("2026-01"), est("2026-02")]);
  });

  it("starts 'all' at the earlier series' first month, padding the other", () => {
    const w = mediazonaWindow(ROLES, ESTIMATE, "all", "");
    expect(months(w.estimate)).toEqual(["2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]);
    // Roles aren't padded: the composition chart has no December row to draw.
    expect(months(w.roles)[0]).toBe("2026-01");
  });
});
