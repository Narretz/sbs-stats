import { describe, expect, it } from "vitest";
import type { ZelenskyWeekRow } from "@/types";
import { UNDERCOUNT_NOTE, formatHedged, formatJetDrones, monthlySources, monthsBetween, mondaysBetween, monthsSpanned, toMonthlyDataset, toWeeklyDataset, weeklySources, weeksInMonthWindow, windowTicks } from "./zelenskyWeekly";

const row = (period_start: string, drones: number | null): ZelenskyWeekRow => ({
  period: "x", period_start, period_end: "x", post_id: 1, posted_at: "x", url: "x",
  drones, drones_bound: drones == null ? null : "at_least",
  bombs: null, bombs_bound: null, missiles: null, missiles_bound: null,
  jet_drones: null, jet_drones_bound: null, jet_drones_pct: null, jet_drones_pct_bound: null,
});

describe("toWeeklyDataset", () => {
  it("keeps weeks without a tally as null slots, not zeros", () => {
    const data = toWeeklyDataset(
      [row("2026-01-05", 1100), row("2026-01-19", null)],
      "drones",
      mondaysBetween("2026-01-05", "2026-01-19"),
    );
    expect(data).toEqual([
      { date: "2026-01-05", value: 1100 },
      { date: "2026-01-12", value: null },  // no post that week
      { date: "2026-01-19", value: null },  // post, but it didn't name drones
    ]);
  });
});

describe("formatHedged", () => {
  it("prefixes the source's hedge", () => {
    expect(formatHedged(3170, "at_least")).toBe("> 3,170");
    expect(formatHedged(1300, "at_most")).toBe("< 1,300");
    expect(formatHedged(60, "approx")).toBe("≈ 60");
    expect(formatHedged(74, "exact")).toBe("74");
  });
  it("says a missing figure was not reported", () => {
    expect(formatHedged(null, null)).toBe("not reported");
  });
});

describe("weeksInMonthWindow", () => {
  const mondays = mondaysBetween("2025-10-27", "2026-03-02");
  it("keeps the weeks whose Monday falls in the window's calendar months", () => {
    const w = weeksInMonthWindow(mondays, 2, "2026-01");
    expect(w[0]).toBe("2025-12-01");
    expect(w[w.length - 1]).toBe("2026-01-26");
    expect(w).toHaveLength(9);
  });
  it("'all' keeps everything up to the end month", () => {
    expect(weeksInMonthWindow(mondays, "all", "2026-03")).toEqual(mondays);
    expect(weeksInMonthWindow(mondays, "all", "2025-10")).toEqual(["2025-10-27"]);
  });
});

describe("monthsSpanned", () => {
  it("counts calendar months inclusively, across a year boundary", () => {
    expect(monthsSpanned("2024-06-10", "2026-11-01")).toBe(30);
    expect(monthsSpanned("2026-01-05", "2026-01-25")).toBe(1);
  });
});

describe("windowTicks", () => {
  it("labels each month in a short window, each quarter in a long one", () => {
    expect(windowTicks(mondaysBetween("2026-01-05", "2026-03-30"))).toEqual(["2026-01-05", "2026-02-02", "2026-03-02"]);
    expect(windowTicks(mondaysBetween("2025-01-06", "2025-12-29"))).toEqual(["2025-01-06", "2025-04-07", "2025-07-07", "2025-10-06"]);
  });
});

describe("weeklySources", () => {
  it("links each week's post under its Monday, as posted in Kyiv time", () => {
    const r = { ...row("2026-01-05", 1100), url: "https://t.me/V_Zelenskiy_official/1", posted_at: "2026-01-11T15:30:00Z" };
    expect(weeklySources([r]).get("2026-01-05")).toEqual([
      { href: "https://t.me/V_Zelenskiy_official/1", linkText: "2026-01-11 17:30 Kyiv", label: "" },
    ]);
  });
});

describe("toMonthlyDataset", () => {
  it("splits a week spanning two months by its daily average", () => {
    // 2026-01-26 – 02-01: six days in January, one in February.
    const data = toMonthlyDataset([row("2026-01-19", 700), row("2026-01-26", 1400)], "drones", ["2026-01", "2026-02"], "2026-02");
    expect(data).toEqual([
      { date: "2026-01", value: 700 + 1200, days_available: 13, note: UNDERCOUNT_NOTE },
      { date: "2026-02", value: 200, days_available: 1 },  // in progress: no note
    ]);
  });
  it("rounds the month's sum, not each day", () => {
    const [jan] = toMonthlyDataset([row("2026-01-05", 1000), row("2026-01-26", 100)], "drones", ["2026-01"], "2026-03");
    expect(jan.value).toBe(Math.round(1000 + (100 * 6) / 7));
  });
  it("leaves days without a figure out of the coverage, and a month with none null", () => {
    const data = toMonthlyDataset([row("2026-01-05", 1000), row("2026-01-12", null)], "drones", ["2026-01", "2026-02"], "2026-03");
    expect(data).toEqual([
      { date: "2026-01", value: 1000, days_available: 7, note: UNDERCOUNT_NOTE },
      { date: "2026-02", value: null, days_available: 0 },
    ]);
  });
});

describe("toMonthlyDataset's undercount note", () => {
  it("is left off a past month every day of which is covered", () => {
    const weeks = mondaysBetween("2025-12-29", "2026-02-02").map((m) => row(m, 70));
    const [jan] = toMonthlyDataset(weeks, "drones", ["2026-01"], "2026-03");
    expect(jan).toEqual({ date: "2026-01", value: 310, days_available: 31 });
  });
});

describe("monthsBetween", () => {
  it("lists every month, across a year boundary", () => {
    expect(monthsBetween("2025-11-24", "2026-02-01")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });
});

describe("monthlySources", () => {
  it("lists a week spanning two months under both, naming the week", () => {
    const r = { ...row("2026-01-26", 1), period_end: "2026-02-01", url: "https://t.me/x/9", posted_at: "2026-02-01T10:00:00Z" };
    const m = monthlySources([r]);
    expect(m.get("2026-01")).toEqual([{ href: "https://t.me/x/9", linkText: "2026-02-01 12:00 Kyiv", label: "week 2026-01-26/02-01" }]);
    expect(m.get("2026-02")).toEqual(m.get("2026-01"));
  });
});

describe("formatJetDrones", () => {
  it("gives the jet-powered drones as the post did: a count, or a share", () => {
    expect(formatJetDrones({ ...row("2026-09-28", 1900), jet_drones: 800, jet_drones_bound: "at_least" })).toBe("> 800");
    expect(formatJetDrones({ ...row("2026-10-05", 1640), jet_drones_pct: 60, jet_drones_pct_bound: "approx" })).toBe("≈ 60%");
  });
  it("is null for a week that gave no figure", () => {
    expect(formatJetDrones(row("2026-10-12", 2700))).toBeNull();
  });
});
