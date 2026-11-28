import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Selector } from "@astryxdesign/core/Selector";
import { useDoriConnected } from "@/components/dori-config-panel";
import { commands, type AppLanguage } from "@/lib/bindings";
import { appLanguageKey, useAppLanguage, useMessages } from "@/lib/i18n";

const UNSET = "";

/**
 * The App language setting of the General section: the language of the app's screens on every
 * device, kept on the server. Unset, the screens follow Dori's language.
 */
export function AppLanguageSettingField() {
  const m = useMessages();
  const queryClient = useQueryClient();
  const app = useAppLanguage();
  const doriConnected = useDoriConnected();
  const save = useMutation({
    mutationFn: (language: AppLanguage | null) => commands.setAppLanguage(language),
    onSuccess: (saved) => queryClient.setQueryData(appLanguageKey, saved),
  });
  if (app.data === undefined) return null;
  const options = [
    { value: UNSET, label: doriConnected ? m.settings.appLanguageFollowsDori : m.settings.appLanguageUnset },
    { value: "en", label: m.settings.languageNames.English },
    { value: "ko", label: m.settings.languageNames.Korean },
  ];
  return (
    <div className="flex flex-col gap-1">
      <Selector
        label={m.settings.appLanguage}
        description={m.settings.appLanguageDescription}
        options={options}
        value={app.data ?? UNSET}
        isDisabled={save.isPending}
        onChange={(value) => save.mutate(value === "en" || value === "ko" ? value : null)}
      />
      {save.error && <p role="alert" className="break-words text-destructive">{save.error.message}</p>}
    </div>
  );
}
