import { describe, expect, it } from "vitest";
import { formatDay, formatMonth, formatSpan } from "@/utils/dateFormat";

describe("formatDay / formatMonth", () => {
  it("are the ISO date, at their grain", () => {
    expect(formatDay("2026-01-09")).toBe("2026-01-09");
    expect(formatMonth("2026-10")).toBe("2026-10");
    expect(formatMonth("2026-10-14")).toBe("2026-10");
  });
});

describe("formatSpan", () => {
  it("names a span inside one month once", () => {
    expect(formatSpan("2026-01-10", "2026-01-11")).toBe("2026-01-10/11");
  });
  it("names both months across a month boundary", () => {
    expect(formatSpan("2026-01-31", "2026-02-01")).toBe("2026-01-31/02-01");
  });
  it("names both years across a year boundary", () => {
    expect(formatSpan("2025-12-31", "2026-01-01")).toBe("2025-12-31/2026-01-01");
  });
  it("is a plain day for a one-day span", () => {
    expect(formatSpan("2026-01-09", "2026-01-09")).toBe("2026-01-09");
  });
});
