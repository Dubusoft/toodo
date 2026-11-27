// Files attached to chat messages, whose bytes the server keeps on disk under `file_key`.
// Port of the attachment parts of `src-tauri/src/storage/chat.rs`. Functions that write
// take the time they act at (`at`, Unix seconds) from the caller.

import type { Database } from "bun:sqlite";

import {
  type ChatAttachment,
  type ChatAttachmentId,
  type ChatAuthor,
  type ChatMessageId,
  chatAttachmentId,
  chatAuthorAsStr,
  chatMessageId,
  parseChatAuthor,
} from "../domain/chat.ts";
import { debugString } from "../domain/rust.ts";
import { StorageError } from "./errors.ts";

export const ATTACHMENT_COLUMNS = "id, uploader, name, content_type, size, message_id, created_at, file_key";

export interface AttachmentRow {
  id: number;
  uploader: string;
  name: string;
  content_type: string;
  size: number;
  message_id: number | null;
  created_at: number;
  file_key: string;
}

/** An upload with the key its bytes are stored under. */
export interface StoredChatAttachment {
  attachment: ChatAttachment;
  fileKey: string;
}

export function storedAttachment(row: AttachmentRow): StoredChatAttachment {
  const uploader = parseChatAuthor(row.uploader);
  if (uploader === null) {
    throw new StorageError({
      kind: "invalid_data",
      reason: `unknown attachment uploader ${debugString(row.uploader)}`,
    });
  }
  return {
    attachment: {
      id: chatAttachmentId(row.id),
      uploader,
      name: row.name,
      contentType: row.content_type,
      size: row.size,
      messageId: row.message_id === null ? null : chatMessageId(row.message_id),
      createdAt: row.created_at,
    },
    fileKey: row.file_key,
  };
}

/**
 * Attaches the uploads `attachments` of `author` to message `message`; each must be free:
 * not on a message yet and uploaded by the same side of the chat.
 */
export function attach(
  db: Database,
  message: ChatMessageId,
  author: ChatAuthor,
  attachments: readonly ChatAttachmentId[],
): void {
  for (const attachment of attachments) {
    const free = db.run(
      `UPDATE chat_attachments SET message_id = ?2
       WHERE id = ?1 AND message_id IS NULL AND uploader = ?3`,
      [attachment, message, chatAuthorAsStr(author)],
    ).changes;
    if (free === 0) {
      const exists = db
        .query<{ 1: number }, [number]>("SELECT 1 FROM chat_attachments WHERE id = ?1")
        .get(attachment);
      throw new StorageError(
        exists === null
          ? { kind: "chat_attachment_not_found", attachment }
          : { kind: "chat_attachment_not_free", attachment },
      );
    }
  }
}

/** An upload, before a message takes it. */
export interface NewChatAttachment {
  /** The key its bytes are stored under. */
  fileKey: string;
  uploader: ChatAuthor;
  name: string;
  contentType: string;
  /** Bytes. */
  size: number;
}

/**
 * Records an upload whose bytes are stored under `upload.fileKey`; it is free until a
 * message of the same side is sent with it.
 */
export function createChatAttachment(db: Database, upload: NewChatAttachment, at: number): ChatAttachment {
  const id = chatAttachmentId(
    Number(
      db.run(
        `INSERT INTO chat_attachments (file_key, uploader, name, content_type, size, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        [upload.fileKey, chatAuthorAsStr(upload.uploader), upload.name, upload.contentType, upload.size, at],
      ).lastInsertRowid,
    ),
  );
  const created = chatAttachment(db, id);
  if (created === null) {
    throw new StorageError({ kind: "chat_attachment_not_found", attachment: id });
  }
  return created.attachment;
}

/** An upload with the key its bytes are stored under. */
export function chatAttachment(db: Database, id: ChatAttachmentId): StoredChatAttachment | null {
  const row = db
    .query<AttachmentRow, [number]>(`SELECT ${ATTACHMENT_COLUMNS} FROM chat_attachments WHERE id = ?1`)
    .get(id);
  return row === null ? null : storedAttachment(row);
}

/**
 * Forgets the uploads no message took that were made before `before`, and returns the keys
 * their bytes are stored under, for removing them.
 */
export function removeStaleChatAttachments(db: Database, before: number): string[] {
  return db.transaction(() =>
    db
      .query<{ file_key: string }, [number]>(
        `DELETE FROM chat_attachments WHERE message_id IS NULL AND created_at < ?1
         RETURNING file_key`,
      )
      .all(before)
      .map((row) => row.file_key),
  )();
}
