import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { MetricPicker } from "@/components/MetricPicker";

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
