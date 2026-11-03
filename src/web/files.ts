/**
 * Database files of `toodo-server`: the browser downloads snapshots and
 * backups and uploads a database to restore over `/api/backups`, since it cannot reach
 * paths on the server.
 */
import type { BackupEntry } from "@/lib/bindings";
import { apiRequest as request } from "@/web/session";

/** The file name in a `Content-Disposition: attachment; filename="..."` header. */
function attachmentName(response: Response, fallback: string): string {
  const match = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "");
  return match?.[1] ?? fallback;
}

function save(name: string, data: Blob) {
  const url = URL.createObjectURL(data);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** Downloads a snapshot of the server's database; resolves with the saved file name. */
export async function downloadExport(): Promise<string> {
  const response = await request("/api/backups/export");
  const name = attachmentName(response, "toodo-backup.sqlite3");
  save(name, await response.blob());
  return name;
}

/** Downloads the backup named `name` from the server's backup directory. */
export async function downloadBackup(name: string): Promise<string> {
  const response = await request(`/api/backups/${encodeURIComponent(name)}`);
  save(name, await response.blob());
  return name;
}

/**
 * Replaces all data on the server with the database in `file`. Resolves with the backup
 * of the previous data that the server saved first.
 */
export async function uploadRestore(file: Blob): Promise<BackupEntry> {
  const response = await request("/api/backups/restore", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  return (await response.json()) as BackupEntry;
}
