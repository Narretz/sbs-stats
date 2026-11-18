// Runs `fn` once the browser has painted what the page shows now. sql.js runs
// on the main thread, so a slow synchronous query freezes the page while it
// runs: started straight from an effect, it lands before the next paint, and
// the loading message the page has just put up is never drawn — the screen
// keeps whatever was there before. A frame, then a task: the task queued from
// inside the frame's callback runs after that frame is painted. Returns a
// cancel, for an effect's cleanup.
export function afterPaint(fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const frame = requestAnimationFrame(() => { timer = setTimeout(fn, 0); });
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}
