// Files attached to chat messages, over HTTP.
//
// - `POST /api/chat/attachments?name=<file name>` uploads a person's file. The request body
//   is the file and its `Content-Type` the file's media type. The answer is the attachment
//   (`201`), which a message then takes by its ID; an upload no message takes within a day
//   is dropped.
// - `GET /api/chat/attachments/{id}` sends a file back.
//
// The agent's routes on `/mcp/attachments` take the same uploader-aware functions. The files
// are kept in `attachments/` of the data directory under a random key. Common raster images
// are sent inline; everything else is sent as a download, and every file with `nosniff` and
// a sandboxing CSP, so an uploaded page never runs as the app.

import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { attachment, contentType, fileName } from "../commands/chat-types.ts";
import { commandError, internal, ioMessage } from "../commands/errors.ts";
import { type ChatAttachmentId, type ChatAuthor } from "../domain/chat.ts";
import { chatAttachment, createChatAttachment, removeStaleChatAttachments } from "../storage/chat-attachments.ts";
import { StorageError } from "../storage/errors.ts";
import { failed, json, text } from "./auth.ts";
import { declaredLength, receive, remove, uploadFailed } from "./files.ts";
import type { Services } from "./services.ts";
import { createPrivateDir } from "./tokens.ts";

/** How long an upload waits for a message to take it, in seconds. */
const UNSENT_FOR = 24 * 60 * 60;

/** The media types sent inline: images a browser shows without running anything. */
const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function tooLarge(limit: number): Response {
  return text(413, `a chat attachment is at most ${Math.floor(limit / 1024 / 1024)} MB`);
}

export async function upload(services: Services, uploader: ChatAuthor, name: string, request: Request): Promise<Response> {
  let kept: string;
  try {
    kept = fileName(name);
  } catch (error) {
    return failed(commandError(error));
  }
  const limit = services.attachmentLimit;
  const declared = declaredLength(request);
  if (declared !== null && declared > limit) return tooLarge(limit);
  const type = contentType(request.headers.get("content-type"));
  const dir = services.attachmentDir;
  const key = randomBytes(16).toString("hex");
  try {
    createPrivateDir(dir);
  } catch (error) {
    return failed(internal(`cannot store the upload: ${ioMessage(error)}`));
  }
  const path = join(dir, key);
  const error = await receive(request, path, limit);
  if (error !== null) {
    remove(path);
    return uploadFailed(error, () => tooLarge(limit));
  }
  let size: number;
  try {
    size = statSync(path).size;
  } catch (failure) {
    remove(path);
    return failed(internal(`cannot read the upload: ${ioMessage(failure)}`));
  }
  const { storage } = services;
  try {
    const created = createChatAttachment(storage.db, { fileKey: key, uploader, name: kept, contentType: type, size }, storage.now());
    for (const stale of removeStaleChatAttachments(storage.db, storage.now() - UNSENT_FOR)) remove(join(dir, stale));
    return json(201, attachment(created));
  } catch (failure) {
    remove(path);
    return failed(commandError(failure));
  }
}

export function send(services: Services, id: ChatAttachmentId): Response {
  let found;
  try {
    found = chatAttachment(services.reader.db, id);
    if (found === null) throw new StorageError({ kind: "chat_attachment_not_found", attachment: id });
  } catch (error) {
    return failed(commandError(error));
  }
  const { attachment: file, fileKey } = found;
  const path = join(services.attachmentDir, fileKey);
  try {
    statSync(path);
  } catch (error) {
    return failed(internal(`cannot read chat attachment ${id}: ${ioMessage(error)}`));
  }
  return new Response(Bun.file(path).stream(), {
    headers: {
      "content-type": file.contentType,
      "content-length": String(file.size),
      "content-disposition": contentDisposition(INLINE.has(file.contentType) ? "inline" : "attachment", file.name),
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "cache-control": "private, max-age=86400",
    },
  });
}

/** `Content-Disposition` with `name` as an ASCII fallback and, in full, as UTF-8 (RFC 6266). */
export function contentDisposition(disposition: string, name: string): string {
  const fallback = [...name]
    .map((c) => ((c >= "!" && c <= "~" && c !== '"' && c !== "\\") || c === " " ? c : "_"))
    .join("");
  const encoded = [...new TextEncoder().encode(name)]
    .map((byte) => {
      const c = String.fromCharCode(byte);
      return /[A-Za-z0-9\-._~]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
