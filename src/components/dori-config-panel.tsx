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
import { fetchDoriConfig, saveDoriConfig } from "@/web/dori-config";

const doriConfigKey = ["dori-config"];

/** The languages Dori also writes its fixed lines in; any other name still works as free text. */
const LANGUAGES = ["Korean", "English", "Japanese", "Chinese"];
const UNSET = "";

function savedNotice(saved: DoriConfigSaved): string {
  return saved.restart
    ? "Saved. The supervisor takes this key after a restart (toodo service restart)."
    : "Saved. Dori applies it now, without a restart.";
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
  const [notice, setNotice] = useState<string | null>(null);
  const save = useSave((saved) => setNotice(savedNotice(saved)));
  const options = [
    { value: UNSET, label: "Not set (the language of each message)" },
    ...[...LANGUAGES, ...(entry.value && !LANGUAGES.includes(entry.value) ? [entry.value] : [])].map((l) => ({ value: l, label: l })),
  ];
  return (
    <div className="flex flex-col gap-1">
      <Selector
        label="Language"
        description="Dori writes every reply, report and question to you in this language, and so do its lanes."
        options={options}
        value={entry.value}
        isDisabled={save.isPending || entry.access !== "edit"}
        onChange={(value) => {
          setNotice(null);
          save.mutate({ key: DORI_LANGUAGE_KEY, value: value ?? UNSET });
        }}
      />
      {notice && <p role="status" className="text-muted-foreground">{notice}</p>}
      {save.error && <p role="alert" className="break-words text-destructive">{save.error.message}</p>}
    </div>
  );
}

function hint(entry: DoriConfigEntry): string {
  if (entry.kind === "list") return "Comma separated, or a JSON array.";
  if (entry.kind === "json") return "JSON.";
  if (entry.kind === "enum") return `One of ${entry.values?.join(", ")}.`;
  if (entry.kind === "bool") return "true or false.";
  return "";
}

function EntryRow({ entry }: { entry: DoriConfigEntry }) {
  const [draft, setDraft] = useState(entry.value);
  const [base, setBase] = useState(entry.value);
  const [notice, setNotice] = useState<string | null>(null);
  // A saved or refetched value replaces the draft.
  if (entry.value !== base) {
    setBase(entry.value);
    setDraft(entry.value);
  }
  const save = useSave((saved) => setNotice(savedNotice(saved)));
  const editable = entry.access === "edit";
  const changed = draft !== entry.value;
  const describe = /[.)]$/.test(entry.describe) ? entry.describe : `${entry.describe}.`;
  const description = [describe, editable ? hint(entry) : "Changed only on the host."].filter(Boolean).join(" ");
  const field = { label: entry.key, description, value: draft, isReadOnly: !editable, isRequired: entry.required };
  const onChange = (value: string) => {
    setDraft(value);
    setNotice(null);
    save.reset();
  };
  return (
    <li aria-label={`Config ${entry.key}`} className="flex flex-col gap-1 border-b pb-3 last:border-b-0">
      <div className="flex flex-wrap gap-1">
        {entry.access === "masked" && <Badge variant="warning" label="Hidden" />}
        {entry.access === "readOnly" && <Badge label="Read-only" />}
        {entry.restart && <Badge variant="info" label="Restart to apply" />}
      </div>
      {entry.kind === "json" ? <TextArea {...field} onChange={onChange} /> : <TextInput {...field} size="sm" onChange={onChange} />}
      {editable && changed && (
        <div className="flex gap-1">
          <Button
            changesData
            size="sm"
            variant="primary"
            label={`Save ${entry.key}`}
            isDisabled={save.isPending}
            onClick={() => save.mutate({ key: entry.key, value: draft })}
          >
            Save
          </Button>
          <Button size="sm" variant="ghost" label={`Revert ${entry.key}`} onClick={() => onChange(entry.value)}>
            Revert
          </Button>
        </div>
      )}
      {notice && !changed && <p role="status" className="text-muted-foreground">{notice}</p>}
      {save.error && <p role="alert" className="break-words text-destructive">{save.error.message}</p>}
    </li>
  );
}

/**
 * The Dori config of the server's host (`~/.dori/config.json`): the Language setting first, then
 * every key Dori reads. It asks the server only while shown (`active`).
 */
export function DoriConfigPanel({ active }: { active: boolean }) {
  const config = useQuery({ queryKey: doriConfigKey, queryFn: fetchDoriConfig, enabled: active });
  const view = config.data;
  const language = view?.entries.find((e) => e.key === DORI_LANGUAGE_KEY);
  return (
    <section aria-label="Dori config" className="flex flex-col gap-4 text-sm">
      {config.error && <p role="alert" className="break-words text-destructive">{config.error.message}</p>}
      {view && (
        <>
          <p className="text-muted-foreground">
            <code className="break-all">{view.path}</code> on the server's host. Secrets stay in <code>~/.dori/env</code> and
            are never shown here.
          </p>
          {view.error && <p role="alert" className="break-words text-destructive">{view.error}</p>}
          {!view.present && <p role="alert">The file does not exist yet; run <code>dori setup</code> on the host first.</p>}
          {language && <LanguageSetting entry={language} />}
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
