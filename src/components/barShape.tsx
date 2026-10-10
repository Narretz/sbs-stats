import type { SVGProps } from "react";
import { Rectangle, type BarShapeProps } from "recharts";

type BarStyle = Pick<SVGProps<SVGPathElement>, "fill" | "fillOpacity" | "stroke" | "strokeWidth" | "strokeDasharray">;

// A <Bar> `shape` that styles each bar from its row and its position — the
// current month in a darker shade, a noted one outlined. Otherwise recharts'
// own bar: the default shape is this same Rectangle, given these same props.
// (What <Cell> children did in recharts 2: one per row, matched by index, and
// deprecated in 3.) A custom shape also keeps recharts from dropping
// zero-height bars, so `index` is always the row's index in the data.
export function styledBar<T>(style: (row: T, index: number) => BarStyle) {
  return (props: BarShapeProps) => <Rectangle {...props} {...style(props.payload as T, props.index)} />;
}

// The dashed outline that marks a bar carrying a caveat note.
export function noteOutline(note: unknown, color: string): BarStyle {
  return note ? { stroke: color, strokeWidth: 1.5, strokeDasharray: "3 2" } : {};
}
