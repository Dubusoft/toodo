//! The chat with the agent connected over MCP, and the receipts of its work on each
//! person's message: received (`delivered_at`, `taken_at`), acknowledged (`acked_at`,
//! `seen_at`), and handled.
use rusqlite::{OptionalExtension, Row, Transaction, params};

use super::{Result, Storage, StorageError, invalid_data};
use crate::domain::chat::{ANSWER_WITHIN, ChatAuthor, ChatMessage, ChatMessageId};
use crate::domain::model::TaskId;

const COLUMNS: &str = "id, author, body, at, delivered_at, acked_at, handled_at, \
                       handled_reply_id, handled_task_id, due_at";

/// The most messages one page of the chat holds.
pub const CHAT_PAGE_LIMIT: usize = 200;

type RawMessage = (
    i64,
    String,
    String,
    i64,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
);

fn raw_row(row: &Row<'_>) -> rusqlite::Result<RawMessage> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
    ))
}

fn message(
    (id, author, body, at, delivered_at, acked_at, handled_at, reply, task, due_at): RawMessage,
) -> Result<ChatMessage> {
    let author = ChatAuthor::parse(&author)
        .ok_or_else(|| invalid_data(format!("unknown chat author {author:?}")))?;
    Ok(ChatMessage {
        id: ChatMessageId(id),
        author,
        body,
        at,
        delivered_at,
        acked_at,
        handled_at,
        handled_reply_id: reply.map(ChatMessageId),
        handled_task_id: task.map(TaskId),
        due_at,
    })
}

fn find(tx: &Transaction<'_>, id: ChatMessageId) -> Result<Option<ChatMessage>> {
    tx.query_row(
        &format!("SELECT {COLUMNS} FROM chat_messages WHERE id = ?1"),
        [id.0],
        raw_row,
    )
    .optional()?
    .map(message)
    .transpose()
}

/// A person's message, the only kind that gets receipts.
fn person_message(tx: &Transaction<'_>, id: ChatMessageId) -> Result<ChatMessage> {
    match find(tx, id)? {
        Some(found) if found.author == ChatAuthor::User => Ok(found),
        Some(_) => Err(StorageError::NotAPersonsMessage(id)),
        None => Err(StorageError::ChatMessageNotFound(id)),
    }
}

/// Marks a person's message received and acknowledged, keeping earlier receipts.
fn acknowledge(tx: &Transaction<'_>, id: ChatMessageId, now: i64) -> Result<()> {
    tx.execute(
        "UPDATE chat_messages SET
             delivered_at = coalesce(delivered_at, ?2),
             taken_at = coalesce(taken_at, ?2),
             seen_at = coalesce(seen_at, ?2),
             acked_at = coalesce(acked_at, ?2)
         WHERE id = ?1",
        params![id.0, now],
    )?;
    Ok(())
}

fn handle(
    tx: &Transaction<'_>,
    id: ChatMessageId,
    reply: Option<ChatMessageId>,
    task: Option<TaskId>,
    now: i64,
) -> Result<()> {
    person_message(tx, id)?;
    if let Some(reply) = reply {
        match find(tx, reply)? {
            Some(found) if found.author == ChatAuthor::Agent => {}
            Some(_) => return Err(StorageError::NotAnAgentsMessage(reply)),
            None => return Err(StorageError::ChatMessageNotFound(reply)),
        }
    }
    if let Some(task) = task {
        let exists = tx
            .query_row("SELECT 1 FROM tasks WHERE id = ?1", [task.0], |_| Ok(()))
            .optional()?;
        if exists.is_none() {
            return Err(StorageError::TaskNotFound(task));
        }
    }
    acknowledge(tx, id, now)?;
    tx.execute(
        "UPDATE chat_messages SET
             handled_at = coalesce(handled_at, ?2),
             handled_reply_id = coalesce(?3, handled_reply_id),
             handled_task_id = coalesce(?4, handled_task_id)
         WHERE id = ?1",
        params![id.0, now, reply.map(|r| r.0), task.map(|t| t.0)],
    )?;
    Ok(())
}

fn insert(tx: &Transaction<'_>, author: ChatAuthor, body: &str, now: i64) -> Result<ChatMessageId> {
    let due = (author == ChatAuthor::User).then_some(now + ANSWER_WITHIN);
    tx.execute(
        "INSERT INTO chat_messages (author, body, at, due_at) VALUES (?1, ?2, ?3, ?4)",
        params![author.as_str(), body, now, due],
    )?;
    Ok(ChatMessageId(tx.last_insert_rowid()))
}

impl Storage {
    /// The latest messages before `before` (all of them without it), oldest first, at
    /// most `limit` (capped at [`CHAT_PAGE_LIMIT`]).
    pub fn list_chat_messages(
        &self,
        before: Option<ChatMessageId>,
        limit: usize,
    ) -> Result<Vec<ChatMessage>> {
        let limit = limit.clamp(1, CHAT_PAGE_LIMIT) as i64;
        let mut messages = self
            .conn
            .prepare(&format!(
                "SELECT {COLUMNS} FROM chat_messages WHERE ?1 IS NULL OR id < ?1
                 ORDER BY id DESC LIMIT ?2"
            ))?
            .query_map(params![before.map(|id| id.0), limit], raw_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(message)
            .collect::<Result<Vec<_>>>()?;
        messages.reverse();
        Ok(messages)
    }

    /// Stores a person's message. A client names each message it sends, so sending it
    /// again returns the stored one instead of repeating it.
    pub fn post_user_message(&mut self, body: &str, client_id: &str) -> Result<ChatMessage> {
        let now = self.now();
        let tx = self.conn.transaction()?;
        let existing = tx
            .query_row(
                "SELECT id FROM chat_messages WHERE client_id = ?1",
                [client_id],
                |row| row.get(0),
            )
            .optional()?;
        let id = match existing {
            Some(id) => ChatMessageId(id),
            None => {
                let id = insert(&tx, ChatAuthor::User, body, now)?;
                tx.execute(
                    "UPDATE chat_messages SET client_id = ?2 WHERE id = ?1",
                    params![id.0, client_id],
                )?;
                id
            }
        };
        let stored = find(&tx, id)?.ok_or(StorageError::ChatMessageNotFound(id))?;
        tx.commit()?;
        Ok(stored)
    }

    /// Stores the agent's message and marks the person's messages it answers handled by
    /// it, all or nothing.
    pub fn post_agent_message(
        &mut self,
        body: &str,
        handles: &[ChatMessageId],
    ) -> Result<ChatMessage> {
        let now = self.now();
        let tx = self.conn.transaction()?;
        let id = insert(&tx, ChatAuthor::Agent, body, now)?;
        for answered in handles {
            handle(&tx, *answered, Some(id), None, now)?;
        }
        let stored = find(&tx, id)?.ok_or(StorageError::ChatMessageNotFound(id))?;
        tx.commit()?;
        Ok(stored)
    }

    /// The person's messages the agent has not received yet, oldest first. `take` marks
    /// them received, so the next call returns only newer ones.
    pub fn pending_chat_messages(&mut self, take: bool) -> Result<Vec<ChatMessage>> {
        let now = self.now();
        let tx = self.conn.transaction()?;
        let ids: Vec<i64> = tx
            .prepare(
                "SELECT id FROM chat_messages WHERE author = 'user' AND taken_at IS NULL
                 ORDER BY id",
            )?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        if take {
            for id in &ids {
                tx.execute(
                    "UPDATE chat_messages SET taken_at = ?2, delivered_at = coalesce(delivered_at, ?2)
                     WHERE id = ?1",
                    params![id, now],
                )?;
            }
        }
        let messages = ids
            .into_iter()
            .map(|id| {
                find(&tx, ChatMessageId(id))?
                    .ok_or(StorageError::ChatMessageNotFound(ChatMessageId(id)))
            })
            .collect::<Result<Vec<_>>>()?;
        tx.commit()?;
        Ok(messages)
    }

    /// Acknowledges a person's messages, all or nothing; acknowledging one again keeps its
    /// first receipt.
    pub fn ack_chat_messages(&mut self, ids: &[ChatMessageId]) -> Result<Vec<ChatMessage>> {
        let now = self.now();
        let tx = self.conn.transaction()?;
        let mut acked = Vec::with_capacity(ids.len());
        for id in ids {
            person_message(&tx, *id)?;
            acknowledge(&tx, *id, now)?;
            acked.push(find(&tx, *id)?.ok_or(StorageError::ChatMessageNotFound(*id))?);
        }
        tx.commit()?;
        Ok(acked)
    }

    /// Marks a person's message handled, by the agent's reply or a task made for it, and
    /// acknowledged if it was not yet.
    pub fn mark_chat_handled(
        &mut self,
        id: ChatMessageId,
        reply: Option<ChatMessageId>,
        task: Option<TaskId>,
    ) -> Result<ChatMessage> {
        let now = self.now();
        let tx = self.conn.transaction()?;
        handle(&tx, id, reply, task, now)?;
        let stored = find(&tx, id)?.ok_or(StorageError::ChatMessageNotFound(id))?;
        tx.commit()?;
        Ok(stored)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn storage_at(now: i64) -> Storage {
        let mut storage = Storage::open_in_memory().unwrap();
        storage.set_clock(move || now);
        storage
    }

    #[test]
    fn a_resent_message_is_stored_once_and_gets_a_due_time() {
        let mut storage = storage_at(100);
        let first = storage.post_user_message("Hi", "c1").unwrap();
        let again = storage.post_user_message("Hi", "c1").unwrap();
        assert_eq!(first, again);
        assert_eq!(first.author, ChatAuthor::User);
        assert_eq!(first.due_at, Some(100 + ANSWER_WITHIN));
        assert_eq!(storage.list_chat_messages(None, 50).unwrap(), [first]);
    }

    #[test]
    fn taking_pending_messages_marks_them_received_once() {
        let mut storage = storage_at(100);
        let hi = storage.post_user_message("Hi", "c1").unwrap();
        storage.post_agent_message("Hello", &[]).unwrap();
        let peeked = storage.pending_chat_messages(false).unwrap();
        assert_eq!(peeked.iter().map(|m| m.id).collect::<Vec<_>>(), [hi.id]);
        assert_eq!(peeked[0].delivered_at, None);
        let taken = storage.pending_chat_messages(true).unwrap();
        assert_eq!(taken[0].delivered_at, Some(100));
        assert!(storage.pending_chat_messages(true).unwrap().is_empty());
    }

    #[test]
    fn a_reply_handles_the_messages_it_answers_and_acknowledges_them() {
        let mut storage = storage_at(100);
        let hi = storage.post_user_message("Hi", "c1").unwrap();
        let reply = storage.post_agent_message("Hello", &[hi.id]).unwrap();
        assert_eq!(reply.author, ChatAuthor::Agent);
        assert_eq!(reply.due_at, None);
        let handled = &storage.list_chat_messages(None, 50).unwrap()[0];
        assert_eq!(
            (
                handled.acked_at,
                handled.handled_at,
                handled.handled_reply_id
            ),
            (Some(100), Some(100), Some(reply.id))
        );
        assert!(!handled.overdue(100 + ANSWER_WITHIN));
    }

    #[test]
    fn receipts_go_only_on_existing_messages_of_people() {
        let mut storage = storage_at(100);
        let hi = storage.post_user_message("Hi", "c1").unwrap();
        let reply = storage.post_agent_message("Hello", &[]).unwrap();
        assert!(matches!(
            storage.ack_chat_messages(&[hi.id, reply.id]),
            Err(StorageError::NotAPersonsMessage(id)) if id == reply.id
        ));
        // The batch failed as a whole, so the first message stays unacknowledged.
        assert_eq!(
            storage.list_chat_messages(None, 50).unwrap()[0].acked_at,
            None
        );
        assert!(matches!(
            storage.mark_chat_handled(ChatMessageId(99), None, None),
            Err(StorageError::ChatMessageNotFound(ChatMessageId(99)))
        ));
        assert!(matches!(
            storage.mark_chat_handled(hi.id, Some(hi.id), None),
            Err(StorageError::NotAnAgentsMessage(id)) if id == hi.id
        ));
        assert!(matches!(
            storage.mark_chat_handled(hi.id, None, Some(TaskId(42))),
            Err(StorageError::TaskNotFound(TaskId(42)))
        ));
        assert!(matches!(
            storage.post_agent_message("Hello", &[ChatMessageId(99)]),
            Err(StorageError::ChatMessageNotFound(_))
        ));
        assert_eq!(storage.list_chat_messages(None, 50).unwrap().len(), 2);
    }

    #[test]
    fn acknowledging_again_keeps_the_first_receipt() {
        let mut storage = storage_at(100);
        let hi = storage.post_user_message("Hi", "c1").unwrap();
        storage.ack_chat_messages(&[hi.id]).unwrap();
        storage.set_clock(|| 200);
        let again = storage.ack_chat_messages(&[hi.id]).unwrap();
        assert_eq!(
            (again[0].delivered_at, again[0].acked_at),
            (Some(100), Some(100))
        );
        let handled = storage.mark_chat_handled(hi.id, None, None).unwrap();
        assert_eq!(
            (handled.acked_at, handled.handled_at),
            (Some(100), Some(200))
        );
    }

    #[test]
    fn pages_hold_the_latest_messages_before_a_message_oldest_first() {
        let mut storage = storage_at(100);
        let ids: Vec<_> = (0..5)
            .map(|n| {
                storage
                    .post_user_message(&format!("m{n}"), &format!("c{n}"))
                    .unwrap()
                    .id
            })
            .collect();
        let latest = storage.list_chat_messages(None, 2).unwrap();
        assert_eq!(latest.iter().map(|m| m.id).collect::<Vec<_>>(), ids[3..]);
        let earlier = storage.list_chat_messages(Some(ids[3]), 2).unwrap();
        assert_eq!(earlier.iter().map(|m| m.id).collect::<Vec<_>>(), ids[1..3]);
    }

    #[test]
    fn messages_of_the_earlier_lead_chat_read_as_the_agent_and_the_system() {
        let storage = storage_at(100);
        storage
            .connection()
            .execute_batch(
                "INSERT INTO chat_messages (author, body, at) VALUES ('lead', 'Earlier', 1);
                 INSERT INTO chat_messages (author, body, at) VALUES ('system', 'Task #1 done', 2);",
            )
            .unwrap();
        let messages = storage.list_chat_messages(None, 50).unwrap();
        assert_eq!(
            messages.iter().map(|m| m.author).collect::<Vec<_>>(),
            [ChatAuthor::Agent, ChatAuthor::System]
        );
    }
}
