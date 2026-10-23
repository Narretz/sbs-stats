import { Bar } from "recharts";
import { noteOutline, styledBar } from "@/components/barShape";
import { MonthlyChartCard } from "@/components/MonthlyChartCard";
import type { SheetSource, TooltipDescriptor, TooltipTableRow } from "@/components/TooltipTable";
import { useTheme } from "@/hooks/useTheme";
import { chartColors } from "@/chartColors";
import { FONTS } from "@/theme";
import { exchangeRatio, exchangeTotals, formatRatio } from "@/data/exchanges";
import type { ExchangeRecord } from "@/types";

interface Props<T extends ExchangeRecord> {
  title: string;
  data: readonly T[];
  // One side's bars alone, on its own scale. Russia's body counts need it —
  // next to Ukraine's 1,000-body exchanges of 2025–26 they are a few pixels
  // high.
  series?: "both" | "ukraine" | "russia";
  colors: { ukraine: string; russia: string };
  sources: (e: T) => SheetSource[];
  // Columns after each row's total, in the tooltip — the prisoner exchanges'
  // military / civilians. `cells` gives a side's figures, or for "ratio" the
  // ratios between them (formatted here, like the total's).
  columns?: {
    headers: string[];
    cells: (e: T, row: "ukraine" | "russia" | "ratio") => (number | null)[];
  };
  // A line of context under the table: the deal a stage belongs to, say.
  context?: (e: T) => string | null;
}

// One pair of bars per exchange on a categorical axis: the exchanges are
// irregular, and on a time axis a run of stages on consecutive days (June
// 2025) would collapse into one stripe.
export function ExchangeChart<T extends ExchangeRecord>({
  title, data, series = "both", colors, sources, columns, context,
}: Props<T>) {
  const both = series === "both";
  const showUa = series !== "russia";
  const showRu = series !== "ukraine";
  const { theme: t } = useTheme();
  const c = chartColors(t);
  const totals = exchangeTotals(data);
  const rows = data as T[];

  const describe = (e: T): TooltipDescriptor => {
    const caveat =
      e.status === "discrepancy" ? "Sources disagree"
      : e.ua_received == null && e.ru_received == null ? "Neither side gave a figure"
      : e.status === "partial" && e.ru_received == null && showRu ? "Russia gave no figure"
      : e.status === "partial" && e.ua_received == null && showUa ? "Ukraine gave no figure"
      : null;
    const ctx = context?.(e) ?? null;
    const footer = caveat || ctx || e.notes ? (
      <div className="tooltip-note" style={{ marginTop: 6, maxWidth: 320, whiteSpace: "normal" }}>
        {caveat && <div style={{ color: c.noteText }}>⚠ {caveat}</div>}
        {ctx && <div style={{ color: t.textMuted }}>{ctx}</div>}
        {e.notes && <div style={{ color: t.textMuted }}>{e.notes}</div>}
      </div>
    ) : null;
    const ratio = both ? exchangeRatio(e) : null;
    const ratioCells = both && columns ? columns.cells(e, "ratio").map(formatRatio) : [];
    const rows: TooltipTableRow[] = [
      ...(showUa ? [{ label: "To Ukraine", color: colors.ukraine, value: e.ua_received ?? "not reported", extra: columns?.cells(e, "ukraine") }] : []),
      ...(showRu ? [{ label: "To Russia", color: colors.russia, value: e.ru_received ?? "not reported", extra: columns?.cells(e, "russia") }] : []),
    ];
    if (ratio != null || ratioCells.some((x) => x != null)) {
      rows.push({ label: "Ratio", color: t.textMuted, value: formatRatio(ratio), extra: ratioCells, separatorAbove: true });
    }
    return {
      header: e.date,
      rows,
      // A header only says something once there are columns to tell apart.
      extraColumns: columns?.headers,
      valueLabel: columns ? "Total" : undefined,
      footer,
      minWidth: columns ? 280 : 200,
      sources: sources(e),
    };
  };

  const unreported = (n: number) => n > 0 && ` (+${n} unreported)`;
  const subheader = (
    <div style={{ display: "flex", gap: 16, marginBottom: 10, fontFamily: FONTS.mono, fontSize: 11, flexWrap: "wrap" }}>
      {showUa && (
        <span style={{ color: colors.ukraine }}>
          Σ TO UKRAINE {totals.toUkraine.toLocaleString()}{unreported(totals.ukraineUnknown)}
        </span>
      )}
      {showRu && (
        <span style={{ color: colors.russia }}>
          Σ TO RUSSIA {totals.toRussia.toLocaleString()}{unreported(totals.russiaUnknown)}
        </span>
      )}
      {both && totals.ratio != null && (
        <span style={{ color: t.textMuted }} title="Returned to Ukraine per one returned to Russia, over the exchanges both sides reported">
          RATIO ≈ {formatRatio(totals.ratio)}
        </span>
      )}
      <span style={{ color: t.textMuted }}>{totals.exchanges} EXCHANGES</span>
    </div>
  );

  return (
    <MonthlyChartCard
      title={title} data={rows} wfull describe={describe} subheader={subheader}
      // An exchange with no figure on either side (the Istanbul stages of
      // June 2025, announced only as "a group") still says what it was.
      showEmptyWrapper
      // The full date: a month can hold several exchanges, which "YYYY/MM"
      // would label alike.
      tickFormatter={(d) => d.replace(/-/g, "/")}
      legend={both ? [
        { label: "To Ukraine", color: colors.ukraine },
        { label: "To Russia", color: colors.russia },
      ] : undefined}
    >
      {showUa && (
        <Bar dataKey="ua_received" name="To Ukraine"
          shape={styledBar<T>((e) => ({
            fill: colors.ukraine, ...noteOutline(e.status === "discrepancy", c.noteText),
          }))} />
      )}
      {showRu && (
        <Bar dataKey="ru_received" name="To Russia"
          shape={styledBar<T>((e) => ({
            fill: colors.russia, ...noteOutline(e.status === "discrepancy", c.noteText),
          }))} />
      )}
    </MonthlyChartCard>
  );
}
