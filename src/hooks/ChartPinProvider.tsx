import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  useSyncExternalStore,
  type MutableRefObject, type ReactNode, type RefObject,
} from "react";
import { useRoute } from "@/hooks/RouteContext";

// A "pin" is one chart's selected x-position, hoisted above the pages so the
// bottom sheet can live outside whichever chart opened it. There is at most one
// in the whole app: pinning chart B releases chart A.
//
// The pin stores the x *value*, never an index. Chart data is replaced out from
// under a pin routinely — the refresh timer bumps `refreshCount`, the controls
// bar changes `days`/`selectedDate` — and an index would then silently point at
// a different date while the sheet's header still claimed the old one. Keyed by
// value, a pin either follows its date to a new position or (when the date
// falls out of the window) is dropped by `useChartPin`.
export interface ChartPin {
  chartId: string;
  x: string | number;
}

// The pin lives in a subscribable store rather than in provider state, and the
// context value never changes identity. Both halves of that matter on a page
// like SBS hourly, which mounts ~100 charts (7 base + 46 target classes x
// hit/destroyed), each holding one <Line> per day in the window: as context
// state, a pin re-rendered EVERY chart — ~10,000 recharts nodes at a 100-day
// window — so opening or closing the sheet took seconds while the hover
// tooltip, which only ever re-renders its own chart, stayed instant.
//
// With a store, `useChartPin` subscribes to a primitive (this chart's pinned x,
// or null), so a pin re-renders the chart losing it and the chart gaining it,
// and nothing else.
interface PinStore {
  get: () => ChartPin | null;
  set: (p: ChartPin | null) => void;
  subscribe: (onChange: () => void) => () => void;
}

function createPinStore(): PinStore {
  let pin: ChartPin | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => pin,
    set: (next) => {
      // Re-selecting the same point is a no-op, not a re-render. recharts
      // resolves a click to the nearest x-band, so a second click inside the
      // same band arrives as an identical pin.
      if (pin === next) return;
      if (pin && next && pin.chartId === next.chartId && pin.x === next.x) return;
      pin = next;
      for (const l of [...listeners]) l();
    },
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => { listeners.delete(onChange); };
    },
  };
}

interface ChartPinContextValue {
  store: PinStore;
  setHost: (el: HTMLDivElement | null) => void;
  /** The fixed sheet element — read for its height when deciding whether the
   *  pinned card needs scrolling clear of it. */
  sheetRef: RefObject<HTMLDivElement>;
  /** Set by the pinned chart so the sheet's keyboard handler can step without
   *  knowing anything about that chart's data. */
  stepRef: MutableRefObject<((delta: number) => void) | null>;
}

const ChartPinContext = createContext<ChartPinContextValue | null>(null);

// Portal target inside the sheet; the pinned chart renders its own header and
// body into it (see ChartSheetContent), so the sheet never has to hold a
// registry of charts or a stale copy of their data.
//
// Its own context because it is the one value here that changes: kept in the
// main one, the sheet mounting would re-render every chart on the page for a
// value only ChartSheetContent reads.
const SheetHostContext = createContext<HTMLDivElement | null>(null);

export function ChartPinProvider({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const stepRef = useRef<((delta: number) => void) | null>(null);
  const { route } = useRoute();

  const value = useMemo<ChartPinContextValue>(
    () => ({ store: createPinStore(), setHost, sheetRef, stepRef }),
    [],
  );

  // Navigating unmounts the pinned chart but not the sheet, which would leave
  // it rendering a selection for a chart that no longer exists. Re-resolving a
  // pin across pages isn't meaningful, so drop it.
  const routeKey = route.kind === "site"
    ? `site:${route.site}:${route.page}`
    : route.kind === "special" ? `special:${route.view}` : "home";
  useEffect(() => { value.store.set(null); }, [routeKey, value]);

  return (
    <ChartPinContext.Provider value={value}>
      <SheetHostContext.Provider value={host}>{children}</SheetHostContext.Provider>
    </ChartPinContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- hooks + provider colocated, matching RouteContext
export function useChartPinContext(): ChartPinContextValue {
  const v = useContext(ChartPinContext);
  if (!v) throw new Error("useChartPinContext must be used inside <ChartPinProvider>");
  return v;
}

/** The sheet's portal target. Only ChartSheetContent needs it. */
// eslint-disable-next-line react-refresh/only-export-components -- hooks + provider colocated, matching RouteContext
export function useSheetHost(): HTMLDivElement | null {
  return useContext(SheetHostContext);
}

/** True while some chart is pinned. For the sheet itself, which is the only
 *  consumer that cares about the pin without owning it. */
// eslint-disable-next-line react-refresh/only-export-components -- hooks + provider colocated, matching RouteContext
export function useSheetOpen(): boolean {
  const { store } = useChartPinContext();
  const snapshot = useCallback(() => store.get() !== null, [store]);
  return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}

// Scroll just enough to lift the pinned card clear of the sheet, and no more.
// Always-scrolling on open lurches the page for a chart that was already fully
// visible; this only fires when the sheet actually covers it.
//
// The sheet animates in with a transform, so its rect is still off-screen on
// the frame it opens — derive its final top from `offsetHeight`, which
// transforms don't affect. The downward scroll is also capped so the card's
// title can't be pushed under the sticky site header.
const HEADER_CLEARANCE = 64;
const CARD_GAP = 12;

function scrollCardClear(card: HTMLElement | null, sheet: HTMLElement | null) {
  if (!card || !sheet) return;
  const rect = card.getBoundingClientRect();
  const sheetTop = window.innerHeight - sheet.offsetHeight;
  const overlap = rect.bottom + CARD_GAP - sheetTop;
  if (overlap <= 0) return;
  const headroom = Math.max(0, rect.top - HEADER_CLEARANCE);
  const delta = Math.min(overlap, headroom);
  if (delta > 4) window.scrollBy({ top: delta, behavior: "smooth" });
}

export interface ChartPinState {
  /** True when this chart owns the current pin. */
  isPinned: boolean;
  /** Index of the pinned x within `xValues`, or -1. */
  index: number;
  select: (x: string | number) => void;
  clear: () => void;
  step: (delta: number) => void;
  canPrev: boolean;
  canNext: boolean;
  /** Spread onto the chart card's root element: gives the hook something to
   *  measure for the scroll-clear, and marks the card as pin-owning so the
   *  sheet's outside-click handler doesn't treat a click on another chart as a
   *  dismissal (it's a re-selection). */
  cardProps: { ref: RefObject<HTMLDivElement>; "data-chart-pinnable": "" };
}

/**
 * Chart-side half of the pin. Give it a stable id (the chart's anchor slug) and
 * the ordered x-values it plots; get back everything needed to render the
 * pinned cursor and drive the sheet's stepper.
 */
// eslint-disable-next-line react-refresh/only-export-components -- hooks + provider colocated, matching RouteContext
export function useChartPin(
  chartId: string,
  xValues: ReadonlyArray<string | number>,
): ChartPinState {
  const { store, sheetRef } = useChartPinContext();
  const setPin = store.set;
  const cardRef = useRef<HTMLDivElement>(null);

  // A primitive, so a pin somewhere else on the page resolves to the same
  // `null` this chart already had and React skips the re-render entirely.
  const snapshot = useCallback(() => {
    const p = store.get();
    return p && p.chartId === chartId ? p.x : null;
  }, [store, chartId]);
  const pinnedX = useSyncExternalStore(store.subscribe, snapshot, snapshot);

  const isPinned = pinnedX != null;
  const index = isPinned ? xValues.indexOf(pinnedX) : -1;

  // The pinned date fell out of the loaded window (a narrower `days`, a
  // different `selectedDate`). Nothing to point at, so close.
  useEffect(() => {
    if (isPinned && index === -1) setPin(null);
  }, [isPinned, index, setPin]);

  // Only on the transition into pinned — not on every step, which would fight
  // the reader's own scrolling.
  const wasPinned = useRef(false);
  useEffect(() => {
    if (isPinned && index >= 0 && !wasPinned.current) {
      const id = requestAnimationFrame(() => scrollCardClear(cardRef.current, sheetRef.current));
      wasPinned.current = true;
      return () => cancelAnimationFrame(id);
    }
    if (!isPinned) wasPinned.current = false;
  }, [isPinned, index, sheetRef]);

  const select = useCallback((x: string | number) => setPin({ chartId, x }), [chartId, setPin]);
  const clear = useCallback(() => setPin(null), [setPin]);
  const step = useCallback((delta: number) => {
    const next = index + delta;
    if (index < 0 || next < 0 || next >= xValues.length) return;
    setPin({ chartId, x: xValues[next] });
  }, [chartId, index, xValues, setPin]);

  return {
    isPinned: isPinned && index >= 0,
    index,
    select,
    clear,
    step,
    canPrev: index > 0,
    canNext: index >= 0 && index < xValues.length - 1,
    cardProps: { ref: cardRef, "data-chart-pinnable": "" },
  };
}
