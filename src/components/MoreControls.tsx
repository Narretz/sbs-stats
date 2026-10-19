import { useState, type ReactNode } from "react";

const PARAM = "more";

function readOpen(): boolean {
  return new URLSearchParams(window.location.search).get(PARAM) === "1";
}

// Writes `more=1` while open and drops the param while closed, so the default
// (collapsed) view keeps a clean URL. Keeps the hash: a chart anchor shared
// alongside the open controls should survive the click.
function writeOpen(open: boolean) {
  const p = new URLSearchParams(window.location.search);
  if (open) p.set(PARAM, "1");
  else p.delete(PARAM);
  window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}${window.location.hash}`);
}

// "Show more / Show less" for a page's secondary chart controls — the window's
// start date, the weekday filter, the MAX/MED scope, the tooltip sort. Renders
// a fragment (button, then the children when open) so the children stay items
// of the page's controls row and wrap with it like any other control. Open or
// closed is in the URL, so a link to a page with a filter applied can carry
// the controls that show it.
export function MoreControls({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(readOpen);
  const toggle = () => {
    setOpen(!open);
    writeOpen(!open);
  };
  return (
    <>
      <button className="ctl" data-testid="more-controls" aria-expanded={open} onClick={toggle}>
        {open ? "Show less" : "Show more"}
      </button>
      {open && children}
    </>
  );
}
