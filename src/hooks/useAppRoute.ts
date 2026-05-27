import { useState } from "react";
import type { Page, Site } from "@/types";

const SBS_PAGES: Page[] = ["hourly", "daily", "monthly"];
const GSUA_PAGES: Page[] = ["hourly", "daily", "monthly"];
// GS national totals are daily-only (no hourly snapshots, no directions).
const RU_LOSSES_PAGES: Page[] = ["daily", "monthly"];
// RU MoD air-defense: daily + monthly (no hourly — the MoD posts ~2–3×/day).
const RU_AD_PAGES: Page[] = ["daily", "monthly"];
// piterfm missile attacks: daily + monthly (no intraday snapshots).
const RU_AIR_ATTACKS_PAGES: Page[] = ["daily", "monthly"];
// SBU Alfa: monthly recap only (the source publishes one per month, no daily cadence).
const SBU_ALFA_PAGES: Page[] = ["monthly"];
// Mediazona: a single weekly view (two charts on one page); reuses the "daily" slug.
const MEDIAZONA_PAGES: Page[] = ["daily"];

function pagesFor(site: Site): Page[] {
  if (site === "ru-attacks-gsua") return GSUA_PAGES;
  if (site === "ru-losses-gsua") return RU_LOSSES_PAGES;
  if (site === "ru-airdef-mod") return RU_AD_PAGES;
  if (site === "ru-air-attacks-gsua") return RU_AIR_ATTACKS_PAGES;
  if (site === "sbu-alfa") return SBU_ALFA_PAGES;
  if (site === "mediazona") return MEDIAZONA_PAGES;
  return SBS_PAGES;
}

export type Route =
  | { kind: "home" }
  | { kind: "site"; site: Site; page: Page };

function readUrl(): Route {
  const p = new URLSearchParams(window.location.search);
  const rawSite = p.get("site");
  if (rawSite === null) return { kind: "home" };
  const site: Site =
    rawSite === "ru-attacks-gsua" ? "ru-attacks-gsua"
      : rawSite === "ru-losses-gsua" ? "ru-losses-gsua"
      : rawSite === "ru-airdef-mod" ? "ru-airdef-mod"
      : rawSite === "ru-air-attacks-gsua" ? "ru-air-attacks-gsua"
      : rawSite === "sbu-alfa" ? "sbu-alfa"
      : rawSite === "mediazona" ? "mediazona"
      : "sbs";
  const rawPage = p.get("page");
  const pages = pagesFor(site);
  const page: Page = pages.includes(rawPage as Page) ? (rawPage as Page) : pages[0];
  return { kind: "site", site, page };
}

function writeSite(next: { site?: Site; page?: Page }) {
  const p = new URLSearchParams(window.location.search);
  if (next.site !== undefined) p.set("site", next.site);
  if (next.page !== undefined) p.set("page", next.page);
  window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
}

// Clear site/page params; homepage owns its own params (metrics, days, …)
// and we don't want stale site/page hanging around when we navigate home.
function writeHome() {
  const p = new URLSearchParams(window.location.search);
  p.delete("site");
  p.delete("page");
  const qs = p.toString();
  window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
}

export function useAppRoute() {
  const [route, setRouteState] = useState<Route>(readUrl);

  const goHome = () => {
    writeHome();
    setRouteState({ kind: "home" });
  };

  const goSite = (site: Site, page?: Page) => {
    const pages = pagesFor(site);
    const safePage: Page = page && pages.includes(page) ? page : pages[0];
    writeSite({ site, page: safePage });
    setRouteState({ kind: "site", site, page: safePage });
  };

  const setSite = (s: Site) => {
    if (route.kind !== "site") return goSite(s);
    const pages = pagesFor(s);
    const safePage: Page = pages.includes(route.page) ? route.page : pages[0];
    writeSite({ site: s, page: safePage });
    setRouteState({ kind: "site", site: s, page: safePage });
  };

  const setPage = (p: Page) => {
    if (route.kind !== "site") return;
    writeSite({ page: p });
    setRouteState({ kind: "site", site: route.site, page: p });
  };

  return { route, goHome, goSite, setSite, setPage, pagesFor };
}
