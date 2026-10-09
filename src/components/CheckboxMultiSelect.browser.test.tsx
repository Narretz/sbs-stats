import { useState, type CSSProperties } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { CheckboxMultiSelect, type MultiSelectOption } from "@/components/CheckboxMultiSelect";

// The checkbox popover on its own: where it opens relative to its trigger
// (popoverPlacement.ts — under it, flipped above near the bottom, kept on
// screen at the right edge, and placed before it is first painted), and what
// ticking reports. Its use as a filter on a page is e2e/weekday-filter.spec.ts
// and e2e/gsua-directions.spec.ts.
const OPTIONS: MultiSelectOption[] = ["Bakhmut", "Kupiansk", "Lyman", "Pokrovsk", "Siversk", "Toretsk"]
  .map((name) => ({ value: name, label: name }));

// Where the trigger sits decides where the popover goes, so each case parks
// the control at a corner of the viewport.
function At({ style, onChange = () => {} }: { style: CSSProperties; onChange?: (v: string[]) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <div style={{ position: "fixed", ...style }}>
      <CheckboxMultiSelect label="Direction" testId="dir" allLabel="All" options={OPTIONS} selected={selected}
        onChange={(v) => { setSelected(v); onChange(v); }} />
    </div>
  );
}

const trigger = () => page.getByTestId("dir");
const list = () => page.getByTestId("dir-list");
const rect = (l: ReturnType<typeof page.getByTestId>) => l.element().getBoundingClientRect();
const open = async () => {
  await trigger().click();
  await expect.element(list()).toBeVisible();
};

describe("CheckboxMultiSelect — placement", () => {
  it("opens under its trigger, left-aligned to it", async () => {
    await render(<At style={{ top: 20, left: 100 }} />);
    await open();
    const t = rect(trigger()), p = rect(list());
    expect(p.top).toBeGreaterThanOrEqual(t.bottom);
    expect(p.top - t.bottom).toBeLessThan(10);
    expect(p.left).toBeCloseTo(t.left, 0);
  });

  it("flips above when there's no room below", async () => {
    await render(<At style={{ bottom: 20, left: 100 }} />);
    await open();
    const t = rect(trigger()), p = rect(list());
    expect(p.bottom).toBeLessThanOrEqual(t.top);
    expect(p.top).toBeGreaterThanOrEqual(0);
  });

  it("stays on screen at the right edge", async () => {
    await render(<At style={{ top: 20, right: 4 }} />);
    await open();
    expect(rect(list()).right).toBeLessThanOrEqual(window.innerWidth - 8);
  });

  it("is already in place when it is first shown", async () => {
    // The bug this guards: placed on `toggle`, it painted one frame at its
    // default spot (in the page flow, full height) before jumping under the
    // trigger. On `beforetoggle` it is placed before it is shown, so the very
    // first frame it's open in already has it there.
    await render(<At style={{ bottom: 20, left: 100 }} />);
    const first = new Promise<DOMRect>((resolve) =>
      list().element().addEventListener("toggle", () => requestAnimationFrame(() => resolve(rect(list()))), { once: true }));
    await trigger().click();
    const atFirstFrame = await first;
    expect(atFirstFrame.bottom).toBeLessThanOrEqual(rect(trigger()).top);
  });
});

describe("CheckboxMultiSelect — selection", () => {
  it("reports the options' order, not the order they were ticked in", async () => {
    const onChange = vi.fn();
    await render(<At style={{ top: 20, left: 100 }} onChange={onChange} />);
    await open();
    await page.getByRole("checkbox", { name: "Siversk", exact: true }).click();
    await page.getByRole("checkbox", { name: "Kupiansk", exact: true }).click();
    expect(onChange).toHaveBeenLastCalledWith(["Kupiansk", "Siversk"]);
  });

  it("names one or two picks, and counts more", async () => {
    await render(<At style={{ top: 20, left: 100 }} />);
    await expect.element(trigger()).toMatchTextContent("All");
    await open();
    await page.getByRole("checkbox", { name: "Lyman", exact: true }).click();
    await page.getByRole("checkbox", { name: "Bakhmut", exact: true }).click();
    await expect.element(trigger()).toMatchTextContent("Bakhmut, Lyman");
    await page.getByRole("checkbox", { name: "Toretsk", exact: true }).click();
    await expect.element(trigger()).toMatchTextContent("3 selected");
  });
});
