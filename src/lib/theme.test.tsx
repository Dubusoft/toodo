import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "@/components/theme-toggle";
import { getThemePreference, initTheme, setThemePreference } from "@/lib/theme";

let osDark = false;
let notifyOsChange: () => void = () => {};

function stubMatchMedia() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return osDark;
    },
    media: query,
    addEventListener: (_type: string, listener: () => void) => {
      notifyOsChange = listener;
    },
  }));
}

function isDark() {
  return document.documentElement.classList.contains("dark");
}

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    osDark = false;
    stubMatchMedia();
  });

  it("defaults to system and follows the OS setting", () => {
    initTheme();
    expect(getThemePreference()).toBe("system");
    expect(isDark()).toBe(false);

    osDark = true;
    notifyOsChange();
    expect(isDark()).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("persists an explicit choice and ignores the OS setting for it", () => {
    osDark = true;
    initTheme();
    setThemePreference("light");
    expect(localStorage.getItem("toodo-theme")).toBe("light");
    expect(isDark()).toBe(false);

    notifyOsChange();
    expect(isDark()).toBe(false);

    setThemePreference("dark");
    expect(isDark()).toBe(true);
  });

  it("falls back to system for an unknown stored value", () => {
    localStorage.setItem("toodo-theme", "sepia");
    expect(getThemePreference()).toBe("system");
  });

  it("switches the theme from the toggle buttons", () => {
    initTheme();
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "System theme" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Dark theme" }));
    expect(isDark()).toBe(true);
    expect(screen.getByRole("button", { name: "Dark theme" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "System theme" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
