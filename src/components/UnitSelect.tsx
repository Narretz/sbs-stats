import { SBS_UNIT_ALL, sbsUnitLabel, type SbsUnit } from "@/types";

interface Props {
  units: SbsUnit[];
  value: string;
  onChange: (slug: string) => void;
}

/**
 * Picks which SBS formation the monthly page is showing: the grouping total
 * (sbs.db) or one sub-unit (sbs-units.db).
 *
 * Retired units are listed rather than hidden — their history is real and
 * often the more interesting thing to look at — but in their own <optgroup>,
 * because a reader scanning the list should not have to know that "Flying
 * Skull" stopped reporting in 2025. The "(retired)" suffix comes from
 * `sbsUnitLabel`, derived from the ingest's `active` flag, so a unit that
 * retires next month gets it with no code change here.
 *
 * Single-select on purpose. Every chart on the page is single-series with its
 * own projection band; overlaying units would mean rewriting MonthlyBarChart
 * and MonthlyTargetPairChart, and the compare page already answers
 * "unit A vs unit B" properly.
 */
export function UnitSelect({ units, value, onChange }: Props) {
  const active = units.filter((u) => u.active);
  const retired = units.filter((u) => !u.active);

  return (
    <label className="ctl-label">
      Unit:{" "}
      <select
        className="ctl"
        data-testid="sbs-unit-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // Disabled rather than hidden while the registry loads, so the control
        // doesn't pop into existence and shift the row.
        disabled={!units.length}
      >
        <option value={SBS_UNIT_ALL}>Угруповання СБС (all)</option>
        {active.length > 0 && (
          <optgroup label="Units">
            {active.map((u) => (
              <option key={u.slug} value={u.slug}>{sbsUnitLabel(u)}</option>
            ))}
          </optgroup>
        )}
        {retired.length > 0 && (
          <optgroup label="No longer reporting">
            {retired.map((u) => (
              <option key={u.slug} value={u.slug}>
                {sbsUnitLabel(u)}
                {u.first_month && u.last_month ? ` · ${u.first_month}…${u.last_month}` : ""}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}
