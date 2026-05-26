import { useState } from "react";
import type { Page, Site } from "@/types";

const SBS_PAGES: Page[] = ["hourly", "daily", "monthly"];
const GSUA_PAGES: Page[] = ["hourly", "daily", "monthly"];
// russian-casualties.in.ua is daily-only (no hourly snapshots, no directions).
const RU_LOSSES_PAGES: Page[] = ["daily", "monthly"];
// RU MoD air-defense: daily + monthly (no hourly — the MoD posts ~2–3×/day).
const RU_AD_PAGES: Page[] = ["daily", "monthly"];

function pagesFor(site: Site): Page[] {
  if (site === "ru-attacks-gsua") return GSUA_PAGES;
  if (site === "ru-losses-gsua") return RU_LOSSES_PAGES;
  if (site === "ru-airdef-mod") return RU_AD_PAGES;
  return SBS_PAGES;
}

function readUrl(): { site: Site; page: Page } {
  const p = new URLSearchParams(window.location.search);
  const rawSite = p.get("site");
  const site: Site =
    rawSite === "ru-attacks-gsua" ? "ru-attacks-gsua"
      : rawSite === "ru-losses-gsua" ? "ru-losses-gsua"
      : rawSite === "ru-airdef-mod" ? "ru-airdef-mod"
      : "sbs";
  const rawPage = p.get("page");
  const pages = pagesFor(site);
  const page: Page = pages.includes(rawPage as Page) ? (rawPage as Page) : pages[0];
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
    const safePage: Page = pages.includes(page) ? page : pages[0];
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
