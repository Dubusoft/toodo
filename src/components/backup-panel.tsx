import { useState, type FormEvent } from "react";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@/components/button";
import type { BackupEntry, BackupSettings } from "@/lib/bindings";
import { formatFull } from "@/lib/timeline";
import { When } from "@/components/when";
import {
  useBackupSettings,
  useBackupStatus,
  useBackups,
  useDownloadBackup,
  useDownloadExport,
  useRestoreBackup,
  useSaveBackupSettings,
  useUploadRestore,
} from "@/lib/queries";

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const kindLabels: Record<BackupEntry["kind"], string> = {
  automatic: "Automatic",
  preRestore: "Before restore",
  preMigration: "Before update",
};

/** "Backup failed" while the latest automatic backup failed, for the Settings button and tab. */
export function BackupStatusLabel() {
  const status = useBackupStatus();
  if (!status.data?.lastFailure) return null;
  return <span className="text-destructive">Backup failed</span>;
}

function BackupFailureAlert() {
  const status = useBackupStatus();
  const failure = status.data?.lastFailure;
  if (!failure) return null;
  return (
    <p role="alert" aria-label="Automatic backup failed" className="text-xs break-words text-destructive">
      The automatic backup <When at={failure.at} /> failed: {failure.message}
    </p>
  );
}

/** What a confirmed restore replaces the data with. */
type RestoreSource = { kind: "backup"; path: string } | { kind: "upload"; file: File };

function sourceName(source: RestoreSource): string {
  return source.kind === "upload" ? source.file.name : fileName(source.path);
}

export function BackupPanel() {
  const backups = useBackups();
  const downloadExport = useDownloadExport();
  const downloadBackup = useDownloadBackup();
  const restoreBackup = useRestoreBackup();
  const uploadRestore = useUploadRestore();
  const [confirming, setConfirming] = useState<RestoreSource | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const exporting = downloadExport.isPending;
  const restoring = restoreBackup.isPending || uploadRestore.isPending;

  function exportToFile() {
    setNotice(null);
    // The server sends a snapshot and the browser downloads it.
    downloadExport.mutate(undefined, { onSuccess: (name) => setNotice(`Downloaded ${name}`) });
  }

  function pickBackup() {
    setNotice(null);
    // Keep the picker out of the document so attachment selectors cannot target it.
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".sqlite3,.db,application/vnd.sqlite3";
    input.setAttribute("aria-label", "Restore backup file");
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) setConfirming({ kind: "upload", file });
    }, { once: true });
    input.click();
  }

  function restore(source: RestoreSource) {
    setNotice(null);
    const options = {
      onSuccess: (safety: BackupEntry) => {
        setConfirming(null);
        setNotice(`Restored ${sourceName(source)}. The previous data was saved as ${fileName(safety.path)}.`);
      },
    };
    if (source.kind === "upload") uploadRestore.mutate(source.file, options);
    else restoreBackup.mutate(fileName(source.path), options);
  }

  const error =
    downloadExport.error ?? downloadBackup.error ?? restoreBackup.error ?? uploadRestore.error ?? backups.error;

  return (
    <section aria-label="Backups" className="flex flex-col gap-2">
      <div className="flex gap-1">
        <Button
          size="sm"
          variant="secondary"
          label={exporting ? "Exporting..." : "Export..."}
          onClick={exportToFile}
          isDisabled={exporting}
        />
        <Button size="sm" variant="secondary" label="Restore from file" onClick={pickBackup} isDisabled={restoring} />
      </div>
      {confirming && (
        <div role="alertdialog" aria-label="Confirm restore" className="flex flex-col gap-1 rounded-md border border-destructive/40 p-2">
          <p className="text-xs break-words">
            Replace all workspaces and tasks with <span className="font-medium">{sourceName(confirming)}</span>? The
            current data is backed up first.
          </p>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="destructive"
              label={restoring ? "Restoring..." : "Replace data"}
              onClick={() => restore(confirming)}
              isDisabled={restoring}
            />
            <Button size="sm" variant="ghost" label="Cancel" onClick={() => setConfirming(null)} isDisabled={restoring} />
          </div>
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs break-words text-muted-foreground">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs break-words text-destructive">
          {error.message}
        </p>
      )}
      <BackupFailureAlert />
      <AutoBackupSettings />
      <ul aria-label="Saved backups" className="flex flex-col divide-y">
        {backups.data?.length === 0 && <li className="text-xs text-muted-foreground">No backups yet.</li>}
        {backups.data?.map((backup) => (
          <li key={backup.path} className="flex flex-col gap-1 py-1.5 text-xs first:pt-0" title={backup.path}>
            <span className="flex flex-col">
              <time className="font-medium" dateTime={new Date(backup.createdAt * 1000).toISOString()}>
                {formatFull(backup.createdAt)}
              </time>
              <span className="text-muted-foreground">
                <When at={backup.createdAt} /> · {kindLabels[backup.kind]} · {formatSize(backup.sizeBytes)}
              </span>
            </span>
            <span className="flex flex-wrap gap-1">
              <Button
                changesData
                size="sm"
                variant="secondary"
                label={`Download backup from ${formatFull(backup.createdAt)}`}
                isDisabled={downloadBackup.isPending}
                onClick={() => {
                  setNotice(null);
                  downloadBackup.mutate(fileName(backup.path), { onSuccess: (name) => setNotice(`Downloaded ${name}`) });
                }}
              >
                Download
              </Button>
              <Button
                size="sm"
                variant="secondary"
                label={`Restore this backup from ${formatFull(backup.createdAt)}`}
                onClick={() => {
                  setNotice(null);
                  setConfirming({ kind: "backup", path: backup.path });
                }}
              >
                Restore this backup
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AutoBackupSettings() {
  const settings = useBackupSettings();
  if (!settings.data) return null;
  const { enabled, intervalHours, keep, directory } = settings.data;
  return <AutoBackupForm key={`${enabled}-${intervalHours}-${keep}-${directory ?? ""}`} initial={settings.data} />;
}

function AutoBackupForm({ initial }: { initial: BackupSettings }) {
  const save = useSaveBackupSettings();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [intervalHours, setIntervalHours] = useState(initial.intervalHours);
  const [keep, setKeep] = useState(initial.keep);
  const [directory, setDirectory] = useState(initial.directory ?? "");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate({ enabled, intervalHours, keep, directory: directory.trim() || null });
  }

  return (
    <form onSubmit={submit} aria-label="Automatic backups" className="flex flex-col gap-1 text-xs">
      <CheckboxInput size="sm" label="Back up automatically" value={enabled} onChange={setEnabled} />
      <div className="flex items-center gap-2">
        Every
        <NumberInput
          size="sm"
          width={80}
          label="Hours between backups"
          isLabelHidden
          isIntegerOnly
          min={1}
          max={720}
          value={intervalHours}
          onChange={setIntervalHours}
          isDisabled={!enabled}
        />
        hours
      </div>
      <div className="flex items-center gap-2">
        Keep
        <NumberInput
          size="sm"
          width={80}
          label="Backups to keep"
          isLabelHidden
          isIntegerOnly
          min={1}
          max={100}
          value={keep}
          onChange={setKeep}
          isDisabled={!enabled}
        />
        latest
      </div>
      <TextInput
        size="sm"
        label="Backup directory"
        description="An absolute path on the server, e.g. on another disk. Every backup goes there, including the one before an update."
        placeholder="the server's data directory"
        hasSpellCheck={false}
        value={directory}
        onChange={setDirectory}
      />
      {save.isError && (
        <p role="alert" className="text-destructive">
          {save.error.message}
        </p>
      )}
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        className="self-start"
        label={save.isPending ? "Saving..." : "Save backup settings"}
        isDisabled={save.isPending}
      />
    </form>
  );
}
