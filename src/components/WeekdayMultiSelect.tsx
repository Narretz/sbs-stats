import { CheckboxMultiSelect } from "@/components/CheckboxMultiSelect";

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface WeekdayMultiSelectProps {
  selected: number[];
  onChange: (next: number[]) => void;
  todayDow: number;
}

// The weekday filter, on the shared checkbox popover. Days are 0 (Sun) – 6
// (Sat), as Date.getDay() numbers them. Nothing picked, or all seven, is no
// filter at all: the button reads "All" and isn't lit.
export function WeekdayMultiSelect({ selected, onChange, todayDow }: WeekdayMultiSelectProps) {
  const filtering = selected.length > 0 && selected.length < 7;
  return (
    <CheckboxMultiSelect
      label="Weekdays"
      allLabel="All"
      options={DOW_LABELS.map((lab, dow) => ({
        value: String(dow),
        label: dow === todayDow ? `${lab} (today)` : lab,
      }))}
      selected={selected.map(String)}
      onChange={(next) => onChange(next.map(Number))}
      // Every picked day by name — seven short ones fit, and "3 selected"
      // would hide which.
      summarize={(sel) => (sel.length === 7 ? "All" : sel.map((d) => DOW_LABELS[Number(d)]).join(", "))}
      active={filtering}
    />
  );
}
