import { resolveThemeTokens } from "@astryxdesign/core/theme/tokens";
import { useSyncExternalStore } from "react";
import { toodoTheme } from "@/lib/astryx-theme";

export type ThemePreference = "light" | "dark" | "system";

export const themePreferences: ThemePreference[] = ["light", "dark", "system"];

const storageKey = "toodo-theme";
const darkQuery = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();

/**
 * The page background (`--background` in `src/index.css`, the Astryx body color) of each mode,
 * for the browser's status bar. `index.html` starts with one `theme-color` per OS color scheme; an
 * explicit choice must win over the OS setting, so both get the color of the applied theme.
 */
const themeColors = {
  light: resolveThemeTokens(toodoTheme, { mode: "light" })["--color-background-body"],
  dark: resolveThemeTokens(toodoTheme, { mode: "dark" })["--color-background-body"],
};

function isThemePreference(value: string | null): value is ThemePreference {
  return themePreferences.includes(value as ThemePreference);
}

export function getThemePreference(): ThemePreference {
  const stored = localStorage.getItem(storageKey);
  return isThemePreference(stored) ? stored : "system";
}

/** The mode the stored preference shows now: "system" follows the OS setting. */
function getColorMode(): "light" | "dark" {
  const preference = getThemePreference();
  const dark =
    preference === "dark" || (preference === "system" && window.matchMedia(darkQuery).matches);
  return dark ? "dark" : "light";
}

function applyTheme() {
  const dark = getColorMode() === "dark";
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute("content", dark ? themeColors.dark : themeColors.light);
  }
}

export function setThemePreference(preference: ThemePreference) {
  localStorage.setItem(storageKey, preference);
  applyTheme();
  listeners.forEach((listener) => listener());
}

/** Applies the stored theme and keeps "system" in sync with the OS setting. */
export function initTheme() {
  applyTheme();
  window.matchMedia(darkQuery).addEventListener("change", () => {
    applyTheme();
    listeners.forEach((listener) => listener());
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, getThemePreference);
}

/** The applied mode, the one the `.dark` class shows, for the Astryx `Theme`. */
export function useColorMode(): "light" | "dark" {
  return useSyncExternalStore(subscribe, getColorMode);
}
