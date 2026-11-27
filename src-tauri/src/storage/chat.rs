//! The chat with the agent connected over MCP: its channels and the threads under them, how
//! far people read each, and the receipts of the agent's work on each person's message:
//! received (`delivered_at`, `taken_at`), acknowledged (`acked_at`, `seen_at`), and handled;
//! the actions on the agent's messages with the choice a person made, and the files
//! attached to messages, whose bytes the server keeps on disk under `file_key`.
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params};

use super::{Result, Storage, StorageError, invalid_data};
use crate::domain::chat::{
    ANSWER_WITHIN, ActionStyle, ChatAction, ChatAttachment, ChatAttachmentId, ChatAuthor,
    ChatChannel, ChatChannelId, ChatChoice, ChatMessage, ChatMessageId, ChatPlace, ChatThread,
    ChatThreadId, ChoiceOf, FIRST_CHANNEL, ThreadStatus,
};
use crate::domain::model::TaskId;

const COLUMNS: &str = "id, author, body, at, delivered_at, acked_at, handled_at, \
                       handled_reply_id, handled_task_id, due_at, channel_id, thread_id";

/// The most messages one page of the chat holds.
pub const CHAT_PAGE_LIMIT: usize = 200;

/// A message row before its author is parsed.
struct RawMessage {
    message: ChatMessage,
    author: String,
}

fn raw_row(row: &Row<'_>) -> rusqlite::Result<RawMessage> {
    Ok(RawMessage {
        author: row.get(1)?,
        message: ChatMessage {
            id: ChatMessageId(row.get(0)?),
            channel_id: ChatChannelId(row.get(10)?),
            thread_id: row.get::<_, Option<i64>>(11)?.map(ChatThreadId),
            author: ChatAuthor::User,
            body: row.get(2)?,
            at: row.get(3)?,
            delivered_at: row.get(4)?,
            acked_at: row.get(5)?,
            handled_at: row.get(6)?,
            handled_reply_id: row.get::<_, Option<i64>>(7)?.map(ChatMessageId),
            handled_task_id: row.get::<_, Option<i64>>(8)?.map(TaskId),
            due_at: row.get(9)?,
            actions: Vec::new(),
            chosen: None,
            choice_of: None,
            attachments: Vec::new(),
        },
    })
}

/// The IDs of `messages` as a JSON array, for `json_each`.
fn ids_json(messages: &[ChatMessage]) -> String {
    let ids: Vec<String> = messages.iter().map(|m| m.id.0.to_string()).collect();
    format!("[{}]", ids.join(","))
}

const ATTACHMENT_COLUMNS: &str =
    "id, uploader, name, content_type, size, message_id, created_at, file_key";

/// An attachment row, with the key its file is stored under.
fn attachment_row(row: &Row<'_>) -> rusqlite::Result<(ChatAttachment, String, String)> {
    Ok((
        ChatAttachment {
            id: ChatAttachmentId(row.get(0)?),
            uploader: ChatAuthor::User,
            name: row.get(2)?,
            content_type: row.get(3)?,
            size: row.get(4)?,
            message_id: row.get::<_, Option<i64>>(5)?.map(ChatMessageId),
            created_at: row.get(6)?,
        },
        row.get(1)?,
        row.get(7)?,
    ))
}

fn attachment(
    (attachment, uploader, file_key): (ChatAttachment, String, String),
) -> Result<(ChatAttachment, String)> {
    let uploader = ChatAuthor::parse(&uploader)
        .ok_or_else(|| invalid_data(format!("unknown attachment uploader {uploader:?}")))?;
    Ok((
        ChatAttachment {
            uploader,
            ..attachment
        },
        file_key,
    ))
}

/// Fills in the actions, choices, and attachments of `messages`.
fn decorate(conn: &Connection, messages: &mut [ChatMessage]) -> Result<()> {
    if messages.is_empty() {
        return Ok(());
    }
    let ids = ids_json(messages);
    let at = |messages: &mut [ChatMessage], id: i64| -> Option<usize> {
        messages.iter().position(|m| m.id.0 == id)
    };
    let actions = conn
        .prepare_cached(
            "SELECT message_id, key, label, style FROM chat_actions
             WHERE message_id IN (SELECT value FROM json_each(?1)) ORDER BY message_id, position",
        )?
        .query_map([&ids], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (message, key, label, style) in actions {
        let style = ActionStyle::parse(&style)
            .ok_or_else(|| invalid_data(format!("unknown action style {style:?}")))?;
        if let Some(index) = at(messages, message) {
            messages[index]
                .actions
                .push(ChatAction { key, label, style });
        }
    }
    let choices = conn
        .prepare_cached(
            "SELECT message_id, key, choice_id, at FROM chat_choices
             WHERE message_id IN (SELECT value FROM json_each(?1))
                OR choice_id IN (SELECT value FROM json_each(?1))",
        )?
        .query_map([&ids], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (message, key, choice, chosen_at) in choices {
        if let Some(index) = at(messages, message) {
            messages[index].chosen = Some(ChatChoice {
                key: key.clone(),
                at: chosen_at,
                choice_id: ChatMessageId(choice),
            });
        }
        if let Some(index) = at(messages, choice) {
            messages[index].choice_of = Some(ChoiceOf {
                message_id: ChatMessageId(message),
                key,
            });
        }
    }
    let attachments = conn
        .prepare_cached(&format!(
            "SELECT {ATTACHMENT_COLUMNS} FROM chat_attachments
             WHERE message_id IN (SELECT value FROM json_each(?1)) ORDER BY id"
        ))?
        .query_map([&ids], attachment_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for row in attachments {
        let (attachment, _) = attachment(row)?;
        if let Some(index) = attachment.message_id.and_then(|m| at(messages, m.0)) {
            messages[index].attachments.push(attachment);
        }
    }
    Ok(())
}

/// The messages with IDs `ids`, decorated, in that order.
pub(super) fn messages_by_id(conn: &Connection, ids: &[i64]) -> Result<Vec<ChatMessage>> {
    let mut messages = ids
        .iter()
        .map(|id| {
            conn.query_row(
                &format!("SELECT {COLUMNS} FROM chat_messages WHERE id = ?1"),
                [id],
                raw_row,
            )
            .map_err(StorageError::from)
            .and_then(message)
        })
        .collect::<Result<Vec<_>>>()?;
    decorate(conn, &mut messages)?;
    Ok(messages)
}

/// Attaches the uploads `attachments` of `author` to message `id`; each must be free: not on
/// a message yet and uploaded by the same side of the chat.
fn attach(
    tx: &Transaction<'_>,
    id: ChatMessageId,
    author: ChatAuthor,
    attachments: &[ChatAttachmentId],
) -> Result<()> {
    for attachment in attachments {
        let free = tx.execute(
            "UPDATE chat_attachments SET message_id = ?2
             WHERE id = ?1 AND message_id IS NULL AND uploader = ?3",
            params![attachment.0, id.0, author.as_str()],
        )?;
        if free == 0 {
            let exists = tx
                .query_row(
                    "SELECT 1 FROM chat_attachments WHERE id = ?1",
                    [attachment.0],
                    |_| Ok(()),
                )
                .optional()?;
            return Err(match exists {
                Some(()) => StorageError::ChatAttachmentNotFree(*attachment),
                None => StorageError::ChatAttachmentNotFound(*attachment),
            });
        }
    }
    Ok(())
}

fn message(raw: RawMessage) -> Result<ChatMessage> {
    let author = ChatAuthor::parse(&raw.author)
        .ok_or_else(|| invalid_data(format!("unknown chat author {:?}", raw.author)))?;
    Ok(ChatMessage {
        author,
        ..raw.message
    })
}

fn find(tx: &Transaction<'_>, id: ChatMessageId) -> Result<Option<ChatMessage>> {
    let Some(mut found) = tx
        .query_row(
            &format!("SELECT {COLUMNS} FROM chat_messages WHERE id = ?1"),
            [id.0],
            raw_row,
        )
        .optional()?
        .map(message)
        .transpose()?
    else {
        return Ok(None);
    };
    decorate(tx, std::slice::from_mut(&mut found))?;
    Ok(Some(found))
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
        task_exists(tx, task)?;
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

fn task_exists(tx: &Transaction<'_>, task: TaskId) -> Result<()> {
    tx.query_row("SELECT 1 FROM tasks WHERE id = ?1", [task.0], |_| Ok(()))
        .optional()?
        .ok_or(StorageError::TaskNotFound(task))
}

fn channel_exists(tx: &Transaction<'_>, channel: ChatChannelId) -> Result<()> {
    tx.query_row(
        "SELECT 1 FROM chat_channels WHERE id = ?1",
        [channel.0],
        |_| Ok(()),
    )
    .optional()?
    .ok_or(StorageError::ChatChannelNotFound(channel))
}

/// The channel of thread `thread` and its status.
fn thread_place(
    tx: &Transaction<'_>,
    thread: ChatThreadId,
) -> Result<(ChatChannelId, ThreadStatus)> {
    let (channel, status): (i64, String) = tx
        .query_row(
            "SELECT channel_id, status FROM chat_threads WHERE id = ?1",
            [thread.0],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or(StorageError::ChatThreadNotFound(thread))?;
    Ok((ChatChannelId(channel), thread_status(&status)?))
}

fn thread_status(stored: &str) -> Result<ThreadStatus> {
    ThreadStatus::parse(stored)
        .ok_or_else(|| invalid_data(format!("unknown thread status {stored:?}")))
}

/// The channel and thread of `place`, which must exist.
fn locate(tx: &Transaction<'_>, place: ChatPlace) -> Result<(ChatChannelId, Option<ChatThreadId>)> {
    match place {
        ChatPlace::Channel(channel) => {
            channel_exists(tx, channel)?;
            Ok((channel, None))
        }
        ChatPlace::Thread(thread) => Ok((thread_place(tx, thread)?.0, Some(thread))),
    }
}

/// The channel and thread a message may be posted to: an existing channel, or a thread
/// that is open.
fn open_place(
    tx: &Transaction<'_>,
    place: ChatPlace,
) -> Result<(ChatChannelId, Option<ChatThreadId>)> {
    if let ChatPlace::Thread(thread) = place {
        let (channel, status) = thread_place(tx, thread)?;
        if status != ThreadStatus::Open {
            return Err(StorageError::ChatThreadNotOpen { thread, status });
        }
        return Ok((channel, Some(thread)));
    }
    locate(tx, place)
}

fn insert(
    tx: &Transaction<'_>,
    (channel, thread): (ChatChannelId, Option<ChatThreadId>),
    author: ChatAuthor,
    body: &str,
    now: i64,
) -> Result<ChatMessageId> {
    let due = (author == ChatAuthor::User).then_some(now + ANSWER_WITHIN);
    tx.execute(
        "INSERT INTO chat_messages (author, body, at, due_at, channel_id, thread_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            author.as_str(),
            body,
            now,
            due,
            channel.0,
            thread.map(|t| t.0)
        ],
    )?;
    Ok(ChatMessageId(tx.last_insert_rowid()))
}

/// Messages of the agent and Toodo count as unread; people's own never do.
const CHANNEL_SELECT: &str = "SELECT c.id, c.name, c.push, c.created_at,
         (SELECT count(*) FROM chat_messages m
          WHERE m.channel_id = c.id AND m.thread_id IS NULL AND m.author <> 'user'
            AND m.id > c.read_id)
       + (SELECT count(*) FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
          WHERE t.channel_id = c.id AND t.status <> 'archived' AND m.author <> 'user'
            AND m.id > t.read_id)
     FROM chat_channels c";

fn channel_row(row: &Row<'_>) -> rusqlite::Result<ChatChannel> {
    Ok(ChatChannel {
        id: ChatChannelId(row.get(0)?),
        name: row.get(1)?,
        push: row.get(2)?,
        created_at: row.get(3)?,
        unread: row.get(4)?,
    })
}

fn find_channel(tx: &Transaction<'_>, id: ChatChannelId) -> Result<ChatChannel> {
    tx.query_row(
        &format!("{CHANNEL_SELECT} WHERE c.id = ?1"),
        [id.0],
        channel_row,
    )
    .optional()?
    .ok_or(StorageError::ChatChannelNotFound(id))
}

/// Refuses a channel name another channel has, ignoring case.
fn name_free(tx: &Transaction<'_>, name: &str, except: Option<ChatChannelId>) -> Result<()> {
    let taken = tx
        .query_row(
            "SELECT 1 FROM chat_channels WHERE name = ?1 COLLATE NOCASE AND id IS NOT ?2",
            params![name, except.map(|c| c.0)],
            |_| Ok(()),
        )
        .optional()?;
    match taken {
        Some(()) => Err(StorageError::ChatChannelNameTaken(name.to_owned())),
        None => Ok(()),
    }
}

const THREAD_SELECT: &str = "SELECT t.id, t.channel_id, t.title, t.task_id, t.status,
         t.created_at, t.closed_at, t.archived_at,
         (SELECT count(*) FROM chat_messages m
          WHERE m.thread_id = t.id AND m.author <> 'user' AND m.id > t.read_id),
         (SELECT max(m.at) FROM chat_messages m WHERE m.thread_id = t.id) AS last_at
     FROM chat_threads t";

type RawThread = (ChatThread, String);

fn thread_row(row: &Row<'_>) -> rusqlite::Result<RawThread> {
    Ok((
        ChatThread {
            id: ChatThreadId(row.get(0)?),
            channel_id: ChatChannelId(row.get(1)?),
            title: row.get(2)?,
            task_id: row.get::<_, Option<i64>>(3)?.map(TaskId),
            status: ThreadStatus::Open,
            created_at: row.get(5)?,
            closed_at: row.get(6)?,
            archived_at: row.get(7)?,
            unread: row.get(8)?,
            last_message_at: row.get(9)?,
        },
        row.get(4)?,
    ))
}

fn thread((thread, status): RawThread) -> Result<ChatThread> {
    Ok(ChatThread {
        status: thread_status(&status)?,
        ..thread
    })
}

fn find_thread(tx: &Transaction<'_>, id: ChatThreadId) -> Result<ChatThread> {
    tx.query_row(
        &format!("{THREAD_SELECT} WHERE t.id = ?1"),
        [id.0],
        thread_row,
    )
    .optional()?
    .map(thread)
    .transpose()?
    .ok_or(StorageError::ChatThreadNotFound(id))
}

/// Which threads to list. Archived threads are left out unless `archived` is set.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ThreadFilter {
    pub channel: Option<ChatChannelId>,
    pub task: Option<TaskId>,
    pub archived: bool,
}

/// What changes on a channel; `None` keeps a field.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChannelEdit {
    pub name: Option<String>,
    pub push: Option<bool>,
}

/// What changes on a thread; `None` keeps a field, and `task: Some(None)` unlinks its task.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ThreadEdit {
    pub title: Option<String>,
    pub status: Option<ThreadStatus>,
    pub task: Option<Option<TaskId>>,
}

/// How a notification names where the agent posted, when the channel lets it notify.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatNotice {
    pub channel: String,
    pub thread: Option<String>,
}

impl Storage {
    /// The latest messages in `place` (in every channel and thread without it) before
    /// `before` (all of them without it), oldest first, at most `limit` (capped at
    /// [`CHAT_PAGE_LIMIT`]). A channel holds its own messages, not those of its threads.
    pub fn list_chat_messages(
        &self,
        place: Option<ChatPlace>,
        before: Option<ChatMessageId>,
        limit: usize,
    ) -> Result<Vec<ChatMessage>> {
        let limit = limit.clamp(1, CHAT_PAGE_LIMIT) as i64;
        let (channel, thread) = match place {
            None => (None, None),
            Some(ChatPlace::Channel(channel)) => (Some(channel.0), None),
            Some(ChatPlace::Thread(thread)) => (None, Some(thread.0)),
        };
        let mut messages = self
            .conn
            .prepare(&format!(
                "SELECT {COLUMNS} FROM chat_messages
                 WHERE (?1 IS NULL OR id < ?1)
                   AND (?2 IS NULL OR (channel_id = ?2 AND thread_id IS NULL))
                   AND (?3 IS NULL OR thread_id = ?3)
                 ORDER BY id DESC LIMIT ?4"
            ))?
            .query_map(
                params![before.map(|id| id.0), channel, thread, limit],
                raw_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(message)
            .collect::<Result<Vec<_>>>()?;
        messages.reverse();
        decorate(&self.conn, &mut messages)?;
        Ok(messages)
    }

    /// Stores a person's message in `place`, which must exist and, for a thread, be open,
    /// with the person's free uploads `attachments`. A client names each message it sends,
    /// so sending it again returns the stored one instead of repeating it.
    pub fn post_user_message(
        &mut self,
        place: ChatPlace,
        body: &str,
        client_id: &str,
        attachments: &[ChatAttachmentId],
    ) -> Result<ChatMessage> {
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
                let at = open_place(&tx, place)?;
                let id = insert(&tx, at, ChatAuthor::User, body, now)?;
                tx.execute(
                    "UPDATE chat_messages SET client_id = ?2 WHERE id = ?1",
                    params![id.0, client_id],
                )?;
                attach(&tx, id, ChatAuthor::User, attachments)?;
                id
            }
        };
        let stored = find(&tx, id)?.ok_or(StorageError::ChatMessageNotFound(id))?;
        tx.commit()?;
        Ok(stored)
    }

    /// Stores the agent's message, with the actions it offers and its free uploads
    /// `attachments`, and marks the person's messages it answers handled by it, all or
    /// nothing. Without `place` it goes where the first message it answers is, or to the
    /// first channel. Action keys are unique within the message.
    pub fn post_agent_message(
        &mut self,
        place: Option<ChatPlace>,
        body: &str,
        handles: &[ChatMessageId],
        actions: &[ChatAction],
        attachments: &[ChatAttachmentId],
    ) -> Result<ChatMessage> {
        let now = self.now();
        let tx = self.conn.transaction()?;
        let place = match (place, handles.first()) {
            (Some(place), _) => place,
            (None, Some(first)) => {
                let answered = person_message(&tx, *first)?;
                answered
                    .thread_id
                    .map_or(ChatPlace::Channel(answered.channel_id), ChatPlace::Thread)
            }
            (None, None) => ChatPlace::Channel(FIRST_CHANNEL),
        };
        let at = open_place(&tx, place)?;
        let id = insert(&tx, at, ChatAuthor::Agent, body, now)?;
        for (position, action) in actions.iter().enumerate() {
            tx.execute(
                "INSERT INTO chat_actions (message_id, position, key, label, style)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    id.0,
                    position as i64,
                    action.key,
                    action.label,
                    action.style.as_str()
                ],
            )?;
        }
        attach(&tx, id, ChatAuthor::Agent, attachments)?;
        for answered in handles {
            handle(&tx, *answered, Some(id), None, now)?;
        }
        let stored = find(&tx, id)?.ok_or(StorageError::ChatMessageNotFound(id))?;
        tx.commit()?;
        Ok(stored)
    }

    /// Records that a person chose the action `key` on the agent's message `message`, as
    /// a person's message in the same place whose body is the action's label, so the agent
    /// receives it like any other message. A message takes one choice, and only while its
    /// place takes messages. `client_id` names the click, so sending it again returns the
    /// stored choice. Returns the person's message and the agent's message with its choice.
    pub fn choose_chat_action(
        &mut self,
        message: ChatMessageId,
        key: &str,
        client_id: &str,
    ) -> Result<(ChatMessage, ChatMessage)> {
        let now = self.now();
        let tx = self.conn.transaction()?;
        let existing: Option<i64> = tx
            .query_row(
                "SELECT id FROM chat_messages WHERE client_id = ?1",
                [client_id],
                |row| row.get(0),
            )
            .optional()?;
        let choice = match existing {
            Some(id) => ChatMessageId(id),
            None => {
                let offered = match find(&tx, message)? {
                    Some(found) if found.author == ChatAuthor::Agent => found,
                    Some(_) => return Err(StorageError::NotAnAgentsMessage(message)),
                    None => return Err(StorageError::ChatMessageNotFound(message)),
                };
                if let Some(chosen) = &offered.chosen {
                    return Err(StorageError::ChatActionChosen {
                        message,
                        key: chosen.key.clone(),
                    });
                }
                let action = offered
                    .actions
                    .iter()
                    .find(|action| action.key == key)
                    .ok_or_else(|| StorageError::ChatActionNotFound {
                        message,
                        key: key.to_owned(),
                    })?;
                let place = offered
                    .thread_id
                    .map_or(ChatPlace::Channel(offered.channel_id), ChatPlace::Thread);
                let at = open_place(&tx, place)?;
                let choice = insert(&tx, at, ChatAuthor::User, &action.label, now)?;
                tx.execute(
                    "UPDATE chat_messages SET client_id = ?2 WHERE id = ?1",
                    params![choice.0, client_id],
                )?;
                tx.execute(
                    "INSERT INTO chat_choices (message_id, key, choice_id, at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![message.0, key, choice.0, now],
                )?;
                choice
            }
        };
        let recorded = find(&tx, choice)?.ok_or(StorageError::ChatMessageNotFound(choice))?;
        let offered = recorded
            .choice_of
            .as_ref()
            .map(|of| of.message_id)
            .ok_or_else(|| {
                invalid_data(format!(
                    "client id {client_id:?} names a message, not a choice"
                ))
            })?;
        let offered = find(&tx, offered)?.ok_or(StorageError::ChatMessageNotFound(offered))?;
        tx.commit()?;
        Ok((recorded, offered))
    }

    /// Records an upload of `uploader` whose bytes are stored under `file_key`; it is free
    /// until a message of the same side is sent with it.
    pub fn create_chat_attachment(
        &mut self,
        file_key: &str,
        uploader: ChatAuthor,
        name: &str,
        content_type: &str,
        size: i64,
    ) -> Result<ChatAttachment> {
        let now = self.now();
        self.conn.execute(
            "INSERT INTO chat_attachments (file_key, uploader, name, content_type, size, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![file_key, uploader.as_str(), name, content_type, size, now],
        )?;
        let id = ChatAttachmentId(self.conn.last_insert_rowid());
        Ok(self
            .chat_attachment(id)?
            .ok_or(StorageError::ChatAttachmentNotFound(id))?
            .0)
    }

    /// An upload with the key its bytes are stored under.
    pub fn chat_attachment(
        &self,
        id: ChatAttachmentId,
    ) -> Result<Option<(ChatAttachment, String)>> {
        self.conn
            .query_row(
                &format!("SELECT {ATTACHMENT_COLUMNS} FROM chat_attachments WHERE id = ?1"),
                [id.0],
                attachment_row,
            )
            .optional()?
            .map(attachment)
            .transpose()
    }

    /// Forgets the uploads no message took that were made before `before`, and returns the
    /// keys their bytes are stored under, for removing them.
    pub fn remove_stale_chat_attachments(&mut self, before: i64) -> Result<Vec<String>> {
        let tx = self.conn.transaction()?;
        let keys = tx
            .prepare(
                "DELETE FROM chat_attachments WHERE message_id IS NULL AND created_at < ?1
                 RETURNING file_key",
            )?
            .query_map([before], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        tx.commit()?;
        Ok(keys)
    }

    /// The person's messages the agent has not received yet, in every channel and thread,
    /// oldest first. `take` marks them received, so the next call returns only newer ones.
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

    /// Every channel in the order they were made, with its unread count.
    pub fn list_chat_channels(&self) -> Result<Vec<ChatChannel>> {
        Ok(self
            .conn
            .prepare(&format!("{CHANNEL_SELECT} ORDER BY c.id"))?
            .query_map([], channel_row)?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// Makes a channel named `name`, which no other channel has in any case.
    pub fn create_chat_channel(&mut self, name: &str) -> Result<ChatChannel> {
        let now = self.now();
        let tx = self.conn.transaction()?;
        name_free(&tx, name, None)?;
        tx.execute(
            "INSERT INTO chat_channels (name, created_at) VALUES (?1, ?2)",
            params![name, now],
        )?;
        let created = find_channel(&tx, ChatChannelId(tx.last_insert_rowid()))?;
        tx.commit()?;
        Ok(created)
    }

    /// Renames a channel or turns its notifications on or off.
    pub fn update_chat_channel(
        &mut self,
        id: ChatChannelId,
        edit: &ChannelEdit,
    ) -> Result<ChatChannel> {
        let tx = self.conn.transaction()?;
        channel_exists(&tx, id)?;
        if let Some(name) = &edit.name {
            name_free(&tx, name, Some(id))?;
        }
        tx.execute(
            "UPDATE chat_channels SET name = coalesce(?2, name), push = coalesce(?3, push)
             WHERE id = ?1",
            params![id.0, edit.name, edit.push],
        )?;
        let updated = find_channel(&tx, id)?;
        tx.commit()?;
        Ok(updated)
    }

    /// The threads `filter` selects, the latest active first.
    pub fn list_chat_threads(&self, filter: ThreadFilter) -> Result<Vec<ChatThread>> {
        self.conn
            .prepare(&format!(
                "SELECT * FROM ({THREAD_SELECT}
                     WHERE (?1 IS NULL OR t.channel_id = ?1) AND (?2 IS NULL OR t.task_id = ?2)
                       AND (?3 OR t.status <> 'archived'))
                 ORDER BY coalesce(last_at, created_at) DESC, id DESC"
            ))?
            .query_map(
                params![
                    filter.channel.map(|c| c.0),
                    filter.task.map(|t| t.0),
                    filter.archived
                ],
                thread_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(thread)
            .collect()
    }

    /// Opens a thread titled `title` under `channel`, following `task` if given.
    pub fn create_chat_thread(
        &mut self,
        channel: ChatChannelId,
        title: &str,
        task: Option<TaskId>,
    ) -> Result<ChatThread> {
        let now = self.now();
        let tx = self.conn.transaction()?;
        channel_exists(&tx, channel)?;
        if let Some(task) = task {
            task_exists(&tx, task)?;
        }
        tx.execute(
            "INSERT INTO chat_threads (channel_id, title, task_id, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![channel.0, title, task.map(|t| t.0), now],
        )?;
        let created = find_thread(&tx, ChatThreadId(tx.last_insert_rowid()))?;
        tx.commit()?;
        Ok(created)
    }

    /// Retitles a thread, links or unlinks its task, or opens, closes, or archives it.
    /// Closing keeps the time it was first closed, and reopening clears both times.
    pub fn update_chat_thread(
        &mut self,
        id: ChatThreadId,
        edit: &ThreadEdit,
    ) -> Result<ChatThread> {
        let now = self.now();
        let tx = self.conn.transaction()?;
        thread_place(&tx, id)?;
        if let Some(Some(task)) = edit.task {
            task_exists(&tx, task)?;
        }
        if let Some(title) = &edit.title {
            tx.execute(
                "UPDATE chat_threads SET title = ?2 WHERE id = ?1",
                params![id.0, title],
            )?;
        }
        if let Some(task) = edit.task {
            tx.execute(
                "UPDATE chat_threads SET task_id = ?2 WHERE id = ?1",
                params![id.0, task.map(|t| t.0)],
            )?;
        }
        if let Some(status) = edit.status {
            let open = status == ThreadStatus::Open;
            let archived = status == ThreadStatus::Archived;
            tx.execute(
                "UPDATE chat_threads SET status = ?2,
                     closed_at = CASE WHEN ?3 THEN NULL ELSE coalesce(closed_at, ?5) END,
                     archived_at = CASE WHEN ?4 THEN coalesce(archived_at, ?5) ELSE NULL END
                 WHERE id = ?1",
                params![id.0, status.as_str(), open, archived, now],
            )?;
        }
        let updated = find_thread(&tx, id)?;
        tx.commit()?;
        Ok(updated)
    }

    /// Records that people read `place` up to message `up_to`; reading back never lowers it.
    pub fn mark_chat_read(&mut self, place: ChatPlace, up_to: ChatMessageId) -> Result<()> {
        let tx = self.conn.transaction()?;
        locate(&tx, place)?;
        match place {
            ChatPlace::Channel(channel) => tx.execute(
                "UPDATE chat_channels SET read_id = max(read_id, ?2) WHERE id = ?1",
                params![channel.0, up_to.0],
            )?,
            ChatPlace::Thread(thread) => tx.execute(
                "UPDATE chat_threads SET read_id = max(read_id, ?2) WHERE id = ?1",
                params![thread.0, up_to.0],
            )?,
        };
        tx.commit()?;
        Ok(())
    }

    /// How a notification of a message in `channel` and `thread` names where it is, or
    /// `None` when that channel's notifications are off.
    pub fn chat_notice(
        &self,
        channel: ChatChannelId,
        thread: Option<ChatThreadId>,
    ) -> Result<Option<ChatNotice>> {
        let (name, push): (String, bool) = self
            .conn
            .query_row(
                "SELECT name, push FROM chat_channels WHERE id = ?1",
                [channel.0],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or(StorageError::ChatChannelNotFound(channel))?;
        if !push {
            return Ok(None);
        }
        let thread = thread
            .map(|thread| {
                self.conn.query_row(
                    "SELECT title FROM chat_threads WHERE id = ?1",
                    [thread.0],
                    |row| row.get(0),
                )
            })
            .transpose()?;
        Ok(Some(ChatNotice {
            channel: name,
            thread,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GENERAL: ChatPlace = ChatPlace::Channel(FIRST_CHANNEL);

    fn storage_at(now: i64) -> Storage {
        let mut storage = Storage::open_in_memory().unwrap();
        storage.set_clock(move || now);
        storage
    }

    fn task(storage: &mut Storage) -> TaskId {
        let workspace = storage
            .create_workspace(&crate::storage::NewWorkspace {
                name: "toodo".to_owned(),
                description: None,
                repository: None,
            })
            .unwrap();
        storage
            .create_task(&crate::storage::NewTask {
                workspace_id: workspace.id,
                task_type: crate::domain::model::TaskType::Feat,
                title: "Ship".to_owned(),
                description: String::new(),
                estimate: None,
                due_date: None,
                autopilot: false,
                criteria: Vec::new(),
            })
            .unwrap()
            .id
    }

    #[test]
    fn a_resent_message_is_stored_once_and_gets_a_due_time() {
        let mut storage = storage_at(100);
        let first = storage.post_user_message(GENERAL, "Hi", "c1", &[]).unwrap();
        let again = storage.post_user_message(GENERAL, "Hi", "c1", &[]).unwrap();
        assert_eq!(first, again);
        assert_eq!(first.author, ChatAuthor::User);
        assert_eq!((first.channel_id, first.thread_id), (FIRST_CHANNEL, None));
        assert_eq!(first.due_at, Some(100 + ANSWER_WITHIN));
        assert_eq!(storage.list_chat_messages(None, None, 50).unwrap(), [first]);
    }

    #[test]
    fn taking_pending_messages_marks_them_received_once() {
        let mut storage = storage_at(100);
        let hi = storage.post_user_message(GENERAL, "Hi", "c1", &[]).unwrap();
        storage
            .post_agent_message(None, "Hello", &[], &[], &[])
            .unwrap();
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
        let hi = storage.post_user_message(GENERAL, "Hi", "c1", &[]).unwrap();
        let reply = storage
            .post_agent_message(None, "Hello", &[hi.id], &[], &[])
            .unwrap();
        assert_eq!(reply.author, ChatAuthor::Agent);
        assert_eq!(reply.due_at, None);
        let handled = &storage.list_chat_messages(None, None, 50).unwrap()[0];
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
        let hi = storage.post_user_message(GENERAL, "Hi", "c1", &[]).unwrap();
        let reply = storage
            .post_agent_message(None, "Hello", &[], &[], &[])
            .unwrap();
        assert!(matches!(
            storage.ack_chat_messages(&[hi.id, reply.id]),
            Err(StorageError::NotAPersonsMessage(id)) if id == reply.id
        ));
        // The batch failed as a whole, so the first message stays unacknowledged.
        assert_eq!(
            storage.list_chat_messages(None, None, 50).unwrap()[0].acked_at,
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
            storage.post_agent_message(None, "Hello", &[ChatMessageId(99)], &[], &[]),
            Err(StorageError::ChatMessageNotFound(_))
        ));
        assert_eq!(storage.list_chat_messages(None, None, 50).unwrap().len(), 2);
    }

    #[test]
    fn acknowledging_again_keeps_the_first_receipt() {
        let mut storage = storage_at(100);
        let hi = storage.post_user_message(GENERAL, "Hi", "c1", &[]).unwrap();
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
                    .post_user_message(GENERAL, &format!("m{n}"), &format!("c{n}"), &[])
                    .unwrap()
                    .id
            })
            .collect();
        let latest = storage.list_chat_messages(Some(GENERAL), None, 2).unwrap();
        assert_eq!(latest.iter().map(|m| m.id).collect::<Vec<_>>(), ids[3..]);
        let earlier = storage
            .list_chat_messages(Some(GENERAL), Some(ids[3]), 2)
            .unwrap();
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
        let messages = storage.list_chat_messages(Some(GENERAL), None, 50).unwrap();
        assert_eq!(
            messages.iter().map(|m| m.author).collect::<Vec<_>>(),
            [ChatAuthor::Agent, ChatAuthor::System]
        );
    }

    #[test]
    fn channels_have_unique_names_in_any_case_and_keep_their_own_messages() {
        let mut storage = storage_at(100);
        let work = storage.create_chat_channel("work").unwrap();
        assert!(matches!(
            storage.create_chat_channel("WORK"),
            Err(StorageError::ChatChannelNameTaken(name)) if name == "WORK"
        ));
        assert!(matches!(
            storage.update_chat_channel(
                work.id,
                &ChannelEdit {
                    name: Some("General".into()),
                    push: None
                }
            ),
            Err(StorageError::ChatChannelNameTaken(_))
        ));
        // Renaming a channel to another case of its own name is fine.
        let renamed = storage
            .update_chat_channel(
                work.id,
                &ChannelEdit {
                    name: Some("Work".into()),
                    push: None,
                },
            )
            .unwrap();
        assert_eq!(renamed.name, "Work");
        let here = ChatPlace::Channel(work.id);
        let hi = storage.post_user_message(here, "Hi", "c1", &[]).unwrap();
        storage
            .post_user_message(GENERAL, "Elsewhere", "c2", &[])
            .unwrap();
        assert_eq!(hi.channel_id, work.id);
        assert_eq!(
            storage.list_chat_messages(Some(here), None, 50).unwrap(),
            std::slice::from_ref(&hi)
        );
        // A reply without a place goes where the message it answers is.
        let reply = storage
            .post_agent_message(None, "Hello", &[hi.id], &[], &[])
            .unwrap();
        assert_eq!((reply.channel_id, reply.thread_id), (work.id, None));
        assert_eq!(
            storage
                .list_chat_channels()
                .unwrap()
                .iter()
                .map(|c| (c.name.as_str(), c.unread))
                .collect::<Vec<_>>(),
            [("general", 0), ("Work", 1)]
        );
        assert!(matches!(
            storage.post_user_message(ChatPlace::Channel(ChatChannelId(9)), "Hi", "c3", &[]),
            Err(StorageError::ChatChannelNotFound(ChatChannelId(9)))
        ));
    }

    #[test]
    fn threads_keep_their_messages_out_of_the_channel_and_follow_a_task() {
        let mut storage = storage_at(100);
        let ship = task(&mut storage);
        let thread = storage
            .create_chat_thread(FIRST_CHANNEL, "Deploy", Some(ship))
            .unwrap();
        assert_eq!(
            (
                thread.status,
                thread.task_id,
                thread.closed_at,
                thread.last_message_at
            ),
            (ThreadStatus::Open, Some(ship), None, None)
        );
        let place = ChatPlace::Thread(thread.id);
        let hi = storage
            .post_user_message(place, "Ready?", "c1", &[])
            .unwrap();
        assert_eq!(
            (hi.channel_id, hi.thread_id),
            (FIRST_CHANNEL, Some(thread.id))
        );
        assert!(
            storage
                .list_chat_messages(Some(GENERAL), None, 50)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            storage.list_chat_messages(Some(place), None, 50).unwrap(),
            [hi]
        );
        let linked = storage
            .list_chat_threads(ThreadFilter {
                task: Some(ship),
                ..ThreadFilter::default()
            })
            .unwrap();
        assert_eq!(linked.iter().map(|t| t.id).collect::<Vec<_>>(), [thread.id]);
        assert_eq!(linked[0].last_message_at, Some(100));
        assert!(matches!(
            storage.create_chat_thread(FIRST_CHANNEL, "Other", Some(TaskId(99))),
            Err(StorageError::TaskNotFound(TaskId(99)))
        ));
        let unlinked = storage
            .update_chat_thread(
                thread.id,
                &ThreadEdit {
                    task: Some(None),
                    ..ThreadEdit::default()
                },
            )
            .unwrap();
        assert_eq!(unlinked.task_id, None);
    }

    #[test]
    fn closed_and_archived_threads_refuse_messages_until_reopened() {
        let mut storage = storage_at(100);
        let thread = storage
            .create_chat_thread(FIRST_CHANNEL, "Deploy", None)
            .unwrap();
        let place = ChatPlace::Thread(thread.id);
        let close = |status| ThreadEdit {
            status: Some(status),
            ..ThreadEdit::default()
        };
        storage.set_clock(|| 200);
        let closed = storage
            .update_chat_thread(thread.id, &close(ThreadStatus::Closed))
            .unwrap();
        assert_eq!(
            (closed.status, closed.closed_at, closed.archived_at),
            (ThreadStatus::Closed, Some(200), None)
        );
        assert!(matches!(
            storage.post_user_message(place, "Hi", "c1", &[]),
            Err(StorageError::ChatThreadNotOpen {
                status: ThreadStatus::Closed,
                ..
            })
        ));
        storage.set_clock(|| 300);
        let archived = storage
            .update_chat_thread(thread.id, &close(ThreadStatus::Archived))
            .unwrap();
        assert_eq!(
            (archived.status, archived.closed_at, archived.archived_at),
            (ThreadStatus::Archived, Some(200), Some(300))
        );
        assert!(matches!(
            storage.post_agent_message(Some(place), "Hi", &[], &[], &[]),
            Err(StorageError::ChatThreadNotOpen {
                status: ThreadStatus::Archived,
                ..
            })
        ));
        assert!(
            storage
                .list_chat_threads(ThreadFilter::default())
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            storage
                .list_chat_threads(ThreadFilter {
                    archived: true,
                    ..ThreadFilter::default()
                })
                .unwrap()
                .len(),
            1
        );
        let reopened = storage
            .update_chat_thread(thread.id, &close(ThreadStatus::Open))
            .unwrap();
        assert_eq!((reopened.closed_at, reopened.archived_at), (None, None));
        storage.post_user_message(place, "Hi", "c1", &[]).unwrap();
    }

    #[test]
    fn unread_counts_the_agents_messages_after_the_last_read_one() {
        let mut storage = storage_at(100);
        let thread = storage
            .create_chat_thread(FIRST_CHANNEL, "Deploy", None)
            .unwrap();
        let place = ChatPlace::Thread(thread.id);
        storage
            .post_user_message(GENERAL, "Mine", "c1", &[])
            .unwrap();
        let first = storage
            .post_agent_message(Some(GENERAL), "One", &[], &[], &[])
            .unwrap();
        storage
            .post_agent_message(Some(GENERAL), "Two", &[], &[], &[])
            .unwrap();
        let in_thread = storage
            .post_agent_message(Some(place), "Three", &[], &[], &[])
            .unwrap();
        let unread = |storage: &Storage| storage.list_chat_channels().unwrap()[0].unread;
        assert_eq!(unread(&storage), 3);
        storage.mark_chat_read(GENERAL, first.id).unwrap();
        assert_eq!(unread(&storage), 2);
        storage.mark_chat_read(place, in_thread.id).unwrap();
        // Reading back never lowers the mark.
        storage.mark_chat_read(place, ChatMessageId(1)).unwrap();
        assert_eq!(unread(&storage), 1);
        assert_eq!(
            storage.list_chat_threads(ThreadFilter::default()).unwrap()[0].unread,
            0
        );
        storage
            .post_agent_message(Some(place), "Four", &[], &[], &[])
            .unwrap();
        assert_eq!(unread(&storage), 2);
        // An archived thread no longer counts toward its channel.
        storage
            .update_chat_thread(
                thread.id,
                &ThreadEdit {
                    status: Some(ThreadStatus::Archived),
                    ..ThreadEdit::default()
                },
            )
            .unwrap();
        assert_eq!(unread(&storage), 1);
        assert!(matches!(
            storage.mark_chat_read(ChatPlace::Thread(ChatThreadId(9)), first.id),
            Err(StorageError::ChatThreadNotFound(ChatThreadId(9)))
        ));
    }

    #[test]
    fn a_notice_names_the_channel_and_thread_unless_the_channel_is_quiet() {
        let mut storage = storage_at(100);
        let thread = storage
            .create_chat_thread(FIRST_CHANNEL, "Deploy", None)
            .unwrap();
        assert_eq!(
            storage.chat_notice(FIRST_CHANNEL, Some(thread.id)).unwrap(),
            Some(ChatNotice {
                channel: "general".into(),
                thread: Some("Deploy".into())
            })
        );
        storage
            .update_chat_channel(
                FIRST_CHANNEL,
                &ChannelEdit {
                    name: None,
                    push: Some(false),
                },
            )
            .unwrap();
        assert_eq!(
            storage.chat_notice(FIRST_CHANNEL, Some(thread.id)).unwrap(),
            None
        );
        assert!(!storage.list_chat_channels().unwrap()[0].push);
    }
    fn yes_no() -> Vec<ChatAction> {
        vec![
            ChatAction {
                key: "yes".into(),
                label: "Yes".into(),
                style: ActionStyle::Primary,
            },
            ChatAction {
                key: "no".into(),
                label: "No".into(),
                style: ActionStyle::Default,
            },
        ]
    }

    #[test]
    fn a_choice_is_recorded_once_as_a_persons_message_where_the_question_is() {
        let mut storage = storage_at(100);
        let thread = storage
            .create_chat_thread(FIRST_CHANNEL, "Deploy", None)
            .unwrap();
        let place = ChatPlace::Thread(thread.id);
        let asked = storage
            .post_agent_message(Some(place), "Deploy now?", &[], &yes_no(), &[])
            .unwrap();
        assert_eq!(
            asked
                .actions
                .iter()
                .map(|a| a.key.as_str())
                .collect::<Vec<_>>(),
            ["yes", "no"]
        );
        storage.set_clock(|| 200);
        let (choice, offered) = storage.choose_chat_action(asked.id, "no", "k1").unwrap();
        assert_eq!(
            (choice.author, choice.body.as_str(), choice.thread_id),
            (ChatAuthor::User, "No", Some(thread.id))
        );
        assert_eq!(
            choice.choice_of,
            Some(ChoiceOf {
                message_id: asked.id,
                key: "no".into()
            })
        );
        assert_eq!(choice.due_at, Some(200 + ANSWER_WITHIN));
        assert_eq!(
            offered.chosen,
            Some(ChatChoice {
                key: "no".into(),
                at: 200,
                choice_id: choice.id
            })
        );
        // The agent receives the choice like any other message of a person.
        let taken = storage.pending_chat_messages(true).unwrap();
        assert_eq!(
            taken
                .iter()
                .map(|m| (m.id, m.choice_of.clone()))
                .collect::<Vec<_>>(),
            [(choice.id, choice.choice_of.clone())]
        );
        // Sending the same click again returns it; another click is refused.
        assert_eq!(
            storage
                .choose_chat_action(asked.id, "no", "k1")
                .unwrap()
                .0
                .id,
            choice.id
        );
        assert!(matches!(
            storage.choose_chat_action(asked.id, "yes", "k2"),
            Err(StorageError::ChatActionChosen { key, .. }) if key == "no"
        ));
        let other = storage
            .post_agent_message(Some(place), "And?", &[], &yes_no(), &[])
            .unwrap();
        assert!(matches!(
            storage.choose_chat_action(other.id, "maybe", "k3"),
            Err(StorageError::ChatActionNotFound { .. })
        ));
        assert!(matches!(
            storage.choose_chat_action(choice.id, "no", "k4"),
            Err(StorageError::NotAnAgentsMessage(_))
        ));
        storage
            .update_chat_thread(
                thread.id,
                &ThreadEdit {
                    status: Some(ThreadStatus::Closed),
                    ..ThreadEdit::default()
                },
            )
            .unwrap();
        assert!(matches!(
            storage.choose_chat_action(other.id, "yes", "k5"),
            Err(StorageError::ChatThreadNotOpen { .. })
        ));
        assert!(matches!(
            storage.post_agent_message(
                Some(GENERAL),
                "Twice",
                &[],
                &[yes_no()[0].clone(), yes_no()[0].clone()],
                &[]
            ),
            Err(StorageError::Sqlite(_))
        ));
    }

    #[test]
    fn uploads_go_once_on_a_message_of_their_own_side_and_stale_ones_are_dropped() {
        let mut storage = storage_at(100);
        let mine = storage
            .create_chat_attachment("k-mine", ChatAuthor::User, "shot.png", "image/png", 3)
            .unwrap();
        let agents = storage
            .create_chat_attachment("k-agent", ChatAuthor::Agent, "log.txt", "text/plain", 5)
            .unwrap();
        assert!(matches!(
            storage.post_agent_message(None, "Here", &[], &[], &[mine.id]),
            Err(StorageError::ChatAttachmentNotFree(id)) if id == mine.id
        ));
        let sent = storage
            .post_user_message(GENERAL, "See", "c1", &[mine.id])
            .unwrap();
        assert_eq!(sent.attachments.len(), 1);
        assert_eq!(
            (
                sent.attachments[0].name.as_str(),
                sent.attachments[0].message_id
            ),
            ("shot.png", Some(sent.id))
        );
        assert_eq!(
            storage.list_chat_messages(Some(GENERAL), None, 50).unwrap()[0].attachments,
            sent.attachments
        );
        assert!(matches!(
            storage.post_user_message(GENERAL, "Again", "c2", &[mine.id]),
            Err(StorageError::ChatAttachmentNotFree(_))
        ));
        assert!(matches!(
            storage.post_user_message(GENERAL, "None", "c3", &[ChatAttachmentId(99)]),
            Err(StorageError::ChatAttachmentNotFound(ChatAttachmentId(99)))
        ));
        // The failed messages were not stored.
        assert_eq!(storage.list_chat_messages(None, None, 50).unwrap().len(), 1);
        let (found, key) = storage.chat_attachment(mine.id).unwrap().unwrap();
        assert_eq!((found.uploader, key.as_str()), (ChatAuthor::User, "k-mine"));
        storage.set_clock(|| 200);
        storage
            .create_chat_attachment("k-new", ChatAuthor::User, "new.txt", "text/plain", 1)
            .unwrap();
        // Only the free upload made before the cutoff goes; the new one and the sent one stay.
        storage.set_clock(|| 300);
        assert_eq!(
            storage.remove_stale_chat_attachments(101).unwrap(),
            ["k-agent"]
        );
        assert!(storage.chat_attachment(agents.id).unwrap().is_none());
        assert!(storage.chat_attachment(mine.id).unwrap().is_some());
    }
}
