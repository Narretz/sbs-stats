import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { DayRangeSelect } from "@/components/DayRangeSelect";
import { DateNav } from "@/components/DateNav";
import { DAY_OPTIONS, WINDOW_FLOOR } from "@/utils/dayRange";

// The day window's controls on their own: the length (presets + custom
// input), the start field derived from it, and the end date's DateNav. The
// arithmetic is unit-tested (dayRange.ts); these hold the controls to it —
// what each field shows, what each gesture reports. That they're wired to one
// window on a real page, through the URL, is e2e/window-start-date.spec.ts.
const END = "2026-10-09";

// DayRangeSelect is controlled; this holds `days` the way a page does.
function Window({ initial, endDate = END, minDate, onChange = () => {} }: {
  initial: number; endDate?: string; minDate?: string; onChange?: (d: number) => void;
}) {
  const [days, setDays] = useState(initial);
  return (
    <DayRangeSelect options={DAY_OPTIONS} value={days} endDate={endDate} minDate={minDate}
      onChange={(d) => { setDays(d); onChange(d); }} />
  );
}

const start = () => page.getByTestId("window-start");
const custom = () => page.getByTestId("day-range-custom");

describe("DayRangeSelect — the start field", () => {
  it("shows the window's first day, inclusive of both ends", async () => {
    await render(<Window initial={7} />);
    await expect.element(start()).toHaveValue("2026-10-03");
  });

  it("picking a start sets the length to match", async () => {
    const onChange = vi.fn();
    await render(<Window initial={7} onChange={onChange} />);
    await start().fill("2026-10-07");
    expect(onChange).toHaveBeenLastCalledWith(3);
    await expect.element(custom()).toHaveValue(3);
  });

  it("changing the length moves the start", async () => {
    await render(<Window initial={7} />);
    await custom().fill("14");
    await userEvent.keyboard("{Enter}");
    await expect.element(start()).toHaveValue("2026-09-26");
  });

  it("steps a day at a time, growing and shrinking the window", async () => {
    await render(<Window initial={7} />);
    // The end stays put, so an earlier start is a longer window.
    await page.getByRole("button", { name: "Start: previous day" }).click();
    await expect.element(custom()).toHaveValue(8);
    await expect.element(start()).toHaveValue("2026-10-02");
    await page.getByRole("button", { name: "Start: next day" }).click();
    await page.getByRole("button", { name: "Start: next day" }).click();
    await expect.element(custom()).toHaveValue(6);
  });

  it("can't step past the end", async () => {
    await render(<Window initial={1} />);
    await expect.element(start()).toHaveValue(END);
    await expect.element(page.getByRole("button", { name: "Start: next day" })).toBeDisabled();
  });

  it("can't step before the data", async () => {
    await render(<Window initial={3} minDate="2026-10-07" />);
    await expect.element(start()).toHaveAttribute("min", "2026-10-07");
    await expect.element(page.getByRole("button", { name: "Start: previous day" })).toBeDisabled();
  });
});

describe("DayRangeSelect — the floor", () => {
  it("offers no preset that reaches past it", async () => {
    await render(<Window initial={1} endDate={WINDOW_FLOOR} />);
    const presets = [...page.getByTestId("day-range").element().querySelectorAll("option")].map((o) => o.textContent);
    expect(presets).toEqual(["1d"]);
  });

  it("caps a typed length at it", async () => {
    const onChange = vi.fn();
    await render(<Window initial={3} endDate="2022-03-01" onChange={onChange} />);
    await custom().fill("99999");
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(6);
    await expect.element(start()).toHaveValue(WINDOW_FLOOR);
  });
});

describe("DayRangeSelect — the custom input", () => {
  it("commits a typed value after a pause, without blur or Enter", async () => {
    const onChange = vi.fn();
    await render(<Window initial={7} onChange={onChange} />);
    await custom().fill("21");
    // Not on the keystroke itself: a spinner held down would re-fetch per step.
    expect(onChange).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(21));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("commits a spinner run once, after the last step", async () => {
    const onChange = vi.fn();
    await render(<Window initial={7} onChange={onChange} />);
    await custom().click();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(9));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("leaves a cleared field cleared while editing, and blur puts the value back", async () => {
    const onChange = vi.fn();
    await render(<Window initial={7} onChange={onChange} />);
    await custom().clear();
    // Past the debounce: an empty field isn't a value, so nothing is committed
    // and the field isn't refilled from under the cursor.
    await new Promise((r) => setTimeout(r, 500));
    await expect.element(custom()).toHaveValue(null);
    await userEvent.tab();
    await expect.element(custom()).toHaveValue(7);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("DateNav — live at the latest date", () => {
  function End({ initial, liveAtMax, onChange }: { initial: string; liveAtMax?: boolean; onChange: (d: string) => void }) {
    const [value, setValue] = useState(initial);
    return (
      <DateNav label="End" value={value} max={END} liveAtMax={liveAtMax}
        onChange={(d) => { setValue(d); onChange(d); }}
        onShift={(n) => {
          const d = new Date(`${value || END}T00:00:00Z`);
          d.setUTCDate(d.getUTCDate() + n);
          const iso = d.toISOString().slice(0, 10);
          setValue(iso); onChange(iso);
        }}
        canGoNext={value !== "" && value < END} />
    );
  }

  it("picking the latest date goes live — the only way back without a clear button", async () => {
    const onChange = vi.fn();
    await render(<End initial="2026-10-05" onChange={onChange} />);
    await page.getByLabelText("End", { exact: true }).fill(END);
    expect(onChange).toHaveBeenLastCalledWith("");
    await expect.element(page.getByLabelText("End", { exact: true })).toHaveValue("");
    await expect.element(page.getByRole("button", { name: "End: next day" })).toBeDisabled();
  });

  it("stepping onto it goes live too", async () => {
    const onChange = vi.fn();
    await render(<End initial="2026-10-08" onChange={onChange} />);
    await page.getByRole("button", { name: "End: next day" }).click();
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("keeps the date when live isn't a thing for this field", async () => {
    const onChange = vi.fn();
    await render(<End initial="2026-10-05" liveAtMax={false} onChange={onChange} />);
    await page.getByLabelText("End", { exact: true }).fill(END);
    expect(onChange).toHaveBeenLastCalledWith(END);
  });
});
