import { useMemo } from "react";
import { PageScaffold } from "@/components/PageScaffold";
import { ExchangeChart } from "@/components/ExchangeChart";
import { MonthWindowControls } from "@/components/MonthWindowControls";
import { BarOrderSelect } from "@/components/BarOrderSelect";
import { MoreControls } from "@/components/MoreControls";
import { useBarOrder } from "@/hooks/useBarOrder";
import { rankingOf } from "@/utils/barOrder";
import { useMonthlyMonthRange } from "@/hooks/useMonthlyMonthRange";
import { useTheme } from "@/hooks/useTheme";
import { chartColors } from "@/chartColors";
import { BODY_EXCHANGES, bodyExchangeSources } from "@/data/bodyExchanges";
import { exchangesInWindow } from "@/data/exchanges";
import { siteTitle } from "@/types";

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
  const [order, setOrder] = useBarOrder();
  const windowRows = useMemo(
    () => exchangesInWindow(BODY_EXCHANGES, yr.months, yr.endMonth),
    [yr.months, yr.endMonth],
  );
  // Ranked, every exchange up to the window's end, as many as the window has.
  const rows = useMemo(
    () => (order === "date" ? windowRows : exchangesInWindow(BODY_EXCHANGES, "all", yr.endMonth)),
    [order, windowRows, yr.endMonth],
  );
  const ranking = rankingOf(order, windowRows.length);
  const c = chartColors(useTheme().theme);
  const chart = { colors: { ukraine: c.bodiesToUkraine, russia: c.bodiesToRussia }, sources: bodyExchangeSources };
  return (
    <PageScaffold
      title={siteTitle("body-exchanges")}
      description={<>
        Repatriations of fallen soldiers' bodies, each side's count as that side reported it · sources:{" "}
        <a href="https://t.me/Koord_shtab" rel="nofollow external" target="_blank">Ukraine's Coordination HQ for POWs</a>
        {" "}(bodies received by Ukraine) / <a href="https://www.rbc.ru" rel="nofollow external" target="_blank">RBC</a>
        {" "}(Russian officials' figures) · {first} – {last}
      </>}
      controls={<>
        {!yr.hidden && <MonthWindowControls yr={yr} min={first} />}
        <MoreControls>
          <BarOrderSelect value={order} onChange={setOrder} />
        </MoreControls>
      </>}
      ranking={ranking}
      loadState="ready"
      error={null}
      hasData={BODY_EXCHANGES.length > 0}
      gridChildren={<>
        <ExchangeChart title="Bodies returned per exchange" data={rows} {...chart} />
        <ExchangeChart title="Bodies returned to Ukraine" data={rows} series="ukraine" {...chart} />
        <ExchangeChart title="Bodies returned to Russia" data={rows} series="russia" {...chart} />
      </>}
    />
  );
}
