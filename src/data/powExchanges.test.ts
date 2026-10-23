import { describe, expect, it } from "vitest";
import { POW_EXCHANGES, breakdownRatios, powExchangeContext, powExchangeSources, sideBreakdown } from "@/data/powExchanges";
import type { PowExchange } from "@/types";

const ex = (extra: Partial<PowExchange> = {}): PowExchange => ({
  date: "2026-10-23", kind: "exchange", ua_received: 270, ru_received: 270,
  ua_received_civilians: null, ru_received_civilians: null, ua_reported_by: null, ru_reported_by: null,
  deal: null, mediator: null, koord_number: null, status: "confirmed", sources: [], ...extra,
});

describe("powExchangeSources", () => {
  it("names the outlet and what it covers", () => {
    const [s] = powExchangeSources(ex({
      sources: [{ via: "mod_russia (Telegram)", url: "https://t.me/mod_russia/68472", published_at: "2026-10-23T10:00:00+00:00", covers: ["ru_received", "ru_received_civilians"], quote: "" }],
    }));
    expect(s).toEqual({ href: "https://t.me/mod_russia/68472", linkText: "RU MoD", label: "2026-10-23 · Russia, Russia's civilians" });
  });
});

describe("sideBreakdown", () => {
  it("splits a total into military and civilians", () => {
    expect(sideBreakdown(270, 9)).toEqual({ military: 261, civilians: 9 });
  });

  it("knows the military only when the civilians are known", () => {
    expect(sideBreakdown(108, null)).toEqual({ military: null, civilians: null });
    expect(sideBreakdown(null, 8)).toEqual({ military: null, civilians: 8 });
  });
});

describe("breakdownRatios", () => {
  it("divides each column, Ukraine's by Russia's", () => {
    const r = breakdownRatios(ex({ ua_received: 390, ua_received_civilians: 120, ru_received: 390, ru_received_civilians: 120 }));
    expect(r).toEqual({ total: 1, military: 1, civilians: 1 });
  });

  it("has none where a side's split is unknown or Russia's figure is 0", () => {
    const r = breakdownRatios(ex({ ua_received: 84, ua_received_civilians: 51, ru_received: 84, ru_received_civilians: 0 }));
    expect(r.civilians).toBeNull();
    expect(r.military).toBeCloseTo(33 / 84);
    expect(breakdownRatios(ex({ ua_received_civilians: null })).military).toBeNull();
  });
});

describe("powExchangeContext", () => {
  it("joins the kind, the deal and the mediator into one line", () => {
    expect(powExchangeContext(ex({ kind: "release", deal: "Istanbul 2025", mediator: "UAE" }))).toBe("One-way release · Istanbul 2025 · mediator: UAE");
    expect(powExchangeContext(ex())).toBeNull();
  });
});

describe("exchanges.json", () => {
  it("is in date order, one record per day", () => {
    const dates = POW_EXCHANGES.map((e) => e.date);
    expect(dates).toEqual([...dates].sort());
    expect(new Set(dates).size).toBe(dates.length);
  });

  it("sources every figure it states", () => {
    for (const e of POW_EXCHANGES) {
      const covered = new Set(e.sources.flatMap((s) => s.covers));
      for (const k of ["ua_received", "ru_received", "ua_received_civilians", "ru_received_civilians"] as const) {
        if (e[k] != null) expect(covered, `${e.date} ${k}`).toContain(k);
      }
    }
  });

  it("keeps civilians within the total", () => {
    for (const e of POW_EXCHANGES) {
      if (e.ua_received != null && e.ua_received_civilians != null) expect(e.ua_received_civilians, e.date).toBeLessThanOrEqual(e.ua_received);
      if (e.ru_received != null && e.ru_received_civilians != null) expect(e.ru_received_civilians, e.date).toBeLessThanOrEqual(e.ru_received);
    }
  });

  it("numbers the Coordination HQ's exchanges in order", () => {
    const n = POW_EXCHANGES.flatMap((e) => (e.koord_number == null ? [] : [e.koord_number]));
    expect(n).toEqual([...n].sort((a, b) => a - b));
  });
});
