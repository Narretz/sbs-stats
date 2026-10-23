import { describe, expect, it } from "vitest";
import { exchangeRatio, exchangeSheetSources, exchangeTotals, exchangesInWindow, formatRatio } from "@/data/exchanges";
import type { ExchangeRecord } from "@/types";

const ex = (ua: number | null, ru: number | null, extra: Partial<ExchangeRecord> = {}): ExchangeRecord => ({
  date: "2025-01-01", ua_received: ua, ru_received: ru, status: "confirmed", sources: [], ...extra,
});

describe("exchangeTotals", () => {
  it("sums each side", () => {
    expect(exchangeTotals([ex(100, 10), ex(50, 5)])).toMatchObject({ exchanges: 2, toUkraine: 150, toRussia: 15, russiaUnknown: 0 });
  });

  it("counts an unknown figure apart from a real 0, on either side", () => {
    const t = exchangeTotals([ex(1200, 0), ex(80, null), ex(null, 390)]);
    expect(t.toRussia).toBe(390);
    expect(t.russiaUnknown).toBe(1);
    expect(t.toUkraine).toBe(1280);
    expect(t.ukraineUnknown).toBe(1);
  });

  it("takes the ratio only over exchanges both sides reported", () => {
    // The 80 with no Russian count must not inflate it.
    expect(exchangeTotals([ex(100, 10), ex(80, null)]).ratio).toBe(10);
    expect(exchangeTotals([ex(80, null)]).ratio).toBeNull();
  });
});

describe("exchangesInWindow", () => {
  const rows = ["2025-04-18", "2025-05-16", "2025-06-11", "2025-06-13", "2025-07-17"].map((date) => ex(1, 1, { date }));
  const dates = (r: ExchangeRecord[]) => r.map((e) => e.date);

  it("keeps every exchange of the window's calendar months", () => {
    // Two months, two of them in June: counted by month, not by row.
    expect(dates(exchangesInWindow(rows, 2, "2025-06"))).toEqual(["2025-05-16", "2025-06-11", "2025-06-13"]);
  });

  it("ends at the end month, or runs from the start with all", () => {
    expect(dates(exchangesInWindow(rows, "all", "2025-05"))).toEqual(["2025-04-18", "2025-05-16"]);
  });

  it("is empty for a window with no exchange", () => {
    expect(exchangesInWindow(rows, 3, "2025-02")).toEqual([]);
  });
});

describe("exchangeRatio", () => {
  it("divides Ukraine's count by Russia's", () => {
    expect(exchangeRatio(ex(252, 25))).toBeCloseTo(10.08);
  });

  it("has none for a one-way transfer or a missing figure", () => {
    expect(exchangeRatio(ex(1200, 0))).toBeNull();
    expect(exchangeRatio(ex(51, null))).toBeNull();
    expect(exchangeRatio(ex(null, 51))).toBeNull();
  });
});

describe("exchangeSheetSources", () => {
  const src = (url: string, covers: string[]) => ({ via: "X (Telegram)", url, published_at: "2025-01-01T10:00:00+00:00", covers, quote: "" });

  it("makes one link per post, with every figure it backs", () => {
    const links = exchangeSheetSources(
      [src("https://t.me/x/1", ["ua_received"]), src("https://t.me/x/1", ["ua_received_civilians"]), src("https://t.me/y/2", ["ru_received"])],
      { "X (Telegram)": "X" }, { ua_received: "Ukraine", ua_received_civilians: "Ukraine's civilians", ru_received: "Russia" },
    );
    expect(links).toEqual([
      { href: "https://t.me/x/1", linkText: "X", label: "2025-01-01 · Ukraine, Ukraine's civilians" },
      { href: "https://t.me/y/2", linkText: "X", label: "2025-01-01 · Russia" },
    ]);
  });
});

describe("formatRatio", () => {
  it("keeps one decimal, dropping it when it is 0", () => {
    expect(formatRatio(1)).toBe("1:1");
    expect(formatRatio(0.9999)).toBe("1:1");
    expect(formatRatio(10.08)).toBe("10.1:1");
    expect(formatRatio(33 / 84)).toBe("0.4:1");
    expect(formatRatio(null)).toBeNull();
  });
});
