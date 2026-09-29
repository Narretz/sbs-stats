import { useEffect, useMemo, useState } from "react";
import { useZelenskyWeeklyDatabaseContext } from "@/context/databases";
import { useTheme } from "@/hooks/useTheme";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { PageScaffold } from "@/components/PageScaffold";
import {
  ZELENSKY_CATEGORIES,
  ZELENSKY_CATEGORY_LABELS,
  type MonthlyDataPoint,
  type ZelenskyCategory,
  type ZelenskyWeekRow,
} from "@/types";
import { formatHedged, formatWeekRange, formatWeekTick, mondaysBetween, quarterTicks, toWeeklyDataset } from "@/utils/zelenskyWeekly";
import { FONTS } from "@/theme";

interface Props {
  refreshKey?: number;
}

const CHANNEL_URL = "https://t.me/V_Zelenskiy_official";

export function ZelenskyWeeklyPage({ refreshKey }: Props) {
  const { theme: t } = useTheme();
  const { loadState, error, queryWeeks } = useZelenskyWeeklyDatabaseContext();
  const [rows, setRows] = useState<ZelenskyWeekRow[]>([]);
  const [hasData, setHasData] = useState(false);

  useEffect(() => {
    if (loadState === "ready") {
      setRows(queryWeeks());
      setHasData(true);
    }
  }, [loadState, queryWeeks, refreshKey]);

  // Every week from the first tally to the last, so the months without one
  // show as gaps instead of being closed up.
  const mondays = useMemo(
    () => (rows.length ? mondaysBetween(rows[0].period_start, rows[rows.length - 1].period_start) : []),
    [rows],
  );
  const ticks = useMemo(() => quarterTicks(mondays), [mondays]);
  const byMonday = useMemo(() => new Map(rows.map((r) => [r.period_start, r])), [rows]);

  // Tooltip header: the week spelled out, plus the figure as the post hedged
  // it — the bar height alone would present "понад 3170" as exactly 3,170.
  const headerFor = (category: ZelenskyCategory) => (d: MonthlyDataPoint) => {
    const r = byMonday.get(d.date);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span>{formatWeekRange(d.date)}</span>
        <span style={{ fontSize: 10, color: t.textMuted }}>
          {r
            ? <>{r.period} · as posted: {formatHedged(r[category], r[`${category}_bound`])}</>
            : "no weekly tally posted"}
        </span>
      </div>
    );
  };

  const first = rows[0]?.period_start;
  const last = rows[rows.length - 1]?.period_end;

  return (
    <PageScaffold
      title="Weekly Russian Strikes — President of Ukraine"
      descriptionStyle={{ maxWidth: 900, lineHeight: 1.55 }}
      description={<>
        Russian strike drones, guided aerial bombs (KAB) and missiles launched at Ukraine each
        week, as totalled in the President's weekly post on his
        {" "}
        <a href={CHANNEL_URL} rel="nofollow external">Telegram channel</a>.
        {" "}
        The figures are <em>rounded</em>, and most are hedged («понад» over, «майже» almost,
        «близько» about); the tooltip shows each one as posted.
        {" "}
        Posts say only "this week" or "last week", so the dates are worked out from when
        each post went up (Monday–Sunday, Kyiv time).
        {" "}
        Empty weeks had no weekly tally. Through most of Apr–Sep 2025 the President posted
        month-to-date totals instead, which are not shown here.
      </>}
      dataWindow={first && last ? (
        <details style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 6 }}>
          <summary style={{ cursor: "pointer", listStyle: "revert" }}>
            Data Availability: {first} – {last} · {rows.length} weekly tall{rows.length === 1 ? "y" : "ies"}
          </summary>
          <ol style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "flex", flexDirection: "column", gap: 6 }}>
            {rows.map((r, i) => (
              <li key={r.period} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <span style={{ color: t.textFaint, minWidth: 24 }}>[{i + 1}]</span>
                <span style={{ color: t.text, minWidth: 70 }}>{r.period}</span>
                <span style={{ flex: 1 }}>
                  {formatWeekRange(r.period_start)}
                  <span style={{ color: t.textFaint }}> · posted {r.posted_at.slice(0, 10)}</span>
                  {" · "}
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    style={{ color: t.primary, textDecoration: "underline" }}
                  >
                    source ↗
                  </a>
                </span>
              </li>
            ))}
          </ol>
        </details>
      ) : undefined}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading weekly strike tallies…"
      gridChildren={<>
        {ZELENSKY_CATEGORIES.map((k) => (
          <MonthlyBarChart
            key={k}
            title={ZELENSKY_CATEGORY_LABELS[k]}
            data={toWeeklyDataset(rows, k, mondays)}
            wfull
            formatTick={formatWeekTick}
            xTicks={ticks}
            formatHeader={headerFor(k)}
            explainGaps
          />
        ))}
      </>}
    />
  );
}
