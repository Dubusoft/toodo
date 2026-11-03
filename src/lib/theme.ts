import { useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "system";

export const themePreferences: ThemePreference[] = ["light", "dark", "system"];

const storageKey = "toodo-theme";
const darkQuery = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();

function isThemePreference(value: string | null): value is ThemePreference {
  return themePreferences.includes(value as ThemePreference);
}

export function getThemePreference(): ThemePreference {
  const stored = localStorage.getItem(storageKey);
  return isThemePreference(stored) ? stored : "system";
}

function applyTheme() {
  const preference = getThemePreference();
  const dark =
    preference === "dark" || (preference === "system" && window.matchMedia(darkQuery).matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function setThemePreference(preference: ThemePreference) {
  localStorage.setItem(storageKey, preference);
  applyTheme();
  listeners.forEach((listener) => listener());
}

/** Applies the stored theme and keeps "system" in sync with the OS setting. */
export function initTheme() {
  applyTheme();
  window.matchMedia(darkQuery).addEventListener("change", applyTheme);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, getThemePreference);
}
