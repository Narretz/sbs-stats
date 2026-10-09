import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { MonthNav } from "@/components/MonthNav";

// The end-month control on its own: two selects and two steppers over a fixed
// range, so every case reads in absolute months rather than "n back from
// today". Its window on a real page (the axis it slides, end-month= in the
// URL) is e2e/month-end-picker.spec.ts.
const MIN = "2025-02", MAX = "2026-10";

// MonthNav is controlled; this holds its value the way a page does, and
// records every change it reports.
function Harness({ initial, onChange }: { initial: string; onChange: (m: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <MonthNav label="End" testId="end" value={value} min={MIN} max={MAX}
      onChange={(m) => { setValue(m); onChange(m); }} />
  );
}

const year = () => page.getByTestId("end-year");
const month = () => page.getByTestId("end-month");
const prev = () => page.getByRole("button", { name: "End: previous month" });
const next = () => page.getByRole("button", { name: "End: next month" });

describe("MonthNav", () => {
  it("shows live as the latest month, and says so", async () => {
    await render(<Harness initial="" onChange={() => {}} />);
    await expect.element(year()).toHaveValue("2026");
    await expect.element(month()).toHaveValue("2026-10");
    expect(month().element().querySelector("option:checked")?.textContent).toBe("Oct (live)");
    await expect.element(next()).toBeDisabled();
  });

  it("offers only the months a year has inside the range", async () => {
    await render(<Harness initial="2025-06" onChange={() => {}} />);
    const months = () => [...month().element().querySelectorAll("option")].map((o) => o.value);
    expect(months()[0]).toBe("2025-02");
    expect(months()).toHaveLength(11);
    expect([...year().element().querySelectorAll("option")].map((o) => o.value)).toEqual(["2026", "2025"]);
  });

  it("steps across a year boundary", async () => {
    const onChange = vi.fn();
    await render(<Harness initial="2026-01" onChange={onChange} />);
    await prev().click();
    expect(onChange).toHaveBeenLastCalledWith("2025-12");
    await expect.element(year()).toHaveValue("2025");
    await next().click();
    expect(onChange).toHaveBeenLastCalledWith("2026-01");
  });

  it("stepping onto the latest month goes live", async () => {
    const onChange = vi.fn();
    await render(<Harness initial="2026-09" onChange={onChange} />);
    await next().click();
    expect(onChange).toHaveBeenLastCalledWith("");
    await expect.element(next()).toBeDisabled();
  });

  it("goes no earlier than the range", async () => {
    await render(<Harness initial="2025-02" onChange={() => {}} />);
    await expect.element(prev()).toBeDisabled();
  });

  it("a year switch keeps the month where that year has it", async () => {
    const onChange = vi.fn();
    await render(<Harness initial="2026-03" onChange={onChange} />);
    await year().selectOptions("2025");
    expect(onChange).toHaveBeenLastCalledWith("2025-03");
  });

  it("clamps into a year the range cuts short — onto live, for the latest", async () => {
    const onChange = vi.fn();
    await render(<Harness initial="2025-12" onChange={onChange} />);
    await year().selectOptions("2026");
    expect(onChange).toHaveBeenLastCalledWith("");

    await year().selectOptions("2025");
    // From live (October) into 2025: October exists there.
    expect(onChange).toHaveBeenLastCalledWith("2025-10");
  });

  it("clamps up to the range's first month", async () => {
    const onChange = vi.fn();
    await render(<Harness initial="2026-01" onChange={onChange} />);
    await year().selectOptions("2025");
    expect(onChange).toHaveBeenLastCalledWith("2025-02");
  });
});
