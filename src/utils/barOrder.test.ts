import { describe, expect, it } from "vitest";
import { livePeriod, parseBarOrder, rankBars, rankingOf, rankQueryDays, windowDayCount, type Ranking } from "@/utils/barOrder";

const TODAY = "2026-11-17";
const liveMonth = (r: { date: string; projected?: number | null }) => r.projected != null || livePeriod(TODAY)(r.date);
const max = (limit: number): Ranking => ({ order: "max", limit });
const min = (limit: number): Ranking => ({ order: "min", limit });

describe("parseBarOrder", () => {
  it("reads the three orders and falls back to date", () => {
    expect(parseBarOrder("max")).toBe("max");
    expect(parseBarOrder("min")).toBe("min");
    expect(parseBarOrder("date")).toBe("date");
    expect(parseBarOrder(null)).toBe("date");
    expect(parseBarOrder("MAX")).toBe("date");
  });
});

describe("rankingOf", () => {
  it("is null in date order", () => {
    expect(rankingOf("date", 30)).toBeNull();
    expect(rankingOf("min", 30)).toEqual({ order: "min", limit: 30 });
  });
});

describe("rankBars", () => {
  const rows = [
    { date: "2026-06", value: 30 },
    { date: "2026-07", value: 50 },
    { date: "2026-08", value: null },
    { date: "2026-09", value: 10 },
    { date: "2026-10", value: 50 },
    { date: "2026-11", value: 5, projected: 40 },
  ];

  it("ranks the largest first, ties by date", () => {
    expect(rankBars(rows, max(10), liveMonth).bars.map((r) => r.date))
      .toEqual(["2026-07", "2026-10", "2026-06", "2026-09"]);
  });

  it("ranks the smallest first", () => {
    expect(rankBars(rows, min(2), liveMonth).bars.map((r) => r.date)).toEqual(["2026-09", "2026-06"]);
  });

  it("leaves out gaps and the period in progress, and counts what it left out", () => {
    const r = rankBars(rows, min(10), liveMonth);
    expect(r.bars.map((b) => b.date)).not.toContain("2026-08");
    expect(r.bars.map((b) => b.date)).not.toContain("2026-11");
    // The gap has no figure to leave out; the month in progress has one.
    expect(r.excluded).toBe(1);
  });

  it("keeps a past month short of days in both orders", () => {
    const short = [{ date: "2026-05", value: 3, days_available: 12 }, { date: "2026-06", value: 9 }];
    expect(rankBars(short, min(10), liveMonth).bars.map((b) => b.date)).toEqual(["2026-05", "2026-06"]);
    expect(rankBars(short, max(10), liveMonth).bars.map((b) => b.date)).toEqual(["2026-06", "2026-05"]);
  });

  it("ranks by another field when told to", () => {
    const pairs = [{ date: "2026-05", hit: 3 }, { date: "2026-06", hit: 9 }];
    expect(rankBars(pairs, max(10), () => false, (r) => r.hit).bars.map((b) => b.date)).toEqual(["2026-06", "2026-05"]);
  });

  it("caps the list at the limit", () => {
    expect(rankBars(rows, max(1), liveMonth).bars).toHaveLength(1);
    expect(rankBars(rows, max(0), liveMonth).bars).toHaveLength(0);
  });
});

describe("livePeriod", () => {
  const live = livePeriod(TODAY);
  it("is the current month, and none before it", () => {
    expect(live("2026-11")).toBe(true);
    expect(live("2026-10")).toBe(false);
  });
  it("is the week whose Monday-keyed span reaches today", () => {
    expect(live("2026-11-16")).toBe(true);  // Mon 16 – Sun 22
    expect(live("2026-11-11")).toBe(true);  // its seventh day is today
    expect(live("2026-11-09")).toBe(false); // Mon 9 – Sun 15
  });
});

describe("rankQueryDays", () => {
  it("is the window in date order", () => {
    expect(rankQueryDays("date", 30, "2026-11-17", "2024-10-01")).toBe(30);
  });
  it("reaches back to the first day when ranked", () => {
    expect(rankQueryDays("max", 30, "2025-11-17", "2024-11-18")).toBe(365);
  });
  it("never queries less than the window", () => {
    expect(rankQueryDays("max", 30, "2026-11-17", "2026-11-01")).toBe(30);
    expect(rankQueryDays("min", 30, "2026-11-17", null)).toBe(30);
  });
});

describe("windowDayCount", () => {
  it("counts the window's days, or its picked weekdays", () => {
    expect(windowDayCount("2026-11-17", 30)).toBe(30);
    // 2026-11-17 is a Tuesday: the 14 days to it hold two Mondays.
    expect(windowDayCount("2026-11-17", 14, (d) => new Date(`${d}T12:00:00`).getDay() === 1)).toBe(2);
  });
});
