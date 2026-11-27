// Database files over HTTP, for clients that do not share the server's filesystem.
//
// - `GET /api/backups/export` sends a consistent snapshot of the database.
// - `GET /api/backups/{name}` sends a backup from the backup directory, by the file name
//   `list_backups` reports.
// - `POST /api/backups/restore` replaces all data with the Toodo database sent as the
//   request body, after saving the current data as a pre-restore backup; the result is
//   that backup, as `restore_backup` returns it.
//
// Files are sent as `application/vnd.sqlite3` attachments.

import { createReadStream, openSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { exportFileName, exportSnapshot, restoreFile } from "../commands/backup.ts";
import { commandError, internal, ioMessage } from "../commands/errors.ts";
import { failed, json, text } from "./auth.ts";
import type { Services } from "./services.ts";

/** How long a client may take to send each next piece of a request body before the upload
 * counts as stalled. */
export const READ_TIMEOUT_MS = 30_000;

const SQLITE = "application/vnd.sqlite3";

export function remove(path: string): void {
  try {
    rmSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`toodo-server: cannot remove ${path}: ${ioMessage(error)}`);
    }
  }
}

function attachmentHeaders(name: string): Record<string, string> {
  return {
    "content-type": SQLITE,
    "content-disposition": `attachment; filename="${name}"`,
    "cache-control": "no-store",
  };
}

/**
 * The snapshot at `path` as an attachment named `name`, removed once open: the open file
 * keeps it readable while it is read from disk and sent, so a download holds one chunk of
 * it in memory rather than the whole file. Bun sends a stream body chunked, so unlike a
 * file on disk it goes without `Content-Length`.
 */
function snapshot(path: string, name: string): Response {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    return failed(internal(`cannot read ${path}: ${ioMessage(error)}`));
  } finally {
    remove(path);
  }
  // The stream closes the file when it ends or the client goes away.
  const body = Readable.toWeb(createReadStream("", { fd })) as ReadableStream<Uint8Array>;
  return new Response(body, { headers: attachmentHeaders(name) });
}

export function exportDatabase(services: Services): Response {
  let path: string;
  let name: string;
  try {
    path = exportSnapshot(services.storage, services.backups);
    name = exportFileName(services.storage);
  } catch (error) {
    return failed(commandError(error));
  }
  return snapshot(path, name);
}

export function download(services: Services, name: string): Response {
  let path: string;
  try {
    path = services.backups.backupPath(name);
  } catch (error) {
    return failed(commandError(error));
  }
  // Bun reads the file while it sends it and gives its length.
  return new Response(Bun.file(path), { headers: attachmentHeaders(name) });
}

function tooLarge(limit: number): Response {
  return text(413, `a database to restore is at most ${limit / 1024 / 1024} MB`);
}

/** Why an upload did not arrive whole. */
export type UploadError =
  | { readonly kind: "too_large" }
  /** No more of the body arrived within `READ_TIMEOUT_MS`. */
  | { readonly kind: "stalled" }
  | { readonly kind: "broken_off"; readonly message: string }
  | { readonly kind: "store"; readonly error: unknown };

export function uploadFailed(error: UploadError, tooLargeResponse: () => Response): Response {
  switch (error.kind) {
    case "too_large":
      return tooLargeResponse();
    case "stalled":
      return text(408, `the upload stalled: nothing arrived for ${READ_TIMEOUT_MS / 1000} seconds`);
    case "broken_off":
      return text(400, `the upload broke off: ${error.message}`);
    case "store":
      return failed(internal(`cannot store the upload: ${ioMessage(error.error)}`));
  }
}

export function declaredLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  return value !== null && /^\d+$/.test(value) ? Number(value) : null;
}

/** Writes the request body to `path`, failing once it grows past `limit` bytes or stalls. */
export async function receive(request: Request, path: string, limit: number): Promise<UploadError | null> {
  let file;
  try {
    file = await open(path, "w", 0o600);
  } catch (error) {
    return { kind: "store", error };
  }
  try {
    if (request.body === null) return null;
    const reader = request.body.getReader();
    let received = 0;
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<"stalled">((resolve) => {
        timer = setTimeout(() => resolve("stalled"), READ_TIMEOUT_MS);
      });
      let chunk: Awaited<ReturnType<typeof reader.read>> | "stalled";
      try {
        chunk = await Promise.race([reader.read(), stalled]);
      } catch (error) {
        return { kind: "broken_off", message: error instanceof Error ? error.message : String(error) };
      } finally {
        clearTimeout(timer);
      }
      if (chunk === "stalled") {
        void reader.cancel().catch(() => {});
        return { kind: "stalled" };
      }
      if (chunk.done) return null;
      received += chunk.value.byteLength;
      if (received > limit) {
        void reader.cancel().catch(() => {});
        return { kind: "too_large" };
      }
      try {
        await file.write(chunk.value);
      } catch (error) {
        return { kind: "store", error };
      }
    }
  } finally {
    await file.close();
  }
}

export async function restore(services: Services, request: Request): Promise<Response> {
  const limit = services.restoreLimit;
  const declared = declaredLength(request);
  if (declared !== null && declared > limit) return tooLarge(limit);
  let path: string;
  try {
    path = services.backups.scratchPath("upload");
  } catch (error) {
    return failed(internal(`cannot store the upload: ${ioMessage(error)}`));
  }
  try {
    const error = await receive(request, path, limit);
    if (error !== null) return uploadFailed(error, () => tooLarge(limit));
    try {
      return json(200, restoreFile(services.storage, services.backups, path));
    } catch (failure) {
      return failed(commandError(failure));
    }
  } finally {
    remove(path);
  }
}
