import { Monitor, Moon, Sun } from "lucide-react";
import { ToggleButton, ToggleButtonGroup } from "@astryxdesign/core/ToggleButton";
import { useMessages } from "@/lib/i18n";
import { setThemePreference, useThemePreference, type ThemePreference } from "@/lib/theme";

const options: { value: ThemePreference; Icon: typeof Sun }[] = [
  { value: "light", Icon: Sun },
  { value: "dark", Icon: Moon },
  { value: "system", Icon: Monitor },
];

export function ThemeToggle() {
  const m = useMessages();
  const preference = useThemePreference();
  return (
    <ToggleButtonGroup
      label={m.settings.theme}
      type="single"
      size="sm"
      value={preference}
      // Pressing the chosen theme again keeps it: one theme is always chosen.
      onChange={(value) => typeof value === "string" && setThemePreference(value as ThemePreference)}
    >
      {options.map(({ value, Icon }) => (
        <ToggleButton
          key={value}
          value={value}
          label={m.settings.themes[value]}
          icon={<Icon />}
          isIconOnly
          // A phone gets buttons big enough to tap.
          className="max-md:min-h-11 max-md:min-w-11"
        />
      ))}
    </ToggleButtonGroup>
  );
}
