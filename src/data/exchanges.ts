// What the hand-curated exchange datasets (bodies, prisoners) have in common:
// one record per exchange, each side's count as THAT side reported it, null
// for no figure (not 0). The arithmetic over them lives here; each dataset's
// module adds its data and its source labels.
import type { ExchangeRecord, ExchangeSource } from "@/types";
import type { SheetSource } from "@/components/TooltipTable";
import { windowStartMonth, type MonthOption } from "@/utils/monthRange";

// The exchanges inside an N-month window ending at `endMonth` (YYYY-MM), by
// calendar month: a month can hold several exchanges or none, so the window
// can't be counted in rows the way the monthly pages' one-row-per-month is.
export function exchangesInWindow<T extends { date: string }>(
  rows: readonly T[], months: MonthOption, endMonth: string,
): T[] {
  const start = windowStartMonth(endMonth, months);
  return rows.filter((e) => e.date.slice(0, 7) >= start && e.date.slice(0, 7) <= endMonth);
}

export interface ExchangeTotals {
  exchanges: number;
  toUkraine: number;
  toRussia: number;
  // Exchanges with no figure from that side: left out of its sum, not
  // counted as 0.
  ukraineUnknown: number;
  russiaUnknown: number;
  // Returned to Ukraine per one returned to Russia, over the exchanges where
  // both sides gave a figure — an exchange with only one side's count would
  // otherwise skew it.
  ratio: number | null;
}

export function exchangeTotals(rows: readonly ExchangeRecord[]): ExchangeTotals {
  let toUkraine = 0, toRussia = 0, ukraineUnknown = 0, russiaUnknown = 0, pairedUa = 0, pairedRu = 0;
  for (const e of rows) {
    if (e.ua_received == null) ukraineUnknown++;
    else toUkraine += e.ua_received;
    if (e.ru_received == null) russiaUnknown++;
    else toRussia += e.ru_received;
    if (e.ua_received != null && e.ru_received != null) {
      pairedUa += e.ua_received;
      pairedRu += e.ru_received;
    }
  }
  return {
    exchanges: rows.length, toUkraine, toRussia, ukraineUnknown, russiaUnknown,
    ratio: pairedRu > 0 ? pairedUa / pairedRu : null,
  };
}

// One exchange's returned-to-Ukraine per returned-to-Russia. Null when either
// side gave no figure, or Russia received none (a one-way transfer has no
// ratio to speak of).
export function exchangeRatio(e: ExchangeRecord): number | null {
  if (e.ua_received == null || e.ru_received == null || e.ru_received === 0) return null;
  return e.ua_received / e.ru_received;
}

// "10.1 : 1", "0.4 : 1" — and "1 : 1", not "1.0 : 1": one decimal, dropped
// when it is 0.
export function formatRatio(r: number | null): string | null {
  if (r == null) return null;
  return `${r.toFixed(1).replace(/\.0$/, "")}:1`;
}

// The pinned sheet's source links: one per post, named by outlet, with the
// figures it carries — "RBC ↗ 2024-11-29 · Ukraine, Russia". A post quoted
// twice (an exchange's total, then its civilians) is one link.
export function exchangeSheetSources(
  sources: readonly ExchangeSource[], via: Record<string, string>, covers: Record<string, string>,
): SheetSource[] {
  const byUrl = new Map<string, { s: ExchangeSource; covers: string[] }>();
  for (const s of sources) {
    const seen = byUrl.get(s.url);
    if (seen) seen.covers.push(...s.covers.filter((c) => !seen.covers.includes(c)));
    else byUrl.set(s.url, { s, covers: [...s.covers] });
  }
  return [...byUrl.values()].map(({ s, covers: c }) => ({
    href: s.url,
    linkText: via[s.via] ?? s.via,
    label: `${s.published_at.slice(0, 10)} · ${c.map((x) => covers[x] ?? x).join(", ")}`,
  }));
}
