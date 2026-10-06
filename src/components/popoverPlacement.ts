// Placement for a native popover opened from a trigger button. Popovers open
// in the top layer with no position of their own, so it is ours to set:
// under the trigger (left- or right-aligned to it), flipped above when there
// is more room there, height-capped to the space available, and clamped to
// the viewport.
//
// Call it on `beforetoggle`, not `toggle`. `toggle` fires after the popover
// has opened — and been painted: placing it there showed one frame of the
// popover wherever it falls by default (its place in the page flow, at full
// height) before it jumped under the trigger. `beforetoggle` runs before it is
// shown. The cost is that the popover cannot be measured yet, so `width` is
// what it is (or at most will be) wide; a popover sized to its content can
// re-clamp with its measured width afterwards via `clampLeft`.

interface Placement {
  width: number;       // the popover's width, or an upper bound on it
  prefHeight: number;  // how tall it would like to be
  minHeight: number;   // never squeezed below this, even if it overflows
  flipBelow: number;   // flip above when less than this fits below
  align: "left" | "right";
}

const MARGIN = 8;
const GAP = 4;

export function placePopover(pop: HTMLElement, trigger: HTMLElement, p: Placement): void {
  const rect = trigger.getBoundingClientRect();
  const left = p.align === "right" ? rect.right - p.width : rect.left;
  pop.style.left = `${Math.round(clampToViewport(left, p.width))}px`;

  const spaceBelow = window.innerHeight - rect.bottom - GAP - MARGIN;
  const spaceAbove = rect.top - GAP - MARGIN;
  const placeAbove = spaceBelow < p.flipBelow && spaceAbove > spaceBelow;
  const height = Math.max(p.minHeight, Math.min(p.prefHeight, placeAbove ? spaceAbove : spaceBelow));
  const top = placeAbove ? Math.max(MARGIN, rect.top - GAP - height) : rect.bottom + GAP;
  pop.style.top = `${Math.round(top)}px`;
  pop.style.maxHeight = `${Math.round(height)}px`;
}

// Re-clamp an open popover's left edge with its measured width — for one sized
// to its content, which `placePopover` could only bound.
export function clampLeft(pop: HTMLElement): void {
  const left = parseFloat(pop.style.left) || 0;
  const clamped = clampToViewport(left, pop.offsetWidth);
  if (clamped !== left) pop.style.left = `${Math.round(clamped)}px`;
}

function clampToViewport(left: number, width: number): number {
  return Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN));
}
