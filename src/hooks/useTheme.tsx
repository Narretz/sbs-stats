import { createContext, useContext } from "react";
import type { Theme } from "@/theme";
import { LIGHT } from "@/theme";

export type ThemeMode = "light" | "dark";
export interface ThemeContextValue {
  mode: ThemeMode;
  theme: Theme;
  toggle: () => void;
}

// Context + consumer hook only (no component export) so this stays
// Fast-Refresh-clean; the provider lives in ThemeProvider.tsx.
export const ThemeContext = createContext<ThemeContextValue>({
  mode: "light",
  theme: LIGHT,
  toggle: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}
