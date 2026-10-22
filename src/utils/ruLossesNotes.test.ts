import { describe, expect, it } from "vitest";
import { ruLossesNote } from "@/utils/ruLossesNotes";

describe("ruLossesNote", () => {
  it("flags the days whose personnel figure is not one day's losses", () => {
    for (const d of ["2022-02-24", "2022-03-02", "2025-02-27", "2025-04-21"]) {
      expect(ruLossesNote(d, "personnel")).toBeDefined();
    }
  });

  it("names the correction on a corrected day", () => {
    expect(ruLossesNote("2025-02-27", "personnel")).toMatch(/\+1,650 correction/);
  });

  it("leaves other metrics and other days alone", () => {
    expect(ruLossesNote("2025-02-27", "tanks")).toBeUndefined();
    expect(ruLossesNote("2026-10-21", "personnel")).toBeUndefined();
  });
});
