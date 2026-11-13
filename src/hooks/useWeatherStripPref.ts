import { useCallback, useState } from "react";

// Whether the front-line weather strip is shown above the charts — a reader's
// display preference across the hourly and daily pages, like the MAX/MED base,
// kept in localStorage. Off by default: the strip costs a ~4 MB download, and
// a page that doesn't show it must not fetch it, so the pages mount the strip
// (and with it its DB hook) only while this is on.
const KEY = "weatherStrip";

function read(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

export function useWeatherStripPref(): [boolean, (on: boolean) => void] {
  const [on, setOnState] = useState(read);
  const setOn = useCallback((next: boolean) => {
    setOnState(next);
    try { localStorage.setItem(KEY, next ? "1" : "0"); } catch { /* not kept */ }
  }, []);
  return [on, setOn];
}
