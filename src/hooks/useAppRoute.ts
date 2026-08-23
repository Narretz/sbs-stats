import { useEffect, useState } from "react";
import type { Page, Site } from "@/types";
import { SITES } from "@/types";
import { SITE_REGISTRY } from "@/sites/registry";

// HUR missile-stock disclosures: a JSON-backed prototype with its own
// Production/Stockpile toggle, so no daily/monthly nav (App hides the page
// buttons for this site). Not in SITE_REGISTRY — handled explicitly here and
// in App.tsx.
const RU_MISSILES_PAGES: Page[] = ["daily"];

// A site's page list (in nav order) is its registry entry's `pages` keys; the
// non-registry missiles prototype is the one special case.
function pagesFor(site: Site): Page[] {
  if (site === "ru-missiles-hur") return RU_MISSILES_PAGES;
  const entry = SITE_REGISTRY[site];
  return entry ? (Object.keys(entry.pages) as Page[]) : ["daily"];
}

// Registry of unlisted `?view=…` pages. These are reachable by URL only
// (not surfaced in the site picker or homepage) and typically render a
// standalone comparison across multiple datasets.
export const SPECIAL_VIEWS = ["sbs-vs-sbu-alfa"] as const;
export type SpecialView = (typeof SPECIAL_VIEWS)[number];

export type Route =
  | { kind: "home" }
  | { kind: "site"; site: Site; page: Page }
  | { kind: "special"; view: SpecialView };

function readUrl(): Route {
  const p = new URLSearchParams(window.location.search);
  const rawView = p.get("view");
  if (rawView && (SPECIAL_VIEWS as readonly string[]).includes(rawView)) {
    return { kind: "special", view: rawView as SpecialView };
  }
  const rawSite = p.get("site");
  if (rawSite === null) return { kind: "home" };
  const site: Site = (SITES as string[]).includes(rawSite) ? (rawSite as Site) : "sbs";
  const rawPage = p.get("page");
  const pages = pagesFor(site);
  const page: Page = pages.includes(rawPage as Page) ? (rawPage as Page) : pages[0];
  return { kind: "site", site, page };
}

// Switching site/page is a navigation, so push a new history entry (Back should
// return to the previous view). The homepage's own filter params (charts, days,
// …) still use replaceState from HomePage — those are tweaks, not navigations.
function writeSite(next: { site?: Site; page?: Page }) {
  const p = new URLSearchParams(window.location.search);
  if (next.site !== undefined) p.set("site", next.site);
  if (next.page !== undefined) p.set("page", next.page);
  window.history.pushState(null, "", `${window.location.pathname}?${p.toString()}`);
}

// Clear site/page params; homepage owns its own params (metrics, days, …)
// and we don't want stale site/page hanging around when we navigate home.
function writeHome() {
  const p = new URLSearchParams(window.location.search);
  p.delete("site");
  p.delete("page");
  const qs = p.toString();
  window.history.pushState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
}

export function useAppRoute() {
  const [route, setRouteState] = useState<Route>(readUrl);

  // Back/forward changes the URL but not React state — re-read the URL on
  // popstate so the view follows the history entries writeSite/writeHome push.
  useEffect(() => {
    const onPop = () => setRouteState(readUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

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
