import { useRoute } from "@/hooks/RouteContext";
import { dayHourlyDate, monthDailyWindow } from "@/utils/dayRange";
import { resolvedEndDate } from "@/utils/padTrailing";
import type { Page } from "@/types";

export interface SheetLink {
  href: string;
  label: string;
  title: string;
  /** In-app navigation, for a plain click; the href serves the rest (a new
   *  tab, a copied link). */
  follow: () => void;
}

// One point's breakdown on the same site's next finer view: a month (YYYY-MM)
// on the daily page, windowed to that month; a day (YYYY-MM-DD) on the hourly
// page, ending on that day — `days` is kept, so the day is highlighted against
// the same span of days around it that the daily page was showing.
//
// Only where the finer view exists: a monthly page whose site has a daily one,
// a daily page whose site has an hourly one. Elsewhere (the home page, a
// monthly-only source) this yields null, so a chart can ask unconditionally.
export function useDrillDownLink(): ((period: string, anchor?: string) => SheetLink | null) | null {
  const { route, goSearch, pagesFor } = useRoute();
  if (route.kind !== "site") return null;
  const target: Page | null =
    route.page === "monthly" ? "daily" : route.page === "daily" ? "hourly" : null;
  if (!target || !pagesFor(route.site).includes(target)) return null;

  return (period, anchor) => {
    const today = resolvedEndDate("");
    let params: { date: string; days?: number };
    if (target === "daily") {
      const win = monthDailyWindow(period, today);
      if (!win) return null;
      params = win;
    } else {
      const date = dayHourlyDate(period, today);
      if (date == null) return null;
      params = { date };
    }
    // Built from the live URL at each use rather than captured: a page's own
    // params move by replaceState, which doesn't re-render us.
    const build = () => {
      const p = new URLSearchParams(window.location.search);
      p.set("page", target);
      if (params.days != null) p.set("days", String(params.days));
      if (params.date) p.set("date", params.date);
      else p.delete("date");
      return p;
    };
    const hash = anchor ? `#${anchor}` : "";
    return {
      href: `?${build().toString()}${hash}`,
      label: target === "daily" ? "By day →" : "By hour →",
      title: `${period} on the ${target} view`,
      follow: () => goSearch(build(), hash),
    };
  };
}
