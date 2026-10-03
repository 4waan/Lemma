import { useEffect, useState } from "react";

/**
 * The color theme: the system's until the viewer picks one with the header's
 * button, then that pick, kept in this browser. `data-theme` on <html> makes
 * styles.css use that theme's tokens whatever the system prefers.
 */
export type Theme = "light" | "dark";

const KEY = "lemma-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Each theme's page background (--bg in styles.css), for the browser's own chrome such as Safari's tab bar. */
export const THEME_COLOR: Readonly<Record<Theme, string>> = { light: "#f8faf9", dark: "#0b1113" };

/** The viewer's pick, or null when there is none or storage is blocked (a private window, cleared site data). */
export function storedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function saveTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    // Storage is blocked: the pick lasts until the page is closed.
  }
}

export function systemTheme(): Theme {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/** Shows a theme, or the system's with null, and tints the browser's chrome to match. */
export function applyTheme(theme: Theme | null): void {
  const root = document.documentElement;
  if (theme === null) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = THEME_COLOR[theme ?? (meta.media.includes("dark") ? "dark" : "light")];
  }
}

/** The theme on screen, following the system until the viewer picks one, and the switch to the other theme. */
export function useTheme(): readonly [Theme, () => void] {
  const [picked, setPicked] = useState<Theme | null>(() => (typeof window === "undefined" ? null : storedTheme()));
  const [system, setSystem] = useState<Theme>(() => (typeof window === "undefined" ? "light" : systemTheme()));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(DARK_QUERY);
    const follow = () => setSystem(query.matches ? "dark" : "light");
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);
  const theme = picked ?? system;
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    saveTheme(next);
    setPicked(next);
  };
  return [theme, toggle];
}
