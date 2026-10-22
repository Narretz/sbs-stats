import { Bar } from "recharts";
import { noteOutline, styledBar } from "@/components/barShape";
import { MonthlyChartCard } from "@/components/MonthlyChartCard";
import type { TooltipDescriptor } from "@/components/TooltipTable";
import { useTheme } from "@/hooks/useTheme";
import { chartColors } from "@/chartColors";
import { FONTS } from "@/theme";
import { bodyExchangeSources, bodyExchangeTotals, exchangeRatio } from "@/data/bodyExchanges";
import type { BodyExchange } from "@/types";

interface Props {
  title: string;
  data: readonly BodyExchange[];
  // One side's bars alone, on its own scale. Russia's need it — next to
  // Ukraine's 1,000-body exchanges of 2025–26 they are a few pixels high.
  series?: "both" | "ukraine" | "russia";
}

// One pair of bars per exchange on a categorical axis, like the source chart:
// the exchanges are irregular, and on a time axis the June 2025 run of five
// on consecutive days would collapse into one stripe.
export function BodyExchangeChart({ title, data, series = "both" }: Props) {
  const both = series === "both";
  const showUa = series !== "russia";
  const showRu = series !== "ukraine";
  const { theme: t } = useTheme();
  const c = chartColors(t);
  const totals = bodyExchangeTotals(data);
  const rows = data as BodyExchange[];

  const describe = (e: BodyExchange): TooltipDescriptor => {
    const caveat =
      e.status === "discrepancy" ? "Sources disagree"
      : e.status === "partial" && e.ru_received == null ? "Russia gave no figure"
      : null;
    const footer = caveat || e.notes ? (
      <div className="tooltip-note" style={{ fontSize: "0.833em", marginTop: 6, maxWidth: 320, whiteSpace: "normal" }}>
        {caveat && <div style={{ color: c.noteText }}>⚠ {caveat}</div>}
        {e.notes && <div style={{ color: t.textMuted }}>{e.notes}</div>}
      </div>
    ) : null;
    const ratio = both ? exchangeRatio(e) : null;
    return {
      header: e.date,
      rows: [
        ...(showUa ? [{ label: "To Ukraine", color: c.bodiesToUkraine, value: e.ua_received }] : []),
        ...(showRu ? [{ label: "To Russia", color: c.bodiesToRussia, value: e.ru_received ?? "not reported" }] : []),
        ...(ratio != null ? [{ label: "Ratio", color: t.textMuted, value: `${ratio.toFixed(1)} : 1`, separatorAbove: true }] : []),
      ],
      footer,
      minWidth: 200,
      sources: bodyExchangeSources(e),
    };
  };

  const subheader = (
    <div style={{ display: "flex", gap: 16, marginBottom: 10, fontFamily: FONTS.mono, fontSize: 11, flexWrap: "wrap" }}>
      {showUa && <span style={{ color: c.bodiesToUkraine }}>Σ TO UKRAINE {totals.toUkraine.toLocaleString()}</span>}
      {showRu && (
        <span style={{ color: c.bodiesToRussia }}>
          Σ TO RUSSIA {totals.toRussia.toLocaleString()}
          {totals.russiaUnknown > 0 && ` (+${totals.russiaUnknown} unreported)`}
        </span>
      )}
      {both && totals.ratio != null && (
        <span style={{ color: t.textMuted }} title="Bodies returned to Ukraine per body returned to Russia, over the exchanges both sides reported">
          RATIO ≈ {totals.ratio.toFixed(1)} : 1
        </span>
      )}
      <span style={{ color: t.textMuted }}>{totals.exchanges} EXCHANGES</span>
    </div>
  );

  return (
    <MonthlyChartCard
      title={title} data={rows} wfull describe={describe} subheader={subheader}
      // The full date: a month can hold several exchanges, which "YYYY/MM"
      // would label alike.
      tickFormatter={(d) => d.replace(/-/g, "/")}
      legend={both ? [
        { label: "To Ukraine", color: c.bodiesToUkraine },
        { label: "To Russia", color: c.bodiesToRussia },
      ] : undefined}
    >
      {showUa && (
        <Bar dataKey="ua_received" name="To Ukraine"
          shape={styledBar<BodyExchange>((e) => ({
            fill: c.bodiesToUkraine, ...noteOutline(e.status === "discrepancy", c.noteText),
          }))} />
      )}
      {showRu && (
        <Bar dataKey="ru_received" name="To Russia"
          shape={styledBar<BodyExchange>((e) => ({
            fill: c.bodiesToRussia, ...noteOutline(e.status === "discrepancy", c.noteText),
          }))} />
      )}
    </MonthlyChartCard>
  );
}
