import { useState, useLayoutEffect, type ReactNode } from "react";
import { LIGHT, DARK, applyThemeVars } from "@/theme";
import { ThemeContext, type ThemeMode } from "@/hooks/useTheme";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(() => {
    try {
      return (localStorage.getItem("theme") as ThemeMode) ?? "light";
    } catch {
      return "light";
    }
  });
  const theme = mode === "light" ? LIGHT : DARK;
  const toggle = () => {
    setMode((prev) => {
      const next = prev === "light" ? "dark" : "light";
      try { localStorage.setItem("theme", next); } catch { /* ignore */ }
      return next;
    });
  };
  // Publish the active theme as CSS variables on <html>, which is what
  // src/styles/theme.css reads. Layout effect (not useEffect) so the variables
  // exist before the first paint — otherwise every var() falls back to nothing
  // and the app flashes unstyled. `data-theme` is for debugging / any future
  // rule that needs to branch on the mode.
  useLayoutEffect(() => {
    const root = document.documentElement;
    applyThemeVars(root, theme);
    root.dataset.theme = mode;
  }, [theme, mode]);
  return (
    <ThemeContext.Provider value={{ mode, theme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}
