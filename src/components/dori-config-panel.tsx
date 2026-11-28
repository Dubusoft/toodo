import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@astryxdesign/core/Badge";
import { Selector } from "@astryxdesign/core/Selector";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@/components/button";
import {
  DORI_LANGUAGE_KEY,
  DORI_TIME_ZONE_KEY,
  type DoriConfigEdit,
  type DoriConfigEntry,
  type DoriConfigSaved,
  type DoriConfigView,
} from "@/lib/dori-config";
import { doriConfigKey, fill, useMessages } from "@/lib/i18n";
import type { Messages } from "@/locales/en";
import { fetchDoriConfig, saveDoriConfig } from "@/web/dori-config";

/** The languages Dori also writes its fixed lines in; any other name still works as free text. */
const LANGUAGES = ["Korean", "English", "Japanese", "Chinese"] as const;
const UNSET = "";

function savedNotice(saved: DoriConfigSaved, m: Messages): string {
  return saved.restart ? m.settings.savedAfterRestart : m.settings.savedNow;
}

function useSave(onSaved: (saved: DoriConfigSaved) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (edit: DoriConfigEdit) => saveDoriConfig(edit),
    onSuccess: (saved) => {
      queryClient.setQueryData<DoriConfigView>(doriConfigKey, saved.view);
      onSaved(saved);
    },
  });
}

/**
 * The Dori config of the server's host, shared by every setting that shows a key of it. A setting
 * that mounts later reads the answer already given instead of asking again: asking again would
 * clear a refusal (a server without Dori) while it waits, and whether the Dori sections show
 * would flip with it.
 */
export function useDoriConfig() {
  return useQuery({
    queryKey: doriConfigKey,
    queryFn: fetchDoriConfig,
    retry: false,
    retryOnMount: false,
    staleTime: Infinity,
    refetchOnMount: false,
  });
}

/**
 * Whether Dori is set up on the server: true once the host has a Dori config file, false when it
 * has none or the server runs without Dori, and null until the server answers.
 */
export function useDoriConnected(): boolean | null {
  const config = useDoriConfig();
  if (config.data) return config.data.present;
  return config.isError ? false : null;
}

export type ChoiceOption = { readonly value: string; readonly label: string };

/**
 * One Dori config key picked from `options` and saved as soon as it is picked. A value the
 * options do not name (set on the host) is offered as it is, so picking leaves nothing unseen.
 */
export function ChoiceSetting({
  entry,
  label,
  description,
  options,
  searchable = false,
}: {
  entry: DoriConfigEntry;
  label: string;
  description: string;
  options: readonly ChoiceOption[];
  searchable?: boolean;
}) {
  const m = useMessages();
  // The save itself is kept, not its text: saving the language changes the language of the text.
  const [notice, setNotice] = useState<DoriConfigSaved | null>(null);
  const save = useSave(setNotice);
  const listed = options.some((option) => option.value === entry.value);
  return (
    <div className="flex flex-col gap-1">
      <Selector
        label={label}
        description={description}
        options={listed ? [...options] : [...options, { value: entry.value, label: entry.value }]}
        hasSearch={searchable}
        value={entry.value}
        isDisabled={save.isPending || entry.access !== "edit"}
        onChange={(value) => {
          setNotice(null);
          save.mutate({ key: entry.key, value: value ?? UNSET });
        }}
      />
      {notice && <p role="status" className="text-muted-foreground">{savedNotice(notice, m)}</p>}
      {save.error && <p role="alert" className="break-words text-destructive">{save.error.message}</p>}
    </div>
  );
}

function LanguageSetting({ entry }: { entry: DoriConfigEntry }) {
  const m = useMessages();
  const options = [
    { value: UNSET, label: m.settings.languageUnset },
    ...LANGUAGES.map((l) => ({ value: l, label: m.settings.languageNames[l] })),
  ];
  return <ChoiceSetting entry={entry} label={m.settings.language} description={m.settings.languageDescription} options={options} />;
}

/**
 * The Time zone setting of the General section: the time zone the app shows dates in and Dori
 * writes times to its owner in. A server without Dori has no such setting, so nothing shows.
 */
export function TimeZoneSettingField() {
  const m = useMessages();
  const entry = useDoriConfig().data?.entries.find((e) => e.key === DORI_TIME_ZONE_KEY);
  if (!entry) return null;
  const zones = Intl.supportedValuesOf("timeZone").map((zone) => ({ value: zone, label: zone.replaceAll("_", " ") }));
  return (
    <ChoiceSetting
      entry={entry}
      label={m.settings.timeZone}
      description={m.settings.timeZoneDescription}
      options={[{ value: UNSET, label: m.settings.timeZoneUnset }, ...zones]}
      searchable
    />
  );
}

function hint(entry: DoriConfigEntry, m: Messages): string {
  if (entry.kind === "list") return m.settings.hintList;
  if (entry.kind === "json") return m.settings.hintJson;
  if (entry.kind === "enum") return m.settings.hintEnum(entry.values?.join(", ") ?? "");
  if (entry.kind === "bool") return m.settings.hintBool;
  return "";
}

/**
 * The Language setting of the General section: the language of the app's screens and of what Dori
 * writes to its owner. A server without Dori has no such setting, so nothing shows.
 */
export function LanguageSettingField() {
  const config = useDoriConfig();
  const language = config.data?.entries.find((e) => e.key === DORI_LANGUAGE_KEY);
  return language ? <LanguageSetting entry={language} /> : null;
}

function EntryRow({ entry }: { entry: DoriConfigEntry }) {
  const m = useMessages();
  const [draft, setDraft] = useState(entry.value);
  const [base, setBase] = useState(entry.value);
  const [notice, setNotice] = useState<DoriConfigSaved | null>(null);
  // A saved or refetched value replaces the draft.
  if (entry.value !== base) {
    setBase(entry.value);
    setDraft(entry.value);
  }
  const save = useSave(setNotice);
  const editable = entry.access === "edit";
  const changed = draft !== entry.value;
  const describe = /[.)]$/.test(entry.describe) ? entry.describe : `${entry.describe}.`;
  const description = [describe, editable ? hint(entry, m) : m.settings.hostOnly].filter(Boolean).join(" ");
  const field = { label: entry.key, description, value: draft, isReadOnly: !editable, isRequired: entry.required };
  const onChange = (value: string) => {
    setDraft(value);
    setNotice(null);
    save.reset();
  };
  return (
    <li aria-label={`Config ${entry.key}`} className="flex flex-col gap-1 border-b pb-3 last:border-b-0">
      <div className="flex flex-wrap gap-1">
        {entry.access === "masked" && <Badge variant="warning" label={m.settings.hidden} />}
        {entry.access === "readOnly" && <Badge label={m.settings.readOnly} />}
        {entry.restart && <Badge variant="info" label={m.settings.restartToApply} />}
      </div>
      {entry.kind === "json" ? <TextArea {...field} onChange={onChange} /> : <TextInput {...field} size="sm" onChange={onChange} />}
      {editable && changed && (
        <div className="flex gap-1">
          <Button
            changesData
            size="sm"
            variant="primary"
            label={m.settings.saveKey(entry.key)}
            isDisabled={save.isPending}
            onClick={() => save.mutate({ key: entry.key, value: draft })}
          >
            {m.common.save}
          </Button>
          <Button size="sm" variant="ghost" label={m.settings.revertKey(entry.key)} onClick={() => onChange(entry.value)}>
            {m.settings.revert}
          </Button>
        </div>
      )}
      {notice && !changed && <p role="status" className="text-muted-foreground">{savedNotice(notice, m)}</p>}
      {save.error && <p role="alert" className="break-words text-destructive">{save.error.message}</p>}
    </li>
  );
}

/**
 * The keys other settings show in plain words: the language and time zone in General, how Dori
 * works in the Dori section. The raw config leaves them out.
 */
export const DORI_KEYS_SHOWN_ELSEWHERE: readonly string[] = [DORI_LANGUAGE_KEY, DORI_TIME_ZONE_KEY, "platforms", "autoReport", "threadCloseAfterHours"];

function EntryList({ label, entries }: { label: string; entries: readonly DoriConfigEntry[] }) {
  return (
    <ul aria-label={label} className="flex flex-col gap-3">
      {entries.map((entry) => (
        <EntryRow key={entry.key} entry={entry} />
      ))}
    </ul>
  );
}

/**
 * The Dori config of the server's host (`~/.dori/config.json`), key by key: every key Dori reads
 * but those other settings show, with the keys only the host changes folded away. It asks the
 * server only while shown (`active`).
 */
export function DoriConfigPanel({ active }: { active: boolean }) {
  const m = useMessages();
  const config = useQuery({ queryKey: doriConfigKey, queryFn: fetchDoriConfig, enabled: active });
  const view = config.data;
  const entries = view?.entries.filter((e) => !DORI_KEYS_SHOWN_ELSEWHERE.includes(e.key)) ?? [];
  const hostOnly = entries.filter((e) => e.access !== "edit");
  return (
    <section aria-label={m.settings.advanced.doriConfig} className="flex flex-col gap-4 text-sm">
      {config.error && <p role="alert" className="break-words text-destructive">{config.error.message}</p>}
      {view && (
        <>
          <p className="text-muted-foreground">
            {fill(m.settings.configFile, { path: <code className="break-all">{view.path}</code>, env: <code>~/.dori/env</code> })}
          </p>
          {view.error && <p role="alert" className="break-words text-destructive">{view.error}</p>}
          {!view.present && <p role="alert">{fill(m.settings.configMissing, { command: <code>dori setup</code> })}</p>}
          <EntryList label="Dori config keys" entries={entries.filter((e) => e.access === "edit")} />
          {hostOnly.length > 0 && (
            <details>
              <summary className="cursor-pointer text-muted-foreground">{m.settings.advanced.hostOnlyKeys(hostOnly.length)}</summary>
              <div className="pt-3">
                <EntryList label="Dori config keys changed only on the host" entries={hostOnly} />
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
