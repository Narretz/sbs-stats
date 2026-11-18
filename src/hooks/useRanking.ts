import { createContext, useContext, useMemo } from "react";
import { rankBars, type Ranked, type Ranking } from "@/utils/barOrder";

// The page's ranking (utils/barOrder), handed to its charts by PageScaffold:
// null in date order, which is also what a chart outside a ranking page (the
// home page) reads. A chart that can rank switches to its ranked form on it;
// one that can't (a cumulative series, a dozen directions) ignores it.
//
// Context + hooks only (no component export), so this stays Fast-Refresh-clean.
export const RankingContext = createContext<Ranking | null>(null);

export function useRanking(): Ranking | null {
  return useContext(RankingContext);
}

/** `data` ranked by the page's ranking, or null in date order. */
export function useRankedBars<T extends { date: string }>(
  data: readonly T[], isLive: (row: T) => boolean, valueOf?: (row: T) => number | null | undefined,
): Ranked<T> | null {
  const ranking = useRanking();
  // isLive / valueOf are inline arrows at every call site; the ranking and
  // the rows are what change it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (ranking ? rankBars(data, ranking, isLive, valueOf) : null), [data, ranking?.order, ranking?.limit]);
}
