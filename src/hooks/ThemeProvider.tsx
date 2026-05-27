import { useState, useEffect, type ReactNode } from "react";
import { LIGHT, DARK } from "@/theme";
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
  // Keep body background in sync (avoids flash on first paint)
  useEffect(() => {
    document.body.style.background = theme.bg;
    document.body.style.color = theme.text;
  }, [theme]);
  return (
    <ThemeContext.Provider value={{ mode, theme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}
