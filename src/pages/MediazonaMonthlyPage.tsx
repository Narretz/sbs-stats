import { useEffect, useMemo, useState } from "react";
import { useMediazonaDatabaseContext } from "@/context/databases";
import { useTheme } from "@/hooks/useTheme";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { DataWindow } from "@/components/DataWindow";
import { RoleCompositionChart } from "@/components/RoleCompositionChart";
import { DocumentedVsEstimatedChart } from "@/components/DocumentedVsEstimatedChart";
import { PageScaffold } from "@/components/PageScaffold";
import { MonthWindowControls } from "@/components/MonthWindowControls";
import { useMonthlyMonthRange } from "@/hooks/useMonthlyMonthRange";
import { mediazonaWindow, unionSpan } from "@/utils/mediazonaWindow";
import type { MediazonaRolesRow, MediazonaEstimateRow } from "@/types";
import { FONTS, type Theme } from "@/theme";

// Must match PROVISIONAL_MONTHS in DocumentedVsEstimatedChart.
const PROVISIONAL_MONTHS = 6;

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
  useDocumentTitle("Monthly Russian war dead — Mediazona & Meduza");
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

  const span = useMemo(() => unionSpan(roles, estimate), [roles, estimate]);
  // Default "all": the whole war is what this page is about.
  const yr = useMonthlyMonthRange(span.count, "all");
  const win = useMemo(
    () => mediazonaWindow(roles, estimate, yr.hidden ? "all" : yr.months, yr.end),
    [roles, estimate, yr.hidden, yr.months, yr.end],
  );
  // Provisional is a property of the data's newest months, not of the window's:
  // a window ending in 2024 has nothing provisional in it.
  const provisionalFrom = estimate.length > PROVISIONAL_MONTHS ? estimate[estimate.length - PROVISIONAL_MONTHS].week : null;

  return (
    <PageScaffold
      headerVariant="block"
      title="Monthly Russian war dead (aggregated) — Mediazona & Meduza"
      description={<>
        Weekly Mediazona/Meduza data re-bucketed to calendar months (each week summed into the month its start date
        falls in). Same series as the weekly view — confirmed individually-named deaths and the probate-registry
        statistical estimate.
      </>}
      dataWindow={<DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="mediazona" />}
      headerExtra={
        <p style={{ fontFamily: FONTS.mono, fontSize: 11, lineHeight: 1.6, color: t.textMuted, marginTop: 12 }}>
          The most recent months are still provisional — the estimate is only partly registry-backed (probate filings
          take 180+ days to complete) and partly model-based, and the names count is still being filled in; both will
          shift in the next Mediazona release. The provisional window (~6 months) is{" "}
          <span style={{ background: t.textMuted, opacity: 0.5, padding: "0 4px", borderRadius: 2 }}>shaded</span> on
          the names-vs-estimate chart.
        </p>
      }
      controls={yr.hidden ? undefined : (
        <>
          {/* Live is the latest month either series has, not the calendar's:
              both are published with a lag. */}
          <MonthWindowControls yr={yr} min={span.first} max={span.last} />
        </>
      )}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading Mediazona database…"
    >
        <div>
          <DocumentedVsEstimatedChart rows={win.estimate} bucket="monthly" provisionalFrom={provisionalFrom} />
          <Note t={t}>
            Monthly view: each point sums the weeks whose start date falls in that calendar month, so months containing
            partial weeks at their start/end can read slightly low or high relative to a true day-bucketed sum.
          </Note>
          <RoleCompositionChart rows={win.roles} bucket="monthly" />
          <Note t={t}>
            Share of each month's <i>named</i> deaths by force type. Shown as shares (not counts) so the composition
            stays readable even where the monthly total is thin — but where the total line collapses (recent months,
            names still being identified) the share rests on very few deaths and is unreliable.
          </Note>
        </div>
    </PageScaffold>
  );
}
