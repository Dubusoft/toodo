import { Monitor, Moon, Sun } from "lucide-react";
import { ToggleButton, ToggleButtonGroup } from "@astryxdesign/core/ToggleButton";
import { setThemePreference, useThemePreference, type ThemePreference } from "@/lib/theme";

const options: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light theme", Icon: Sun },
  { value: "dark", label: "Dark theme", Icon: Moon },
  { value: "system", label: "System theme", Icon: Monitor },
];

export function ThemeToggle() {
  const preference = useThemePreference();
  return (
    <ToggleButtonGroup
      label="Theme"
      type="single"
      size="sm"
      value={preference}
      // Pressing the chosen theme again keeps it: one theme is always chosen.
      onChange={(value) => typeof value === "string" && setThemePreference(value as ThemePreference)}
    >
      {options.map(({ value, label, Icon }) => (
        <ToggleButton key={value} value={value} label={label} icon={<Icon />} isIconOnly />
      ))}
    </ToggleButtonGroup>
  );
}
