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

// Must match PROVISIONAL_WEEKS in DocumentedVsEstimatedChart so the prose label
// matches the shaded region on the chart.
const PROVISIONAL_WEEKS = 26;
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function fmtApproxK(n: number): string {
  return `~${Math.round(n / 1000)}k`;
}
function fmtYearMonth(week: string | null): string {
  if (!week) return "";
  const [y, m] = week.split("-");
  return `${y}/${m}`;
}
function fmtMonthYear(week: string | null): string {
  if (!week) return "";
  const [y, m] = week.split("-");
  return `${MONTHS[parseInt(m, 10) - 1]} ${y}`;
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

  const documentedTotal = estimate.reduce(
    (s, r) => s + (typeof r.documented === "number" ? r.documented : 0),
    0,
  );
  const rolesTotal = roles.reduce((s, r) => s + r.total, 0);
  const rolesMaxWeek = roles.length ? roles[roles.length - 1].week : null;
  const provisionalFromWeek =
    estimate.length > PROVISIONAL_WEEKS ? estimate[estimate.length - PROVISIONAL_WEEKS].week : null;

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
          Weekly Russian war dead — Mediazona &amp; Meduza
        </h1>
        <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
          Confirmed, individually-named deaths and the probate-registry statistical estimate · source: Mediazona / Meduza{" "}
            <a href="https://en.zona.media/article/2026/05/22/casualties_eng-trl" rel="nofollow external" target="_blank">Russian losses in the war with Ukraine</a> · {" "}
            <a href="https://en.zona.media/article/2026/05/09/losses" rel="nofollow external" target="_blank">352,000 deaths in four years</a>
        </p>
        <DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="mediazona" />
        <p style={{ fontFamily: FONTS.mono, fontSize: 11, lineHeight: 1.6, color: t.textMuted, marginTop: 12 }}>
          Two weekly series, both bucketed by <i>date of death</i>. <b style={{ color: t.text }}>Documented</b> deaths are
          names Mediazona has individually confirmed (obituaries, court records, social media). The{" "}
          <b style={{ color: t.text }}>estimate</b> is Mediazona/Meduza's <i>estimate of actual losses</i>: a Probate-Registry
          model of excess male inheritance cases, <i>plus</i> an estimate of "late" fatalities (registered 180+ days after
          death, incl. court-declared). The most recent ~6 months are only partly registry-backed (probate filings take
          180+ days to complete) and partly model-based, and will be revised in the next Mediazona release as more filings
          come in. The named list captures an estimated 45–65% of the true toll, so the estimate runs well above it — and
          because it is a modelled redistribution rather than a count built on the named total, it can sit slightly below
          documented in some early weeks. The provisional window{provisionalFromWeek ? ` (since ${fmtMonthYear(provisionalFromWeek)})` : ""} is <span style={{ background: t.textMuted, opacity: 0.5, padding: "0 4px", borderRadius: 2 }}>shaded</span> on
          the names-vs-estimate chart.
        </p>
      </div>

      {loadState === "loading" && !hasData && <LoadingScreen message="Loading Mediazona database…" />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {(loadState === "ready" || hasData) && (
        <div>
          <DocumentedVsEstimatedChart rows={estimate} />
          <Note t={t}>
            Note the recorded-names total here ({fmtApproxK(documentedTotal)}) differs from the by-role composition file below ({fmtApproxK(rolesTotal)}); both
            are the same recorded-names dataset, most likely captured at slightly different times / processings:
            1) The by-role dataset contains data up to {fmtYearMonth(rolesMaxWeek)}; 2) the week start dates are slightly different between the datasets.
          </Note>
          <Note t={t}>
            Share of each week's <i>named</i> deaths by force type. Shown as shares (not counts) so the composition
            stays readable even where the weekly total is thin — but where the total line collapses (recent months,
            names still being identified) the share rests on very few deaths and is unreliable.
          </Note>
          <RoleCompositionChart rows={roles} />
        </div>
      )}
    </div>
  );
}
