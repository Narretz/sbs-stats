import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { MetricPicker } from "@/components/MetricPicker";
import type { SbsUnit } from "@/types";

// The metric picker on its own. It repeats what is on the chart at the top,
// each with its group inline, since the ticked ones are otherwise scattered
// across a dozen groups. Its use on the homepage, adding a metric to a chart,
// is e2e/homepage-*.spec.ts.
const TWO = ["ru-airdef-mod.total", "ru-air-attacks.drone_launched"];

function Picker({ initial, onChange = () => {} }: { initial: string[]; onChange?: (next: string[]) => void }) {
  const [selected, setSelected] = useState(initial);
  return <MetricPicker view="daily" selected={selected} onChange={(n) => { setSelected(n); onChange(n); }} />;
}

const section = () => page.getByTestId("metric-picker-selected");
const open = async () => {
  await page.getByRole("button", { name: /metric/ }).click();
  await expect.element(page.getByPlaceholder("Search metrics…")).toBeVisible();
};

describe("MetricPicker — the selected section", () => {
  it("lists the chart's metrics at the top, with their groups", async () => {
    await render(<Picker initial={TWO} />);
    await open();
    await expect.element(section()).toMatchTextContent("Selected · 2");
    const rows = [...section().element().querySelectorAll("label")].map((l) => l.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^RU MoD AD · .+/);
    expect(rows[1]).toMatch(/^RU Strikes · .+/);
  });

  it("unticking one there takes it off the chart, like unticking it in its group", async () => {
    const onChange = vi.fn();
    await render(<Picker initial={TWO} onChange={onChange} />);
    await open();
    // A click, not an uncheck: the row leaves the section as it is unticked.
    section().element().querySelector<HTMLInputElement>("label input")!.click();
    expect(onChange).toHaveBeenLastCalledWith([TWO[1]]);
    await expect.element(section()).toMatchTextContent("Selected · 1");
    await expect.element(page.getByRole("button", { name: /^1 metric/ })).toBeVisible();
  });

  it("steps aside for a search, which is about what matches", async () => {
    await render(<Picker initial={TWO} />);
    await open();
    await page.getByPlaceholder("Search metrics…").fill("tanks");
    await expect.element(section()).not.toBeInTheDocument();
  });

  it("is not there with nothing selected", async () => {
    await render(<Picker initial={[]} />);
    await open();
    await expect.element(section()).not.toBeInTheDocument();
  });
});

// The President's weekly tally has no daily figure: it is offered on weekly
// and monthly charts, never daily. Through the picker, not a URL — it was once
// in the metric registry but missing from the picker's group list, which a
// URL-built chart can't notice. Its weeks reaching a chart is
// e2e/homepage-weekly.spec.ts.
describe("MetricPicker — the weekly tally", () => {
  const tally = () => page.getByRole("checkbox", { name: /Strike Drones Launched \(rounded\)/ });
  for (const view of ["weekly", "monthly"] as const) {
    it(`is offered on a ${view} chart, and ticking it adds it`, async () => {
      const onChange = vi.fn();
      await render(<MetricPicker view={view} selected={[]} onChange={onChange} />);
      await open();
      await tally().click();
      expect(onChange).toHaveBeenLastCalledWith(["zelensky.drones"]);
    });
  }
  it("is not offered on a daily chart", async () => {
    await render(<MetricPicker view="daily" selected={[]} onChange={() => {}} />);
    await open();
    await expect.element(tally()).not.toBeInTheDocument();
  });
});

// SBS sub-units: one unit <select> plus the shared SBS metric list, never a
// row per unit × metric — 15 units × 89 metrics would be 1,335 rows, in a list
// rendered once per chart on the page. Which units reach it (a unit with no
// stored months is left out by the hook) and the lazy fetch of their DB are
// e2e/homepage-sbs-units.spec.ts.
const unit = (slug: string, name: string, active = true): SbsUnit => ({
  slug, subdivision_id: slug, division_id: null, title_uk: null, title_en: name, color: null,
  display_order: null, active, first_month: "2026-01", last_month: "2026-08",
});
const UNITS = [unit("alpha-unit", "Alpha Unit"), unit("bravo-unit", "Bravo Unit"), unit("gone-unit", "Gone Unit", false)];

function UnitPicker({ view = "monthly" }: { view?: "daily" | "monthly" }) {
  const [selected, setSelected] = useState<string[]>([]);
  return <MetricPicker view={view} selected={selected} onChange={setSelected} units={UNITS} />;
}
const group = () => page.getByTestId("metric-picker-unit-group");
const unitSelect = () => page.getByTestId("metric-picker-unit");

describe("MetricPicker — SBS sub-units", () => {
  it("offers every unit, the retired ones marked, and switching unit adds no rows", async () => {
    await render(<UnitPicker />);
    await open();
    const options = [...unitSelect().element().querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toEqual(["Alpha Unit", "Bravo Unit", "Gone Unit (retired)"]);

    // THE property: the group is one metric list, whichever unit it points at.
    const rows = () => group().element().querySelectorAll("label").length;
    const before = rows();
    expect(before).toBeGreaterThan(10);
    await userEvent.selectOptions(unitSelect(), "bravo-unit");
    expect(rows()).toBe(before);
  });

  // The per-unit daily series starts from the day its ingest was switched on —
  // no backfill — so it is offered on monthly charts only. Omitting the group
  // on a daily chart is what made the feature feel missing rather than
  // inapplicable: daily is the default, so it was the first thing anyone saw.
  it("on a daily chart, says why it's empty rather than hiding", async () => {
    await render(<UnitPicker view="daily" />);
    await open();
    await expect.element(group()).toMatchTextContent("Monthly charts only");
    await expect.element(unitSelect()).not.toBeInTheDocument();
  });

  // It IS SBS data. At the end of the list it sat ~4,700px down a 460px-tall
  // popover, past every other source — unreachable in practice.
  it("sits directly after SBS, not after the last source", async () => {
    await render(<UnitPicker />);
    await open();
    const headers = [...document.querySelectorAll("[popover] div")]
      .filter((e) => e.children.length === 0 && (e.textContent ?? "").trim())
      .map((e) => (e.textContent ?? "").trim());
    const sbs = headers.indexOf("SBS");
    const units = headers.indexOf("SBS sub-unit");
    expect(sbs).toBeGreaterThanOrEqual(0);
    expect(units).toBeGreaterThan(sbs);
    // Nothing between them — no other source's group.
    expect(headers.slice(sbs + 1, units)).not.toContain("GSUA");
  });

  // The group filters within one unit, so without this a search for "Fenix"
  // while another unit was active answered "No matches in this unit" — in the
  // one place someone hunting for a unit would look.
  it("selects the unit a search names, and filters its metrics", async () => {
    await render(<UnitPicker />);
    await open();
    await userEvent.selectOptions(unitSelect(), "alpha-unit");
    await page.getByPlaceholder("Search metrics…").fill("bravo");
    await expect.element(unitSelect()).toHaveValue("bravo-unit");

    await page.getByPlaceholder("Search metrics…").fill("bravo tanks");
    await expect.element(unitSelect()).toHaveValue("bravo-unit");
    const rows = group().element().querySelectorAll("label");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(10);
  });
});
