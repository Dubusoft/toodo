import { defineTheme } from "@astryxdesign/core/theme";

/**
 * The app's Astryx theme: Astryx defaults, with the brand emerald (the color of
 * `src/web/pwa/icon.svg`, #059669) as the accent only. Surfaces, text, and borders stay the
 * Astryx neutrals. The values are the ones Astryx derives from the #059669 seed for each mode
 * (`defineTheme({ color: { accent } })`), which keep the contrast of text on and next to the
 * accent; the seed itself is not used because it also tints the neutrals.
 */
const accent: [light: string, dark: string] = ["#006E46", "#63DCA9"];

/**
 * The small controls of the app's dense rows and toolbars (`size="sm"`): 12px text on a 24px
 * row, as before Astryx. The Astryx default (14px on 28px) made every filter, row action, and
 * field in them larger. Medium controls keep the Astryx size.
 */
const compactControl = {
  "size:sm": {
    "--text-label-size": "var(--font-size-sm)",
    "--text-body-size": "var(--font-size-sm)",
    "--size-element-sm": "24px",
  },
};

export const toodoTheme = defineTheme({
  name: "toodo",
  // Geist, loaded in `src/index.css`; Hangul and other scripts it lacks fall back to the
  // platform's default sans-serif font (Apple SD Gothic Neo on Apple devices) rather than the
  // system UI font, whose Hangul has different shapes and metrics.
  typography: { body: { family: "Geist Variable", fallbacks: "sans-serif" } },
  tokens: {
    "--color-accent": accent,
    "--color-text-accent": accent,
    "--color-icon-accent": accent,
    "--focus-outline-color": accent,
    "--color-accent-muted": ["rgba(0, 110, 70, 0.2)", "rgba(99, 220, 169, 0.25)"],
    "--color-on-accent": ["#FFFFFF", "#003D1A"],
  },
  components: {
    button: compactControl,
    "text-input": compactControl,
    "text-area": compactControl,
    selector: compactControl,
    "date-input": compactControl,
    "number-input": compactControl,
    typeahead: compactControl,
    "segmented-control": compactControl,
  },
});
