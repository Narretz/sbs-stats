import { useMemo } from "react";
import { PageScaffold } from "@/components/PageScaffold";
import { ExchangeChart } from "@/components/ExchangeChart";
import { MonthWindowControls } from "@/components/MonthWindowControls";
import { useMonthlyMonthRange } from "@/hooks/useMonthlyMonthRange";
import { useTheme } from "@/hooks/useTheme";
import { chartColors } from "@/chartColors";
import { POW_EXCHANGES, breakdownRatios, powExchangeContext, powExchangeSources, sideBreakdown } from "@/data/powExchanges";
import { exchangesInWindow } from "@/data/exchanges";
import type { PowExchange } from "@/types";

const first = POW_EXCHANGES[0]?.date ?? "";
const last = POW_EXCHANGES[POW_EXCHANGES.length - 1]?.date ?? "";
const monthsWithExchanges = new Set(POW_EXCHANGES.map((e) => e.date.slice(0, 7))).size;

// The body exchanges' page, for prisoners: bundled data, the whole record by
// default, one chart of both sides and one per side.
export function PowExchangesPage() {
  const yr = useMonthlyMonthRange({ count: monthsWithExchanges, first }, "all");
  const rows = useMemo(
    () => exchangesInWindow(POW_EXCHANGES, yr.months, yr.endMonth),
    [yr.months, yr.endMonth],
  );
  const c = chartColors(useTheme().theme);
  const chart = {
    colors: { ukraine: c.prisonersToUkraine, russia: c.prisonersToRussia },
    sources: powExchangeSources,
    columns: {
      headers: ["Military", "Civilians"],
      cells: (e: PowExchange, row: "ukraine" | "russia" | "ratio") => {
        if (row === "ratio") {
          const r = breakdownRatios(e);
          return [r.military, r.civilians];
        }
        const b = row === "ukraine"
          ? sideBreakdown(e.ua_received, e.ua_received_civilians)
          : sideBreakdown(e.ru_received, e.ru_received_civilians);
        return [b.military, b.civilians];
      },
    },
    context: powExchangeContext,
  };
  return (
    <PageScaffold
      title="Prisoner Exchanges between Russia and Ukraine"
      description={<>
        People returned from captivity, soldiers and civilians, each side's count as that side reported it · sources:{" "}
        <a href="https://t.me/Koord_shtab" rel="nofollow external" target="_blank">Ukraine's Coordination HQ for POWs</a>
        {" "}(returned to Ukraine) / <a href="https://t.me/mod_russia" rel="nofollow external" target="_blank">Russian MoD</a>
        {" "}(returned to Russia) · {first} – {last}
      </>}
      controls={yr.hidden ? undefined : <MonthWindowControls yr={yr} min={first} />}
      loadState="ready"
      error={null}
      hasData={POW_EXCHANGES.length > 0}
      gridChildren={<>
        <ExchangeChart title="People returned per exchange" data={rows} {...chart} />
        <ExchangeChart title="People returned to Ukraine" data={rows} series="ukraine" {...chart} />
        <ExchangeChart title="People returned to Russia" data={rows} series="russia" {...chart} />
      </>}
    />
  );
}
