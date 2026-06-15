import { useEffect, useMemo, useState } from "react";
import { useMediazonaDatabaseContext } from "@/context/useMediazonaDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { DataWindow } from "@/components/DataWindow";
import { RoleCompositionChart } from "@/components/RoleCompositionChart";
import { DocumentedVsEstimatedChart } from "@/components/DocumentedVsEstimatedChart";
import { LoadingScreen, ErrorScreen } from "@/components/Layout";
import type { MediazonaRolesRow, MediazonaEstimateRow } from "@/types";
import { FONTS, type Theme } from "@/theme";

interface Props {
  refreshKey?: number;
}

function Note({ t, children }: { t: Theme; children: React.ReactNode }) {
  return (
    <p style={{ fontFamily: FONTS.mono, fontSize: 11, lineHeight: 1.5, color: t.textMuted, margin: "8px 2px 22px" }}>
      {children}
    </p>
  );
}

export function MediazonaMonthlyPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const { loadState, error, queryRolesMonthly, queryEstimateMonthly, queryDataWindow } = useMediazonaDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);
  const [roles, setRoles] = useState<MediazonaRolesRow[]>([]);
  const [estimate, setEstimate] = useState<MediazonaEstimateRow[]>([]);
  const [hasData, setHasData] = useState(false);

  useEffect(() => {
    if (loadState === "ready") {
      setRoles(queryRolesMonthly());
      setEstimate(queryEstimateMonthly());
      setHasData(true);
    }
  }, [loadState, queryRolesMonthly, queryEstimateMonthly, refreshKey]);

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
          Monthly Russian war dead (aggregated) — Mediazona &amp; Meduza
        </h1>
        <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
          Weekly Mediazona/Meduza data re-bucketed to calendar months (each week summed into the month its start date
          falls in). Same series as the weekly view — confirmed individually-named deaths and the probate-registry
          statistical estimate.
        </p>
        <DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="mediazona" />
        <p style={{ fontFamily: FONTS.mono, fontSize: 11, lineHeight: 1.6, color: t.textMuted, marginTop: 12 }}>
          The most recent months are still provisional — the estimate is only partly registry-backed (probate filings
          take 180+ days to complete) and partly model-based, and the names count is still being filled in; both will
          shift in the next Mediazona release. The provisional window (~6 months) is{" "}
          <span style={{ background: t.textMuted, opacity: 0.5, padding: "0 4px", borderRadius: 2 }}>shaded</span> on
          the names-vs-estimate chart.
        </p>
      </div>

      {loadState === "loading" && !hasData && <LoadingScreen message="Loading Mediazona database…" />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {(loadState === "ready" || hasData) && (
        <div>
          <DocumentedVsEstimatedChart rows={estimate} bucket="monthly" />
          <Note t={t}>
            Monthly view: each point sums the weeks whose start date falls in that calendar month, so months containing
            partial weeks at their start/end can read slightly low or high relative to a true day-bucketed sum.
          </Note>
          <RoleCompositionChart rows={roles} bucket="monthly" />
          <Note t={t}>
            Share of each month's <i>named</i> deaths by force type. Shown as shares (not counts) so the composition
            stays readable even where the monthly total is thin — but where the total line collapses (recent months,
            names still being identified) the share rests on very few deaths and is unreliable.
          </Note>
        </div>
      )}
    </div>
  );
}
