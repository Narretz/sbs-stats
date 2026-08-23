import { type ReactNode } from "react";
import { useTheme } from "@/hooks/useTheme";
import { ChartGrid, LoadingScreen, ErrorScreen } from "@/components/Layout";
import { FONTS } from "@/theme";
import type { LoadState } from "@/types";

interface PageScaffoldProps {
  // Header
  title: string;
  description: ReactNode;         // rendered inside the <p> (may contain <a> links)
  descriptionStyle?: React.CSSProperties; // merged onto the description <p> (e.g. a max-width)
  dataWindow?: ReactNode;         // usually a <DataWindow …/>; shapes vary per page
  headerExtra?: ReactNode;        // rare extra header content (e.g. SBU Alfa leaderboard)
  // Daily/hourly pages stack the header as a plain block; monthly pages use a
  // flex column with an 8px gap. Preserves each page's existing spacing.
  headerVariant?: "block" | "stack";

  // Sticky controls row. Omitted → the row isn't rendered at all (e.g. Mediazona).
  controls?: ReactNode;

  // Load gating — identical across every dataset page.
  loadState: LoadState;
  error: string | null;
  hasData: boolean;
  loadingMessage?: string;        // omitted → LoadingScreen's default copy

  // Ready content. When it's a plain chart list, pass `gridChildren` to have the
  // scaffold wrap it in a <ChartGrid>; pass `children` for full control (e.g.
  // pages with several grids or bespoke layout).
  gridChildren?: ReactNode;
  children?: ReactNode;
}

const HEADER_STACK: React.CSSProperties = { display: "flex", gap: 8, flexDirection: "column", marginBottom: 16 };
const HEADER_BLOCK: React.CSSProperties = { marginBottom: 16 };
const CONTROLS_ROW: React.CSSProperties = { display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 20 };

// Shared chrome for a dataset page: header (title + description + data-window),
// the sticky controls row, and the loading / error / ready gate. Pages supply
// their own controls and charts; everything repeated verbatim across pages lives
// here. See the per-dataset pages for usage.
export function PageScaffold({
  title, description, descriptionStyle, dataWindow, headerExtra, headerVariant = "stack",
  controls, loadState, error, hasData, loadingMessage,
  gridChildren, children,
}: PageScaffoldProps) {
  const { theme: t } = useTheme();
  // Show charts only once rows are actually present (`hasData`), not merely when
  // the DB finished loading. Pages whose row fetch is async (e.g. GSUA reads
  // over a worker) have a window where loadState === "ready" but no rows have
  // arrived — gating on loadState there rendered an empty, padded grid (a stray
  // grey bar on hover). Keep the loading indicator up through that gap.
  const ready = hasData;
  const loading = !hasData && loadState !== "error";
  return (
    <div>
      <div style={headerVariant === "block" ? HEADER_BLOCK : HEADER_STACK}>
        <h1 style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 24, color: t.text }}>
          {title}
        </h1>
        <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3, ...descriptionStyle }}>
          {description}
        </p>
        {dataWindow}
        {headerExtra}
      </div>

      {controls !== undefined && (
        <div className="page-controls-sticky" style={CONTROLS_ROW}>
          {controls}
        </div>
      )}

      {loading && <LoadingScreen message={loadingMessage} />}
      {loadState === "error" && <ErrorScreen message={error ?? "Unknown error"} />}
      {ready && gridChildren !== undefined && <ChartGrid>{gridChildren}</ChartGrid>}
      {ready && children}
    </div>
  );
}
