// UA+RU BODY EXCHANGES: backed by the hand-curated
// scripts/body_exchanges/exchanges.json read DIRECTLY (no SQLite/R2 round-trip),
// like the HUR missiles view. Exchanges are irregular (~monthly) and announced
// by each side separately, so the file is edited by hand and bundled at build
// time. The arithmetic shared with the prisoner exchanges is in ./exchanges.
import rawData from "../../scripts/body_exchanges/exchanges.json";
import type { BodyExchange, BodyExchangeDataset } from "@/types";
import type { SheetSource } from "@/components/TooltipTable";
import { exchangeSheetSources } from "@/data/exchanges";

const data = rawData as unknown as BodyExchangeDataset;

export const BODY_EXCHANGES: readonly BodyExchange[] = data.exchanges;

const VIA_LABEL: Record<string, string> = { "Koord_shtab (Telegram)": "Koord. HQ" };
const COVERS_LABEL: Record<string, string> = { ua_received: "Ukraine", ru_received: "Russia", date: "date" };

export function bodyExchangeSources(e: BodyExchange): SheetSource[] {
  return exchangeSheetSources(e.sources, VIA_LABEL, COVERS_LABEL);
}
