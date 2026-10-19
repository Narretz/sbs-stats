import { describe, expect, it } from "vitest";
import { airAttackSourcesByDate, citSourcesByDate, formatPostedAt, formatWindow, gsuaSourcesByDate, linksFor, monthlySourcesByPeriod, partLinks, ruModSourcesByDate } from "@/utils/sources";
import type { AirAttackRow } from "@/utils/sources";

describe("formatPostedAt", () => {
  it("reads a post's time in its source's zone", () => {
    expect(formatPostedAt("2026-10-12T18:34:48+00:00", "Europe/Moscow", "Moscow")).toBe("2026-10-12 21:34 Moscow");
    expect(formatPostedAt("2026-10-12T21:30:00+00:00", "Europe/Kyiv", "Kyiv")).toBe("2026-10-13 00:30 Kyiv");
  });
});

describe("formatWindow", () => {
  it("gives both ends in the source's zone, dropping what the end shares", () => {
    expect(formatWindow("2026-10-09T17:00:00+00:00", "2026-10-11T17:00:00+00:00", "Europe/Moscow", "Moscow")).toBe("2026-10-09 20:00 – 10-11 20:00 Moscow");
    expect(formatWindow("2026-09-28T08:00+03:00", "2026-09-28T20:00+03:00", "Europe/Moscow", "Moscow")).toBe("2026-09-28 08:00 – 20:00 Moscow");
    expect(formatWindow("2025-12-31T17:00:00Z", "2026-01-01T17:00:00Z", "Europe/Moscow", "Moscow")).toBe("2025-12-31 20:00 – 2026-01-01 20:00 Moscow");
  });
});

describe("partLinks", () => {
  it("links each part of a multipart report on the same channel", () => {
    expect(partLinks("https://t.me/CIT_shellings/12031", "12031,12032"))
      .toEqual(["https://t.me/CIT_shellings/12031", "https://t.me/CIT_shellings/12032"]);
    expect(partLinks("https://t.me/CIT_shellings/13377", "13377")).toEqual(["https://t.me/CIT_shellings/13377"]);
    expect(partLinks("https://t.me/CIT_shellings/13377", null)).toEqual(["https://t.me/CIT_shellings/13377"]);
  });

  it("numbers the parts in their labels", () => {
    expect(linksFor("https://t.me/c/1", "1,2", "report").map((l) => l.label)).toEqual(["report, part 1 of 2", "report, part 2 of 2"]);
    expect(linksFor("https://t.me/c/1", "1,2", "", "2026-01-01 10:00 Moscow")[1]).toEqual({ href: "https://t.me/c/2", linkText: "2026-01-01 10:00 Moscow", label: "part 2 of 2" });
  });
});

describe("citSourcesByDate", () => {
  it("gives both days of a weekend report its links, and a day its own report's", () => {
    const m = citSourcesByDate([
      { report_date: "2026-10-09", window_days: 1, window_start: "2026-10-08T17:00:00+00:00", window_end: "2026-10-09T17:00:00+00:00", url: "https://t.me/CIT_shellings/13357", part_ids: "13357", posted_at: "2026-10-10T10:58:13+00:00" },
      { report_date: "2026-10-11", window_days: 2, window_start: "2026-10-09T17:00:00+00:00", window_end: "2026-10-11T17:00:00+00:00", url: "https://t.me/CIT_shellings/13377", part_ids: "13377", posted_at: "2026-10-12T18:34:48+00:00" },
    ]);
    expect(m.get("2026-10-09")).toEqual([{ href: "https://t.me/CIT_shellings/13357", linkText: "2026-10-10 13:58 Moscow", label: "2026-10-08 20:00 – 10-09 20:00 Moscow" }]);
    expect(m.get("2026-10-10")).toEqual([{ href: "https://t.me/CIT_shellings/13377", linkText: "2026-10-12 21:34 Moscow", label: "2026-10-09 20:00 – 10-11 20:00 Moscow" }]);
    expect(m.get("2026-10-11")).toEqual(m.get("2026-10-10"));
  });
});

describe("gsuaSourcesByDate", () => {
  const post = (source: string, id: number, snapshot: string | null, posted: string | null = null) =>
    ({ date: "2026-10-12", source, source_id: id, snapshot_at: snapshot, message_date: posted, url: `https://example/${source}/${id}` });

  it("puts the post the figures come from first: the next morning's wrap-up, then the interim", () => {
    const m = gsuaSourcesByDate([
      post("telegram", 42573, "2026-10-12T22:00:00", "2026-10-12T19:00:30+00:00"),
      post("telegram", 42575, "2026-10-13T08:00:00", "2026-10-13T05:02:31+00:00"),
    ]).get("2026-10-12")!;
    expect(m.map((s) => [s.linkText, s.label])).toEqual([
      ["2026-10-13 08:02 Kyiv", "as of 2026-10-13 08:00 Kyiv"],
      ["2026-10-12 22:00 Kyiv", "as of 2026-10-12 22:00 Kyiv (interim)"],
    ]);
  });

  it("drops another platform's copy of a day Telegram has, and names it on a day it doesn't", () => {
    const withTelegram = gsuaSourcesByDate([post("facebook", 9, "2026-10-13T08:00:00"), post("telegram", 1, "2026-10-13T08:00:00")]);
    expect(withTelegram.get("2026-10-12")!.map((s) => s.href)).toEqual(["https://example/telegram/1"]);
    const facebookOnly = gsuaSourcesByDate([post("facebook", 9, "2026-10-13T08:00:00")]);
    expect(facebookOnly.get("2026-10-12")![0].label).toBe("Facebook, as of 2026-10-13 08:00 Kyiv");
  });

  it("names the Cabinet of Ministers' republication by its site", () => {
    const kmu = gsuaSourcesByDate([post("kmu", 1, "2023-05-03T06:00:00")]);
    expect(kmu.get("2026-10-12")![0].label).toBe("kmu.gov.ua, as of 2023-05-03 06:00 Kyiv");
  });

  it("numbers the parts of a report split across posts", () => {
    const m = gsuaSourcesByDate([post("telegram", 11, "2026-10-13T08:00:00"), post("telegram", 10, "2026-10-13T08:00:00")]).get("2026-10-12")!;
    expect(m.map((s) => [s.href, s.label])).toEqual([
      ["https://example/telegram/10", "as of 2026-10-13 08:00 Kyiv, part 1 of 2"],
      ["https://example/telegram/11", "as of 2026-10-13 08:00 Kyiv, part 2 of 2"],
    ]);
  });
});

describe("ruModSourcesByDate", () => {
  it("lists a date's reports in window order, each its post and what it claimed", () => {
    const m = ruModSourcesByDate([
      { report_date: "2026-09-28", post_id: 67721, window_kind: "day", window_start: "2026-09-28T08:00+03:00", window_end: "2026-09-28T20:00+03:00", drones: 14, unit: "uav", posted_at: "2026-09-28T17:47:13+00:00" },
      { report_date: "2026-09-28", post_id: 67700, window_kind: "night", window_start: "2026-09-27T20:00+03:00", window_end: "2026-09-28T08:00+03:00", drones: 254, unit: "uav", posted_at: "2026-09-28T06:04:44+00:00" },
    ]);
    expect(m.get("2026-09-28")).toEqual([
      { href: "https://t.me/mod_russia/67700", linkText: "2026-09-28 09:04 Moscow", label: "overnight, 2026-09-27 20:00 – 09-28 08:00 Moscow, 254 UAVs" },
      { href: "https://t.me/mod_russia/67721", linkText: "2026-09-28 20:47 Moscow", label: "daytime, 2026-09-28 08:00 – 20:00 Moscow, 14 UAVs" },
    ]);
  });

  it("names air targets as such", () => {
    const m = ruModSourcesByDate([{ report_date: "2026-01-02", post_id: 1, window_kind: "night", window_start: null, window_end: null, drones: 148, unit: "air_target", posted_at: null }]);
    expect(m.get("2026-01-02")![0].label).toBe("overnight, 148 air targets");
  });
});

describe("monthlySourcesByPeriod", () => {
  it("links each month's recap, with its post time or publication date", () => {
    const m = monthlySourcesByPeriod([
      { period: "2026-09", url: "https://t.me/icpbtrubicon/2793", postedAt: "2026-10-03T06:00:10+00:00" },
      { period: "2026-08", url: "https://ssu.gov.ua/x", publishedOn: "2026-09-12" },
    ], "Europe/Moscow", "Moscow");
    expect(m.get("2026-09")).toEqual([{ href: "https://t.me/icpbtrubicon/2793", linkText: "2026-10-03 09:00 Moscow", label: "" }]);
    expect(m.get("2026-08")).toEqual([{ href: "https://ssu.gov.ua/x", linkText: "2026-09-12", label: "" }]);
  });
});

describe("airAttackSourcesByDate", () => {
  const row = (source: string, extra: Partial<AirAttackRow> = {}): AirAttackRow => ({
    date: "2026-10-10", category: "drone", model: "Shahed-136/131", source,
    time_start: "2026-10-09 18:00", time_end: "2026-10-10 09:00", launched: 10, destroyed: 8, hidden: 0, ...extra,
  });

  it("links each post once a day, as its account, with its span and totals", () => {
    const m = airAttackSourcesByDate([
      row("kpszsu/posts/pfbidA", { launched: 160, destroyed: 117 }),
      row("kpszsu/posts/pfbidA", { model: "Geran-4", launched: 25, destroyed: 25 }),
      row("PvKPivden/posts/pfbidB", { time_start: "2026-10-10", time_end: "2026-10-10", launched: 28, destroyed: 28 }),
    ]);
    expect(m.get("2026-10-10")).toEqual([
      { href: "https://www.facebook.com/kpszsu/posts/pfbidA", linkText: "Air Force", label: "2026-10-09 18:00 – 10-10 09:00 Kyiv, 185 launched, 142 intercepted" },
      { href: "https://www.facebook.com/PvKPivden/posts/pfbidB", linkText: "Air Command South", label: "2026-10-10, 28 launched, 28 intercepted" },
    ]);
  });

  it("keeps only the rows a chart counts, and passes full URLs through", () => {
    const m = airAttackSourcesByDate(
      [row("kpszsu/posts/a"), row("https://www.facebook.com/GeneralStaff.ua/posts/b", { category: "cruise" })],
      (r) => r.category === "cruise",
    );
    expect(m.get("2026-10-10")!.map((s) => [s.href, s.linkText])).toEqual([["https://www.facebook.com/GeneralStaff.ua/posts/b", "General Staff"]]);
  });

  it("says so when a post's figures were withheld", () => {
    const m = airAttackSourcesByDate([row("kpszsu/posts/a", { hidden: 1, launched: null, destroyed: null })]);
    expect(m.get("2026-10-10")![0].label).toBe("2026-10-09 18:00 – 10-10 09:00 Kyiv, some figures withheld");
  });
});
