import { useState } from "react";
import type { Page, Site } from "@/types";

const SBS_PAGES: Page[] = ["hourly", "daily", "monthly"];
const GSUA_PAGES: Page[] = ["hourly", "daily"];

function pagesFor(site: Site): Page[] {
  return site === "gsua" ? GSUA_PAGES : SBS_PAGES;
}

function readUrl(): { site: Site; page: Page } {
  const p = new URLSearchParams(window.location.search);
  const rawSite = p.get("site");
  const site: Site = rawSite === "gsua" ? "gsua" : "sbs";
  const rawPage = p.get("page");
  const pages = pagesFor(site);
  const page: Page = pages.includes(rawPage as Page) ? (rawPage as Page) : "hourly";
  return { site, page };
}

function writeUrl(next: { site?: Site; page?: Page }) {
  const p = new URLSearchParams(window.location.search);
  if (next.site !== undefined) p.set("site", next.site);
  if (next.page !== undefined) p.set("page", next.page);
  window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
}

export function useAppRoute() {
  const initial = readUrl();
  const [site, setSiteState] = useState<Site>(initial.site);
  const [page, setPageState] = useState<Page>(initial.page);

  const setSite = (s: Site) => {
    const pages = pagesFor(s);
    const safePage: Page = pages.includes(page) ? page : "hourly";
    setSiteState(s);
    if (safePage !== page) setPageState(safePage);
    writeUrl({ site: s, page: safePage });
  };

  const setPage = (p: Page) => {
    setPageState(p);
    writeUrl({ page: p });
  };

  return { site, setSite, page, setPage, pagesFor };
}
