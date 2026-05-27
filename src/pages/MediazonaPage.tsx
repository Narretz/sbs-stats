import { useEffect, useMemo, useState } from "react";
import { useMediazonaDatabaseContext } from "@/context/useMediazonaDatabaseContext";
import { useTheme } from "@/hooks/useTheme";
import { DataWindow } from "@/components/DataWindow";
import { RoleCompositionChart } from "@/components/RoleCompositionChart";
import { DocumentedVsEstimatedChart } from "@/components/DocumentedVsEstimatedChart";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
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

export function MediazonaPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const { loadState, error, queryRoles, queryEstimate, queryDataWindow } = useMediazonaDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);
  const [roles, setRoles] = useState<MediazonaRolesRow[]>([]);
  const [estimate, setEstimate] = useState<MediazonaEstimateRow[]>([]);
  const [hasData, setHasData] = useState(false);

  useEffect(() => {
    if (loadState === "ready") {
      setRoles(queryRoles());
      setEstimate(queryEstimate());
      setHasData(true);
    }
  }, [loadState, queryRoles, queryEstimate, refreshKey]);

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
          Russian war dead — Mediazona &amp; Meduza
        </h1>
        <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
          Confirmed, individually-named deaths and the probate-registry statistical estimate · source: Mediazona / Meduza{" "}
            <a href="https://en.zona.media/article/2026/05/22/casualties_eng-trl" rel="nofollow external" target="_blank">Russian losses in the war with Ukraine</a> · {" "}
            <a href="https://en.zona.media/article/2026/05/09/losses" rel="nofollow external" target="_blank">352,000 deaths in four years</a>
        </p>
        <DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="mediazona" />
        <p style={{ fontFamily: FONTS.mono, fontSize: 11, lineHeight: 1.6, color: t.textMuted, marginTop: 12, maxWidth: 880 }}>
          Two weekly series, both bucketed by <i>date of death</i>. <b style={{ color: t.text }}>Documented</b> deaths are
          names Mediazona has individually confirmed (obituaries, court records, social media). The{" "}
          <b style={{ color: t.text }}>estimate</b> is Mediazona/Meduza's <i>estimate of actual losses</i>: a Probate-Registry
          model of excess male inheritance cases, <i>plus</i> an estimate of "late" fatalities (registered 180+ days after
          death, incl. court-declared). The most recent ~6 months are only partly registry-backed (probate filings take
          180+ days to complete) and partly model-based, and will be revised in the next Mediazona release as more filings
          come in. The named list captures an estimated 45–65% of the true toll, so the estimate runs well above it — and
          because it is a modelled redistribution rather than a count built on the named total, it can sit slightly below
          documented in some early weeks. The provisional window (H2 2025) is <span style={{ background: t.textMuted, opacity: 0.5, padding: "0 4px", borderRadius: 2 }}>shaded</span> on
          the names-vs-estimate chart.
        </p>
      </div>

      {loadState === "loading" && !hasData && <LoadingScreen message="Loading Mediazona database…" />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {(loadState === "ready" || hasData) && (
        <ChartGrid>
          <DocumentedVsEstimatedChart rows={estimate} />
          <Note t={t}>
            The gap between the lines is the undercount, widening to roughly ×6 of the recorded names by late 2025. Within
            the shaded window the estimate is only partly registry-backed — probate filings take 180+ days, so H2 2025 is
            still settling — and partly model-based, and the names count is also being filled in; both will shift in the
            next Mediazona release. (Their published chart shows a separate "forecast" line in this window comparing the
            original flash prediction to the revised figure; we don't have that comparison line here.) This estimate is
            the all-in "estimate of actual losses" (~352k), already folding in ~90k "late" / court-declared fatalities;
            it sits above the raw Probate-Registry figure, which this export doesn't break out.
          </Note>
          <Note t={t}>
            Note the recorded-names total here (~218k) differs from the by-role composition file below (~202k); both
            are the same recorded-names dataset, most likely captured at slightly different times / processings, so treat
            the exact names level as approximate.
          </Note>
          <RoleCompositionChart rows={roles} />
          <Note t={t}>
            Share of each week's <i>named</i> deaths by force type. Shown as shares (not counts) so the composition
            stays readable even where the weekly total is thin — but where the total line collapses (recent months,
            names still being identified) the share rests on very few deaths and is unreliable.
          </Note>
        </ChartGrid>
      )}
    </div>
  );
}
