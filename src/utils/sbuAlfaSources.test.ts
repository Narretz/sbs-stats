import { describe, expect, it } from "vitest";
import { oneSourcePerPeriod } from "@/utils/sbuAlfaSources";

const ARTICLE = "https://ssu.gov.ua/novyny/alfa-sbu-top1-sered-syl-oborony";
const POST = "https://t.me/SBUkr/19024";
const row = (period: string, url: string, category: string, published_at: string | null = "2026-11-07") =>
  ({ period, url, category, published_at });

describe("oneSourcePerPeriod", () => {
  it("reads a month published both ways from the press release", () => {
    const rows = [
      row("2026-10", POST, "drones"), row("2026-10", POST, "tanks"),
      row("2026-10", ARTICLE, "drones"), row("2026-10", ARTICLE, "tanks"),
    ];
    expect(oneSourcePerPeriod(rows).map((r) => r.url)).toEqual([ARTICLE, ARTICLE]);
  });

  it("reads a month only posted from the post", () => {
    const rows = [row("2026-10", POST, "drones"), row("2026-09", ARTICLE, "drones", "2026-10-10")];
    expect(oneSourcePerPeriod(rows)).toEqual(rows);
  });

  it("takes the earlier of two posts — the original, not a repost", () => {
    const rows = [
      row("2026-10", "https://t.me/SBUkr/19050", "drones", "2026-11-09"),
      row("2026-10", POST, "drones", "2026-11-07"),
    ];
    expect(oneSourcePerPeriod(rows).map((r) => r.url)).toEqual([POST]);
  });
});
