// UA+RU POW EXCHANGES: backed by the hand-curated
// scripts/pow_exchanges/exchanges.json, bundled at build time like the body
// exchanges. The arithmetic shared with them is in ./exchanges.
import rawData from "../../scripts/pow_exchanges/exchanges.json";
import type { PowExchange, PowExchangeDataset } from "@/types";
import type { SheetSource } from "@/components/TooltipTable";
import { exchangeSheetSources } from "@/data/exchanges";

const data = rawData as unknown as PowExchangeDataset;

export const POW_EXCHANGES: readonly PowExchange[] = data.exchanges;

const VIA_LABEL: Record<string, string> = {
  "Koord_shtab (Telegram)": "Koord. HQ",
  "mod_russia (Telegram)": "RU MoD",
  "vereshchuk_iryna (Telegram)": "Vereshchuk",
  "DIUkraine (Telegram)": "GUR",
};
const COVERS_LABEL: Record<string, string> = {
  ua_received: "Ukraine", ua_received_civilians: "Ukraine's civilians",
  ru_received: "Russia", ru_received_civilians: "Russia's civilians",
  date: "date",
};

export function powExchangeSources(e: PowExchange): SheetSource[] {
  return exchangeSheetSources(e.sources, VIA_LABEL, COVERS_LABEL);
}

export interface Breakdown {
  military: number | null;
  civilians: number | null;
}

// One side's people split into military and civilians. Military is the total
// less the civilians, so it is known only when the civilians are; null where
// the side gave no split (not 0).
export function sideBreakdown(total: number | null, civilians: number | null): Breakdown {
  if (total == null || civilians == null) return { military: null, civilians };
  return { military: total - civilians, civilians };
}

// Returned to Ukraine per one returned to Russia, for each column: total,
// military, civilians. Null where either side's figure is unknown or Russia's
// is 0 (fifty civilians for none has no ratio to speak of).
export function breakdownRatios(e: PowExchange): { total: number | null; military: number | null; civilians: number | null } {
  const ua = sideBreakdown(e.ua_received, e.ua_received_civilians);
  const ru = sideBreakdown(e.ru_received, e.ru_received_civilians);
  const r = (a: number | null, b: number | null) => (a == null || b == null || b === 0 ? null : a / b);
  return {
    total: r(e.ua_received, e.ru_received),
    military: r(ua.military, ru.military),
    civilians: r(ua.civilians, ru.civilians),
  };
}

// What the tooltip says under the table: the deal a stage belongs to, its
// mediator, and whether it was a one-way release — context, not figures.
export function powExchangeContext(e: PowExchange): string | null {
  const parts = [
    e.kind === "release" ? "One-way release" : null,
    e.deal,
    e.mediator ? `mediator: ${e.mediator}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}
