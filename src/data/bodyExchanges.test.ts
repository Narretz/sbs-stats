import { describe, expect, it } from "vitest";
import { BODY_EXCHANGES, bodyExchangeSources } from "@/data/bodyExchanges";
import type { BodyExchange } from "@/types";

const ex = (ua: number | null, ru: number | null, extra: Partial<BodyExchange> = {}): BodyExchange => ({
  date: "2025-01-01", ua_received: ua, ru_received: ru, ua_reported_by: null, ru_reported_by: null,
  chart_creamy_caprice: null, chart_creamy_caprice_discrepancy: null, status: "confirmed", sources: [], ...extra,
});

describe("bodyExchangeSources", () => {
  it("names the outlet and what it covers", () => {
    const [s] = bodyExchangeSources(ex(1, 1, {
      sources: [{ via: "Koord_shtab (Telegram)", url: "https://t.me/Koord_shtab/1", published_at: "2025-01-01T10:00:00+00:00", covers: ["ua_received"], quote: "" }],
    }));
    expect(s).toEqual({ href: "https://t.me/Koord_shtab/1", linkText: "Koord. HQ", label: "2025-01-01 · Ukraine" });
  });
});

describe("exchanges.json", () => {
  it("is in date order, one record per day", () => {
    const dates = BODY_EXCHANGES.map((e) => e.date);
    expect(dates).toEqual([...dates].sort());
    expect(new Set(dates).size).toBe(dates.length);
  });

  it("sources every figure it states", () => {
    for (const e of BODY_EXCHANGES) {
      const covered = new Set(e.sources.flatMap((s) => s.covers));
      if (e.ua_received != null) expect(covered, e.date).toContain("ua_received");
      if (e.ru_received != null) expect(covered, e.date).toContain("ru_received");
    }
  });
});
