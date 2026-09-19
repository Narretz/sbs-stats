import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHART_SPECS,
  DEFAULT_DAYS,
  decodeChartName,
  encodeChartName,
  isDefaultCharts,
  makeDefaultCharts,
  parseCharts,
  parseMetricsLegacy,
  parseSpec,
  serializeCharts,
  type ChartConfig,
} from "@/home/charts";

// A real id from the metric registry, and one the registry only offers on the
// monthly view — parseCharts drops ids a chart's granularity can't render, and
// that rule needs both sides to be real to mean anything.
const DAILY_ID = "sbs.personnel_killed";
const MONTHLY_ONLY_ID = "rubikon.personnel";

// Everything about a chart except its uid, which is a render key counted up
// per call and deliberately not part of the URL — comparing whole objects
// would only ever assert the call order of the factory.
function shape(charts: ChartConfig[]) {
  return charts.map(({ uid: _uid, ...rest }) => rest);
}

function chart(over: Partial<ChartConfig> = {}): ChartConfig {
  return {
    uid: "u", name: "Chart 1", granularity: "daily",
    window: DEFAULT_DAYS, metricIds: [DAILY_ID], ...over,
  };
}

describe("chart name encoding", () => {
  // `:` splits a chunk's fields and `;` splits chunks, so a name carrying
  // either would silently re-cut the URL. Only those two and `%` itself are
  // escaped — URLSearchParams does one encode/decode pass over the rest, and
  // escaping more here would double-encode it.
  it("round-trips the delimiters", () => {
    const name = "My: chart; name";
    expect(encodeChartName(name)).toBe("My%3A chart%3B name");
    expect(decodeChartName(encodeChartName(name))).toBe(name);
  });

  it("round-trips a name that is nothing but delimiters", () => {
    expect(decodeChartName(encodeChartName(":;%"))).toBe(":;%");
  });

  it("round-trips a percent that already looks like an escape", () => {
    // "%3A" typed by a human must come back as "%3A", not as ":".
    expect(decodeChartName(encodeChartName("100%3A done"))).toBe("100%3A done");
  });

  it("leaves everything else alone", () => {
    // Spaces and unicode are URLSearchParams' job, not ours.
    expect(encodeChartName("Втрати РФ / day")).toBe("Втрати РФ / day");
  });
});

describe("parseSpec", () => {
  it("reads granularity, window and the optional Y override", () => {
    expect(parseSpec("d60")).toEqual({ granularity: "daily", window: 60, yMode: undefined });
    expect(parseSpec("m12")).toEqual({ granularity: "monthly", window: 12, yMode: undefined });
    expect(parseSpec("d60ylog")).toEqual({ granularity: "daily", window: 60, yMode: "log" });
    expect(parseSpec("mallynorm")).toEqual({ granularity: "monthly", window: "all", yMode: "normalized" });
  });

  it("rejects `all` on a daily chart", () => {
    // The sentinel means "every month there is" — a day axis has no such thing.
    expect(parseSpec("dall")).toBeNull();
  });

  it("rejects windows that are not a positive count", () => {
    expect(parseSpec("d0")).toBeNull();
    expect(parseSpec("d-5")).toBeNull();
    expect(parseSpec("w30")).toBeNull();
    expect(parseSpec("d30yrainbow")).toBeNull();
    expect(parseSpec("")).toBeNull();
  });
});

describe("parseCharts", () => {
  it("falls back to the curated defaults when there is no chart state", () => {
    expect(shape(parseCharts(null, []))).toEqual(shape(makeDefaultCharts()));
    expect(shape(parseCharts("", []))).toEqual(shape(makeDefaultCharts()));
    // Only separators: nothing was asked for, so it is not "zero charts".
    expect(shape(parseCharts(";;", []))).toEqual(shape(makeDefaultCharts()));
  });

  it("round-trips a chart list through serializeCharts", () => {
    const charts = [
      chart({ name: "First", window: 45 }),
      chart({ name: "Second", granularity: "monthly", window: "all", yMode: "log", metricIds: [MONTHLY_ONLY_ID] }),
    ];
    const back = parseCharts(serializeCharts(charts), []);
    expect(back.map((c) => [c.name, c.granularity, c.window, c.yMode, c.metricIds]))
      .toEqual(charts.map((c) => [c.name, c.granularity, c.window, c.yMode, c.metricIds]));
  });

  it("round-trips a name carrying both delimiters", () => {
    // The case the URL shape is most exposed to: the name sits in the same
    // field grammar as the spec and the ids.
    const charts = [chart({ name: "a:b;c" })];
    expect(parseCharts(serializeCharts(charts), [])[0].name).toBe("a:b;c");
  });

  it("drops metric ids the chart's granularity cannot render", () => {
    const daily = parseCharts(`X:d30:${DAILY_ID},${MONTHLY_ONLY_ID}`, []);
    expect(daily[0].metricIds).toEqual([DAILY_ID]);
    const monthly = parseCharts(`X:m12:${DAILY_ID},${MONTHLY_ONLY_ID}`, []);
    expect(monthly[0].metricIds).toEqual([DAILY_ID, MONTHLY_ONLY_ID]);
  });

  it("drops ids the registry does not know", () => {
    // A metric renamed or retired since the link was shared. The chart still
    // renders, minus the series nothing can fill.
    expect(parseCharts(`X:d30:${DAILY_ID},sbs.no_such_metric`, [])[0].metricIds)
      .toEqual([DAILY_ID]);
  });

  it("keeps a chart whose metric list is empty", () => {
    const charts = parseCharts("Empty:d30:", []);
    expect(charts).toHaveLength(1);
    expect(charts[0].metricIds).toEqual([]);
  });

  it("names an unnamed chart by position", () => {
    expect(parseCharts(`:d30:${DAILY_ID};:d30:${DAILY_ID}`, []).map((c) => c.name))
      .toEqual(["Chart 1", "Chart 2"]);
  });

  it("treats an unreadable spec field as part of the id list", () => {
    // The pre-spec URL shape: `<name>:<ids>`. Its ids can contain a `.`, so
    // the field is only a spec if it parses as one.
    const charts = parseCharts(`Old:${DAILY_ID}`, []);
    expect(charts[0].granularity).toBe("daily");
    expect(charts[0].window).toBe(DEFAULT_DAYS);
    expect(charts[0].metricIds).toEqual([DAILY_ID]);
  });

  it("gives every chart its own uid", () => {
    const charts = parseCharts(`A:d30:${DAILY_ID};B:d30:${DAILY_ID}`, []);
    expect(charts[0].uid).not.toBe(charts[1].uid);
  });
});

describe("serializeCharts", () => {
  it("omits the spec for a daily chart at the default window", () => {
    // Keeps a link that changed nothing but the metrics as short as it was
    // before per-chart windows existed.
    expect(serializeCharts([chart({ name: "A" })])).toBe(`A:${DAILY_ID}`);
  });

  it("writes the spec as soon as anything is off-default", () => {
    expect(serializeCharts([chart({ name: "A", window: 45 })])).toBe(`A:d45:${DAILY_ID}`);
    expect(serializeCharts([chart({ name: "A", yMode: "log" })])).toBe(`A:d${DEFAULT_DAYS}ylog:${DAILY_ID}`);
  });
});

describe("the trip through URLSearchParams", () => {
  // encodeChartName escapes only `%:;` because URLSearchParams does its own
  // single encode/decode pass over everything else. Escaping a space here too
  // would send it out as "%2520" — a literal percent-two-five in the address
  // bar — and bring it back as "%20".
  const roundTrip = (charts: ChartConfig[]) => {
    const p = new URLSearchParams();
    p.set("charts", serializeCharts(charts));
    return { qs: p.toString(), back: parseCharts(new URLSearchParams(p.toString()).get("charts"), []) };
  };

  it("encodes a space once", () => {
    const { qs } = roundTrip([chart({ name: "RU vs UA" })]);
    expect(qs).toContain("RU+vs+UA");
    expect(qs).not.toContain("%2520");
  });

  it("brings delimiters, unicode and percents back intact", () => {
    const names = ["a:b;c", "100% done", "Втрати РФ", "d60:not a spec"];
    const { back } = roundTrip(names.map((name) => chart({ name })));
    expect(back.map((c) => c.name)).toEqual(names);
  });
});

describe("isDefaultCharts", () => {
  // Drives whether `charts=` is written at all: a clean visit keeps "/" clean,
  // and a bookmark that omits the param picks up later edits to the JSON.
  it("is true for the curated list", () => {
    expect(isDefaultCharts(makeDefaultCharts())).toBe(true);
  });

  it("notices any single field moving", () => {
    const bump = (over: Partial<ChartConfig>) => {
      const cs = makeDefaultCharts();
      cs[0] = { ...cs[0], ...over };
      return isDefaultCharts(cs);
    };
    expect(bump({ name: "Renamed" })).toBe(false);
    expect(bump({ window: 999 })).toBe(false);
    expect(bump({ yMode: "log" })).toBe(false);
    expect(bump({ metricIds: [] })).toBe(false);
  });

  it("notices a chart added or removed", () => {
    expect(isDefaultCharts(makeDefaultCharts().slice(1))).toBe(false);
    expect(isDefaultCharts([...makeDefaultCharts(), chart()])).toBe(false);
  });

  it("holds for a list that went through the URL and back", () => {
    // The round trip must not perturb the defaults, or every visitor's URL
    // would grow a `charts=` param on first interaction.
    expect(isDefaultCharts(parseCharts(serializeCharts(makeDefaultCharts()), []))).toBe(true);
  });
});

describe("the curated JSON", () => {
  it("resolves to charts whose metrics their granularity can render", () => {
    // Guards defaultCharts.json itself: an id that outlives a rename would
    // otherwise silently vanish from a default chart.
    expect(DEFAULT_CHART_SPECS.length).toBeGreaterThan(0);
    for (const spec of DEFAULT_CHART_SPECS) {
      expect(spec.metricIds.length, `${spec.name} has no renderable metrics`).toBeGreaterThan(0);
    }
  });
});

describe("parseMetricsLegacy", () => {
  it("keeps known ids and drops the rest", () => {
    expect(parseMetricsLegacy(`${DAILY_ID}, sbs.gone , `)).toEqual([DAILY_ID]);
    expect(parseMetricsLegacy(null)).toEqual([]);
  });

  it("becomes one chart when there is no chart state", () => {
    const charts = parseCharts(null, [DAILY_ID]);
    expect(charts).toHaveLength(1);
    expect(charts[0].metricIds).toEqual([DAILY_ID]);
    expect(charts[0].window).toBe(DEFAULT_DAYS);
  });
});
