import type { ComponentType } from "react";
import type { Site } from "@/types";
import { MissilesPage } from "@/pages/MissilesPage";
import { BodyExchangesPage } from "@/pages/BodyExchangesPage";

// Sites backed by a hand-curated JSON file bundled at build time rather than a
// DB: no provider, no load state, no refresh, and one page with no page nav.
// The DB-backed sites are in SITE_REGISTRY; App.tsx renders these through
// <JsonSiteRoot>.
export const JSON_SITE_PAGES: Partial<Record<Site, ComponentType>> = {
  "ru-missiles-hur": MissilesPage,
  "body-exchanges": BodyExchangesPage,
};
