import type { ReactNode } from "react";
import { useTheme } from "@/hooks/useTheme";
import { ChartCardTitle } from "@/components/ChartCardTitle";
import { FONTS } from "@/theme";
import { STRIP_ANCHOR, STRIP_TITLE } from "@/components/weatherStripShared";

/** The card both weather strips sit in: full width in the chart grid, titled
 *  and anchored like a chart card, under its own class (.weather-card) so
 *  specs taking "the first .hourly-card" still get a chart. `status`, when
 *  set, is shown in place of the children: loading, failed, or no data for the
 *  range (stripStatus in weatherStripShared). */
export function StripCard({ children, status }: { children: ReactNode; status?: string | null }) {
  const { theme: t } = useTheme();
  return (
    <div className="weather-card" id={STRIP_ANCHOR} data-testid="weather-strip" style={{
      position: "relative",
      background: t.surface,
      border: `1px solid ${t.surfaceBorder}`,
      borderRadius: 8,
      padding: "18px 16px 12px",
      gridColumn: "1 / -1",
      boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
    }}>
      <ChartCardTitle title={STRIP_TITLE} anchor={STRIP_ANCHOR} marginBottom={6} />
      {status
        ? <div style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted }}>{status}</div>
        : children}
    </div>
  );
}
