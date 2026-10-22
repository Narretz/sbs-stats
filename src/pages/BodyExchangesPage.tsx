import { useMemo } from "react";
import { PageScaffold } from "@/components/PageScaffold";
import { BodyExchangeChart } from "@/components/BodyExchangeChart";
import { MonthWindowControls } from "@/components/MonthWindowControls";
import { useMonthlyMonthRange } from "@/hooks/useMonthlyMonthRange";
import { BODY_EXCHANGES, exchangesInWindow } from "@/data/bodyExchanges";

const first = BODY_EXCHANGES[0]?.date ?? "";
const last = BODY_EXCHANGES[BODY_EXCHANGES.length - 1]?.date ?? "";
// The picker hides itself for a dataset of 12 months or fewer; what counts is
// the months the record spans, not the exchanges in it.
const monthsWithExchanges = new Set(BODY_EXCHANGES.map((e) => e.date.slice(0, 7))).size;

// JSON-backed like the HUR missiles view: the data is bundled, so there is no
// load state. The window opens on the whole record — at ~1 exchange a month a
// 12-month default would hide most of it.
export function BodyExchangesPage() {
  const yr = useMonthlyMonthRange({ count: monthsWithExchanges, first }, "all");
  const rows = useMemo(
    () => exchangesInWindow(BODY_EXCHANGES, yr.months, yr.endMonth),
    [yr.months, yr.endMonth],
  );
  return (
    <PageScaffold
      title="Body Exchanges between Russia and Ukraine"
      description={<>
        Repatriations of fallen soldiers' bodies, each side's count as that side reported it · sources:{" "}
        <a href="https://t.me/Koord_shtab" rel="nofollow external" target="_blank">Ukraine's Coordination HQ for POWs</a>
        {" "}(bodies received by Ukraine) / <a href="https://www.rbc.ru" rel="nofollow external" target="_blank">RBC</a>
        {" "}(Russian officials' figures) · {first} – {last}
      </>}
      controls={yr.hidden ? undefined : <MonthWindowControls yr={yr} min={first} />}
      loadState="ready"
      error={null}
      hasData={BODY_EXCHANGES.length > 0}
      gridChildren={<>
        <BodyExchangeChart title="Bodies returned per exchange" data={rows} />
        <BodyExchangeChart title="Bodies returned to Ukraine" data={rows} series="ukraine" />
        <BodyExchangeChart title="Bodies returned to Russia" data={rows} series="russia" />
      </>}
    />
  );
}
