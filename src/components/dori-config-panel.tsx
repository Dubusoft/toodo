import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@astryxdesign/core/Badge";
import { Selector } from "@astryxdesign/core/Selector";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@/components/button";
import {
  DORI_LANGUAGE_KEY,
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

function LanguageSetting({ entry }: { entry: DoriConfigEntry }) {
  const m = useMessages();
  // The save itself is kept, not its text: saving the language changes the language of the text.
  const [notice, setNotice] = useState<DoriConfigSaved | null>(null);
  const save = useSave(setNotice);
  const known: readonly string[] = LANGUAGES;
  const options = [
    { value: UNSET, label: m.settings.languageUnset },
    ...LANGUAGES.map((l) => ({ value: l, label: m.settings.languageNames[l] })),
    ...(entry.value && !known.includes(entry.value) ? [{ value: entry.value, label: entry.value }] : []),
  ];
  return (
    <div className="flex flex-col gap-1">
      <Selector
        label={m.settings.language}
        description={m.settings.languageDescription}
        options={options}
        value={entry.value}
        isDisabled={save.isPending || entry.access !== "edit"}
        onChange={(value) => {
          setNotice(null);
          save.mutate({ key: DORI_LANGUAGE_KEY, value: value ?? UNSET });
        }}
      />
      {notice && <p role="status" className="text-muted-foreground">{savedNotice(notice, m)}</p>}
      {save.error && <p role="alert" className="break-words text-destructive">{save.error.message}</p>}
    </div>
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
  const config = useQuery({ queryKey: doriConfigKey, queryFn: fetchDoriConfig, retry: false, staleTime: Infinity });
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
 * The Dori config of the server's host (`~/.dori/config.json`): every key Dori reads but the
 * language, which the General section sets. It asks the server only while shown (`active`).
 */
export function DoriConfigPanel({ active }: { active: boolean }) {
  const m = useMessages();
  const config = useQuery({ queryKey: doriConfigKey, queryFn: fetchDoriConfig, enabled: active });
  const view = config.data;
  return (
    <section aria-label="Dori config" className="flex flex-col gap-4 text-sm">
      {config.error && <p role="alert" className="break-words text-destructive">{config.error.message}</p>}
      {view && (
        <>
          <p className="text-muted-foreground">
            {fill(m.settings.configFile, { path: <code className="break-all">{view.path}</code>, env: <code>~/.dori/env</code> })}
          </p>
          {view.error && <p role="alert" className="break-words text-destructive">{view.error}</p>}
          {!view.present && <p role="alert">{fill(m.settings.configMissing, { command: <code>dori setup</code> })}</p>}
          <ul aria-label="Dori config keys" className="flex flex-col gap-3">
            {view.entries
              .filter((e) => e.key !== DORI_LANGUAGE_KEY)
              .map((entry) => (
                <EntryRow key={entry.key} entry={entry} />
              ))}
          </ul>
        </>
      )}
    </section>
  );
}
