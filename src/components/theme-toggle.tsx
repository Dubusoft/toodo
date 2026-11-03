import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setThemePreference, useThemePreference, type ThemePreference } from "@/lib/theme";

const options: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light theme", Icon: Sun },
  { value: "dark", label: "Dark theme", Icon: Moon },
  { value: "system", label: "System theme", Icon: Monitor },
];

export function ThemeToggle() {
  const preference = useThemePreference();
  return (
    <div role="group" aria-label="Theme" className="flex gap-0.5 rounded-lg border p-0.5">
      {options.map(({ value, label, Icon }) => (
        <Button
          key={value}
          variant={preference === value ? "default" : "ghost"}
          size="icon-sm"
          aria-label={label}
          aria-pressed={preference === value}
          title={label}
          onClick={() => setThemePreference(value)}
        >
          <Icon />
        </Button>
      ))}
    </div>
  );
}
