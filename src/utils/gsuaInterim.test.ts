import { describe, expect, it } from "vitest";
import { interimNote, interimReportTime } from "@/utils/gsuaInterim";

describe("interimReportTime", () => {
  it("is the report time when the day's latest report is from that same day", () => {
    expect(interimReportTime("2026-10-04", "2026-10-04T22:00:00")).toBe("22:00");
    expect(interimReportTime("2026-07-30", "2026-07-30T16:00:00")).toBe("16:00");
  });

  it("is null once the next morning's wrap-up is in", () => {
    expect(interimReportTime("2026-10-04", "2026-10-05T08:00:00")).toBeNull();
  });

  it("is null without a snapshot", () => {
    expect(interimReportTime("2026-10-04", "")).toBeNull();
    expect(interimReportTime("2026-10-04", null)).toBeNull();
  });
});

describe("interimNote", () => {
  it("names the report", () => {
    expect(interimNote("2026-10-04", "2026-10-04T22:00:00")).toMatch(/^Interim 22:00 report/);
    expect(interimNote("2026-10-04", "2026-10-05T08:00:00")).toBeUndefined();
  });
});
