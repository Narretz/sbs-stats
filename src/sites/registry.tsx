import type { ComponentType, ReactNode } from "react";
import type { LoadState, Page, Site } from "@/types";
import {
  SbsDatabaseProvider, useSbsDatabaseContext,
  GsuaDatabaseProvider, useGsuaDatabaseContext,
  RuLossesDatabaseProvider, useRuLossesDatabaseContext,
  RuModDatabaseProvider, useRuModDatabaseContext,
  RuAirAttacksDatabaseProvider, useRuAirAttacksDatabaseContext,
  SbuAlfaDatabaseProvider, useSbuAlfaDatabaseContext,
  UaLossesDatabaseProvider, useUaLossesDatabaseContext,
  MediazonaDatabaseProvider, useMediazonaDatabaseContext,
} from "@/context/databases";
import { SbsDailyPage } from "@/pages/SbsDailyPage";
import { SbsHourlyPage } from "@/pages/SbsHourlyPage";
import { SbsMonthlyPage } from "@/pages/SbsMonthlyPage";
import { GsuaDailyPage } from "@/pages/GsuaDailyPage";
import { GsuaHourlyPage } from "@/pages/GsuaHourlyPage";
import { GsuaMonthlyPage } from "@/pages/GsuaMonthlyPage";
import { RuLossesDailyPage } from "@/pages/RuLossesDailyPage";
import { RuLossesMonthlyPage } from "@/pages/RuLossesMonthlyPage";
import { RuModDailyPage } from "@/pages/RuModDailyPage";
import { RuModMonthlyPage } from "@/pages/RuModMonthlyPage";
import { RuAirAttacksDailyPage } from "@/pages/RuAirAttacksDailyPage";
import { RuAirAttacksMonthlyPage } from "@/pages/RuAirAttacksMonthlyPage";
import { SbuAlfaMonthlyPage } from "@/pages/SbuAlfaMonthlyPage";
import { UaLossesMonthlyPage } from "@/pages/UaLossesMonthlyPage";
import { MediazonaWeeklyPage } from "@/pages/MediazonaWeeklyPage";
import { MediazonaMonthlyPage } from "@/pages/MediazonaMonthlyPage";

// Every dataset page takes the same prop.
type PageComponent = ComponentType<{ refreshKey: number }>;

// The refresh/load fields the app shell reads off any dataset hook (the full
// hook return carries these plus its own query functions, which the pages read
// via the consumer hook directly).
export interface DbContextShape {
  loadState: LoadState;
  error: string | null;
  refresh: () => void;
  lastRefreshed: Date | null;
  refreshCount: number;
  refreshIntervalMs: number;
}

export interface SiteConfig {
  // DB provider wrapping the site, and the consumer hook the shell reads for
  // the header's refresh indicator.
  provider: ComponentType<{ children: ReactNode }>;
  useDbContext: () => DbContextShape;
  // Pages in nav order — object-key order drives the header's page buttons.
  pages: Partial<Record<Page, PageComponent>>;
}

// The single place that wires a DB-backed site into the app: its provider, its
// consumer hook, and its pages. App.tsx renders any entry through one generic
// <SiteRoot>, and useAppRoute derives each site's page list from `pages`. Adding
// a site is one entry here (plus its hook, its page(s), and the Site union +
// SITE_LABELS in src/types). Sites NOT listed here (the JSON-backed
// `ru-missiles-hur` prototype) are handled as explicit special cases in App.tsx.
export const SITE_REGISTRY: Partial<Record<Site, SiteConfig>> = {
  sbs: {
    provider: SbsDatabaseProvider,
    useDbContext: useSbsDatabaseContext,
    pages: { hourly: SbsHourlyPage, daily: SbsDailyPage, monthly: SbsMonthlyPage },
  },
  "ru-attacks-gsua": {
    provider: GsuaDatabaseProvider,
    useDbContext: useGsuaDatabaseContext,
    pages: { hourly: GsuaHourlyPage, daily: GsuaDailyPage, monthly: GsuaMonthlyPage },
  },
  "ru-losses-gsua": {
    provider: RuLossesDatabaseProvider,
    useDbContext: useRuLossesDatabaseContext,
    pages: { daily: RuLossesDailyPage, monthly: RuLossesMonthlyPage },
  },
  "ru-airdef-mod": {
    provider: RuModDatabaseProvider,
    useDbContext: useRuModDatabaseContext,
    pages: { daily: RuModDailyPage, monthly: RuModMonthlyPage },
  },
  "ru-air-attacks-gsua": {
    provider: RuAirAttacksDatabaseProvider,
    useDbContext: useRuAirAttacksDatabaseContext,
    pages: { daily: RuAirAttacksDailyPage, monthly: RuAirAttacksMonthlyPage },
  },
  "sbu-alfa": {
    provider: SbuAlfaDatabaseProvider,
    useDbContext: useSbuAlfaDatabaseContext,
    pages: { monthly: SbuAlfaMonthlyPage },
  },
  "ua-losses": {
    provider: UaLossesDatabaseProvider,
    useDbContext: useUaLossesDatabaseContext,
    pages: { monthly: UaLossesMonthlyPage },
  },
  mediazona: {
    provider: MediazonaDatabaseProvider,
    useDbContext: useMediazonaDatabaseContext,
    pages: { weekly: MediazonaWeeklyPage, monthly: MediazonaMonthlyPage },
  },
};
