import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import type { BackupEntry, BackupSettings } from "@/lib/bindings";
import { formatFull } from "@/lib/timeline";
import { When } from "@/components/when";
import {
  useBackupSettings,
  useBackups,
  useDownloadBackup,
  useDownloadExport,
  useRestoreBackup,
  useSaveBackupSettings,
  useUploadRestore,
} from "@/lib/queries";

const inputClass = "h-7 w-16 rounded-md border bg-background px-2 text-sm";

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const kindLabels: Record<BackupEntry["kind"], string> = {
  automatic: "Automatic",
  preRestore: "Before restore",
};

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
  const upload = useRef<HTMLInputElement>(null);
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
    upload.current?.click();
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
        <Button size="sm" variant="outline" onClick={exportToFile} disabled={exporting}>
          {exporting ? "Exporting..." : "Export..."}
        </Button>
        <Button size="sm" variant="outline" onClick={pickBackup} disabled={restoring}>
          Restore...
        </Button>
        <input
          ref={upload}
          type="file"
          accept=".sqlite3,.db"
          aria-label="Database file to restore"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) setConfirming({ kind: "upload", file });
          }}
        />
      </div>
      {confirming && (
        <div role="alertdialog" aria-label="Confirm restore" className="flex flex-col gap-1 rounded-md border border-destructive/40 p-2">
          <p className="text-xs break-words">
            Replace all workspaces and tasks with <span className="font-medium">{sourceName(confirming)}</span>? The
            current data is backed up first.
          </p>
          <div className="flex gap-1">
            <Button size="xs" variant="destructive" onClick={() => restore(confirming)} disabled={restoring}>
              {restoring ? "Restoring..." : "Replace data"}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirming(null)} disabled={restoring}>
              Cancel
            </Button>
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
                size="xs"
                variant="outline"
                aria-label={`Download backup from ${formatFull(backup.createdAt)}`}
                disabled={downloadBackup.isPending}
                onClick={() => {
                  setNotice(null);
                  downloadBackup.mutate(fileName(backup.path), { onSuccess: (name) => setNotice(`Downloaded ${name}`) });
                }}
              >
                Download
              </Button>
              <Button
                size="xs"
                variant="outline"
                aria-label={`Restore this backup from ${formatFull(backup.createdAt)}`}
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
  const { enabled, intervalHours, keep } = settings.data;
  return <AutoBackupForm key={`${enabled}-${intervalHours}-${keep}`} initial={settings.data} />;
}

function AutoBackupForm({ initial }: { initial: BackupSettings }) {
  const save = useSaveBackupSettings();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [intervalHours, setIntervalHours] = useState(String(initial.intervalHours));
  const [keep, setKeep] = useState(String(initial.keep));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate({ enabled, intervalHours: Number(intervalHours), keep: Number(keep) });
  }

  return (
    <form onSubmit={submit} aria-label="Automatic backups" className="flex flex-col gap-1 text-xs">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Back up automatically
      </label>
      <label className="flex items-center gap-2">
        Every
        <input
          className={inputClass}
          type="number"
          min={1}
          max={720}
          aria-label="Hours between backups"
          value={intervalHours}
          onChange={(e) => setIntervalHours(e.target.value)}
          disabled={!enabled}
          required
        />
        hours
      </label>
      <label className="flex items-center gap-2">
        Keep
        <input
          className={inputClass}
          type="number"
          min={1}
          max={100}
          aria-label="Backups to keep"
          value={keep}
          onChange={(e) => setKeep(e.target.value)}
          disabled={!enabled}
          required
        />
        latest
      </label>
      {save.isError && (
        <p role="alert" className="text-destructive">
          {save.error.message}
        </p>
      )}
      <Button type="submit" size="xs" variant="outline" className="self-start" disabled={save.isPending}>
        {save.isPending ? "Saving..." : "Save schedule"}
      </Button>
    </form>
  );
}
