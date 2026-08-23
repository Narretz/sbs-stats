import { useEffect } from "react";

const APP_NAME = "RU-UA War Statistics";

// Sets the browser-tab title to a page-specific name while mounted. Pass the
// page's title (a suffix with the app name is appended); omit it for the app
// default. Every route sets a title, so navigation always refreshes the tab.
export function useDocumentTitle(title?: string) {
  useEffect(() => {
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
  }, [title]);
}
