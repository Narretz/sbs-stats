import { useRoute } from "@/hooks/RouteContext";
import { monthDailyWindow } from "@/utils/dayRange";
import { resolvedEndDate } from "@/utils/padTrailing";

export interface SheetLink {
  href: string;
  label: string;
  title: string;
  /** In-app navigation, for a plain click; the href serves the rest (a new
   *  tab, a copied link). */
  follow: () => void;
}

// A month's day-by-day breakdown: the same site's daily page, windowed to
// that month. Only on a monthly page whose site has a daily one — elsewhere
// (the home page, a daily page, a monthly-only source) this yields null, so a
// chart can ask unconditionally.
export function useMonthDailyLink(): ((month: string, anchor?: string) => SheetLink | null) | null {
  const { route, goSearch, pagesFor } = useRoute();
  if (route.kind !== "site" || route.page !== "monthly" || !pagesFor(route.site).includes("daily")) {
    return null;
  }
  return (month, anchor) => {
    const win = monthDailyWindow(month, resolvedEndDate(""));
    if (!win) return null;
    // Built from the live URL at each use rather than captured: the monthly
    // page's own params move by replaceState, which doesn't re-render us.
    const build = () => {
      const p = new URLSearchParams(window.location.search);
      p.set("page", "daily");
      p.set("days", String(win.days));
      if (win.date) p.set("date", win.date);
      else p.delete("date");
      return p;
    };
    const hash = anchor ? `#${anchor}` : "";
    return {
      href: `?${build().toString()}${hash}`,
      label: "By day →",
      title: `${month.slice(0, 7)} on the daily view`,
      follow: () => goSearch(build(), hash),
    };
  };
}
