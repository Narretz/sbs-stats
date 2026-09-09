import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "@/styles/theme.css";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found in index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// PT Sans / PT Mono, attached only once the document has finished loading.
// A <link> in index.html or an @import at the top of theme.css both make first
// paint AND the document's `load` event wait on a third-party CDN — so a slow
// or blocked fonts.googleapis.com stalls the whole page (and every e2e
// `page.goto`, which waits for `load`). FONTS in src/theme.ts declares system
// fallbacks, so the webfont is free to arrive a beat late.
function attachWebfont() {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=PT+Sans:wght@400;700&family=PT+Mono&display=swap";
  document.head.appendChild(link);
}
if (document.readyState === "complete") attachWebfont();
else window.addEventListener("load", attachWebfont, { once: true });
