// UA+RU BODY EXCHANGES: backed by the hand-curated
// scripts/body_exchanges/exchanges.json read DIRECTLY (no SQLite/R2 round-trip),
// like the HUR missiles view. Exchanges are irregular (~monthly) and announced
// by each side separately, so the file is edited by hand and bundled at build
// time.
import rawData from "../../scripts/body_exchanges/exchanges.json";
import type { BodyExchange, BodyExchangeDataset } from "@/types";
import type { SheetSource } from "@/components/TooltipTable";
import { windowStartMonth, type MonthOption } from "@/utils/monthRange";

const data = rawData as unknown as BodyExchangeDataset;

export const BODY_EXCHANGES: readonly BodyExchange[] = data.exchanges;

// The exchanges inside an N-month window ending at `endMonth` (YYYY-MM), by
// calendar month: a month can hold several exchanges or none, so the window
// can't be counted in rows the way the monthly pages' one-row-per-month is.
export function exchangesInWindow(
  rows: readonly BodyExchange[], months: MonthOption, endMonth: string,
): BodyExchange[] {
  const start = windowStartMonth(endMonth, months);
  return rows.filter((e) => e.date.slice(0, 7) >= start && e.date.slice(0, 7) <= endMonth);
}

export interface BodyExchangeTotals {
  exchanges: number;
  toUkraine: number;
  toRussia: number;
  // Exchanges with no Russian figure: left out of `toRussia`, not counted as 0.
  russiaUnknown: number;
  // Bodies returned to Ukraine per body returned to Russia, over the exchanges
  // where both sides gave a figure — an exchange with only Ukraine's count
  // would otherwise inflate it.
  ratio: number | null;
}

export function bodyExchangeTotals(rows: readonly BodyExchange[]): BodyExchangeTotals {
  let toUkraine = 0, toRussia = 0, russiaUnknown = 0, pairedUa = 0, pairedRu = 0;
  for (const e of rows) {
    toUkraine += e.ua_received ?? 0;
    if (e.ru_received == null) russiaUnknown++;
    else toRussia += e.ru_received;
    if (e.ua_received != null && e.ru_received != null) {
      pairedUa += e.ua_received;
      pairedRu += e.ru_received;
    }
  }
  return {
    exchanges: rows.length, toUkraine, toRussia, russiaUnknown,
    ratio: pairedRu > 0 ? pairedUa / pairedRu : null,
  };
}

// One exchange's bodies returned to Ukraine per body returned to Russia. Null
// when either side gave no figure, or Russia received none (a one-way
// transfer has no ratio to speak of).
export function exchangeRatio(e: BodyExchange): number | null {
  if (e.ua_received == null || e.ru_received == null || e.ru_received === 0) return null;
  return e.ua_received / e.ru_received;
}

const VIA_LABEL: Record<string, string> = { "Koord_shtab (Telegram)": "Koord. HQ" };

// The pinned sheet's source links: one per source, named by outlet, with the
// figures it carries — "RBC ↗ 2024-11-29 · Ukraine, Russia".
export function bodyExchangeSources(e: BodyExchange): SheetSource[] {
  const what = { ua_received: "Ukraine", ru_received: "Russia", date: "date" } as const;
  return e.sources.map((s) => ({
    href: s.url,
    linkText: VIA_LABEL[s.via] ?? s.via,
    label: `${s.published_at.slice(0, 10)} · ${s.covers.map((c) => what[c]).join(", ")}`,
  }));
}
