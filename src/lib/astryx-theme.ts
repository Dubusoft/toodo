import { defineTheme } from "@astryxdesign/core/theme";

/**
 * The app's Astryx theme: Astryx defaults, with the brand emerald (the color of
 * `src/web/pwa/icon.svg`, #059669) as the accent only. Surfaces, text, and borders stay the
 * Astryx neutrals. The values are the ones Astryx derives from the #059669 seed for each mode
 * (`defineTheme({ color: { accent } })`), which keep the contrast of text on and next to the
 * accent; the seed itself is not used because it also tints the neutrals.
 */
const accent: [light: string, dark: string] = ["#006E46", "#63DCA9"];

export const toodoTheme = defineTheme({
  name: "toodo",
  tokens: {
    "--color-accent": accent,
    "--color-text-accent": accent,
    "--color-icon-accent": accent,
    "--focus-outline-color": accent,
    "--color-accent-muted": ["rgba(0, 110, 70, 0.2)", "rgba(99, 220, 169, 0.25)"],
    "--color-on-accent": ["#FFFFFF", "#003D1A"],
  },
});
