import { type ReactNode } from "react";
import { ReferenceLine, Tooltip } from "recharts";
import { useTheme } from "@/hooks/useTheme";
import { useChartPin } from "@/hooks/ChartPinProvider";
import { ChartSheetContent } from "@/components/ChartSheet";
import { DescriptorBody, DescriptorCard, type TooltipDescriptor } from "@/components/TooltipTable";

// Everything a chart needs to take part in the pinned detail sheet, in one
// call. Each chart otherwise repeats the same six pieces of wiring — the card
// marker, the click handler, a Tooltip that goes quiet while pinned, the pinned
// cursor, and the portalled sheet — and the repetition is where they'd drift.
//
// The chart supplies one function: `describe`, which turns a row into a
// TooltipDescriptor. That description is rendered as the floating hover card
// and as the sheet body, so the two can't disagree.

interface Options<T> {
  /** Stable identity for the pin. Use the chart's anchor slug. */
  chartId: string;
  /** Shown in the sheet header, above the stepper. */
  title: string;
  /** The plotted rows, in x order. */
  data: readonly T[];
  /** A row's x value. Must equal what the XAxis `dataKey` yields, since that
   *  is what recharts reports back as the active label and what the pinned
   *  ReferenceLine is positioned by. */
  xOf: (row: T) => string | number;
  describe: (row: T) => TooltipDescriptor | null;
  /** Human-facing label for the sheet header. Defaults to the raw x. */
  formatLabel?: (row: T) => ReactNode;
  /** recharts `cursor` prop for the hover tooltip. */
  cursor?: React.ComponentProps<typeof Tooltip>["cursor"];
  /** Extra props for the pinned ReferenceLine. A chart with more than one
   *  Y axis has to name one (`yAxisId`), or recharts can't resolve the line. */
  cursorProps?: Record<string, unknown>;
  /** Keep the tooltip wrapper visible even with an empty payload. Needed only
   *  by charts that explain their gaps: recharts hides the wrapper when every
   *  series is null at that x, which is exactly the case worth a note. */
  showEmptyWrapper?: boolean;
}

export interface PinnedChart {
  isPinned: boolean;
  /** The pinned x value, or null. For charts that also mark the pinned point
   *  in their own dot renderer. */
  pinnedX: string | number | null;
  /** Spread on the chart card's root element. */
  cardProps: { ref: React.RefObject<HTMLDivElement>; "data-chart-pinnable": "" };
  /** Spread on the recharts chart element (`<LineChart {...chartProps}>`). */
  chartProps: { onClick: (state: { activeTooltipIndex?: number | null } | null) => void };
  /** Render as a child of the recharts chart, in place of your own <Tooltip>. */
  tooltip: ReactNode;
  /** Render as a child of the recharts chart — the pinned cursor. Null when
   *  nothing is pinned. */
  cursor: ReactNode;
  /** Render as a sibling of the ResponsiveContainer. Portals into the sheet. */
  sheet: ReactNode;
}

export function usePinnedChart<T>({
  chartId, title, data, xOf, describe, formatLabel, cursor, cursorProps, showEmptyWrapper,
}: Options<T>): PinnedChart {
  const { theme: t } = useTheme();
  // Recomputed per render rather than memoised: `xOf` is nearly always an
  // inline arrow, so a memo keyed on it would never hit, and these arrays top
  // out at a few hundred entries.
  const xs = data.map(xOf);
  const pin = useChartPin(chartId, xs);
  const rowAt = (x: string | number | undefined): T | null => {
    if (x == null) return null;
    const i = xs.indexOf(x);
    return i >= 0 ? data[i] : null;
  };
  const pinnedRow = pin.isPinned ? data[pin.index] : null;

  const tooltip = (
    <Tooltip
      // Honoured ahead of recharts' internal hover state for both the tooltip
      // and its cursor (generateCategoricalChart resolves
      // `element.props.active ?? isTooltipActive`), so one prop silences both.
      // Without it a cursor would track the pointer with nothing attached.
      active={pin.isPinned ? false : undefined}
      allowEscapeViewBox={{ x: false, y: true }}
      wrapperStyle={showEmptyWrapper
        ? { zIndex: 9999, visibility: "visible" }
        : { zIndex: 9999 }}
      cursor={cursor}
      content={(props) => {
        const p = props as {
          active?: boolean;
          label?: string | number;
          payload?: Array<{ payload?: T }>;
        };
        if (!p.active) return null;
        // Prefer the payload row; fall back to the axis label, which is all
        // recharts hands over when every series is null at that x.
        const row = p.payload?.[0]?.payload ?? rowAt(p.label);
        return row ? <DescriptorCard d={describe(row)} /> : null;
      }}
    />
  );

  return {
    isPinned: pin.isPinned,
    pinnedX: pinnedRow != null ? xs[pin.index] : null,
    cardProps: pin.cardProps,
    chartProps: {
      onClick: (state) => {
        // recharts recomputes the active index for the click itself, so the
        // press resolves to the nearest x-band regardless of where vertically
        // it landed — the whole plot area is a hit target.
        const i = state?.activeTooltipIndex;
        if (typeof i === "number" && data[i]) pin.select(xs[i]);
      },
    },
    tooltip,
    cursor: pinnedRow != null
      ? <ReferenceLine x={xs[pin.index]} stroke={t.accent} strokeWidth={1.5} strokeOpacity={0.9} {...cursorProps} />
      : null,
    sheet: pinnedRow != null ? (
      <ChartSheetContent
        title={title}
        label={formatLabel ? formatLabel(pinnedRow) : String(xs[pin.index])}
        canPrev={pin.canPrev}
        canNext={pin.canNext}
        onStep={pin.step}
        onClose={pin.clear}
      >
        <DescriptorBody d={describe(pinnedRow)} />
      </ChartSheetContent>
    ) : null,
  };
}
