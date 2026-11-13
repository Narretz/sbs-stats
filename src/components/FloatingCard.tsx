import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

// The hover card, placed by measuring it: beside the cursor where it fits,
// on the other side where it doesn't, and pushed back inside the viewport
// when neither side has room. Sized to its content (max-content): a fixed box
// placed at `left: x` is otherwise only as wide as the space between x and the
// viewport's edge, so hovering towards the right squeezed the card — and the
// label column of its table (minmax(0, 1fr)) went first, down to nothing.
const CARD_GAP = 14;
const CARD_MARGIN = 8;

export function FloatingCard({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // On every move and every new content — the card's size follows what it
  // shows. Converges in one pass (the size doesn't depend on the position),
  // and the state update is skipped when nothing moved.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const place = (at: number, size: number, view: number) => {
      let p = at + CARD_GAP;
      if (p + size > view - CARD_MARGIN) p = at - CARD_GAP - size;
      if (p < CARD_MARGIN) p = Math.max(CARD_MARGIN, view - CARD_MARGIN - size);
      return Math.round(p);
    };
    const next = { left: place(x, w, vw), top: place(y, h, vh) };
    setPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
  }, [x, y, children]);
  return (
    <div ref={ref} data-floating-card="" style={{
      position: "fixed", zIndex: 9999, pointerEvents: "none",
      width: "max-content", maxWidth: `calc(100vw - ${2 * CARD_MARGIN}px)`,
      left: pos?.left ?? 0, top: pos?.top ?? 0,
      // Measured before it is shown, so it never paints in the wrong place.
      visibility: pos ? "visible" : "hidden",
    }}>
      {children}
    </div>
  );
}
