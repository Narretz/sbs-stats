import { describe, expect, it } from "vitest";
import { lastReading, lastReadingsByDay } from "@/utils/hourlyDayTotal";

describe("lastReading", () => {
  it("takes the latest hour's value, not the highest", () => {
    // SBS lowered the running total at 23:00: the day reads 347, not 361.
    expect(lastReading([{ hour: 22, value: 361 }, { hour: 23, value: 347 }])).toBe(347);
  });

  it("goes by hour, not by order", () => {
    expect(lastReading([{ hour: 23, value: 5 }, { hour: 9, value: 9 }])).toBe(5);
  });

  it("skips hours without a value, and is null for a day with none", () => {
    expect(lastReading([{ hour: 10, value: 4 }, { hour: 11, value: null }])).toBe(4);
    expect(lastReading([{ hour: 10, value: null }])).toBeNull();
  });
});

describe("lastReadingsByDay", () => {
  it("gives each day its own last reading", () => {
    const rows = [
      { date: "2026-09-30", hour: 22, w: 361 },
      { date: "2026-09-30", hour: 23, w: 347 },
      { date: "2026-10-21", hour: 23, w: 360 },
    ];
    expect(lastReadingsByDay(rows, "w")).toEqual([347, 360]);
  });
});
