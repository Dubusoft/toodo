use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Number;

use super::{TaskId, Timestamp};
use crate::commands::{CommandError, CommandResult};
use crate::domain::chat::{self, ChatAuthor as Author};

/// The most characters a chat message may have, after trimming.
pub const CHAT_BODY_LIMIT: usize = 8000;

/// The longest channel name, in characters.
const CHANNEL_NAME_LIMIT: usize = 50;

/// The longest thread title, in characters.
const THREAD_TITLE_LIMIT: usize = 200;

/// The longest client ID of a message, in characters.
const CLIENT_ID_LIMIT: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct ChatMessageId(#[specta(type = Number)] pub i64);

impl From<ChatMessageId> for chat::ChatMessageId {
    fn from(id: ChatMessageId) -> Self {
        Self(id.0)
    }
}

impl From<chat::ChatMessageId> for ChatMessageId {
    fn from(id: chat::ChatMessageId) -> Self {
        Self(id.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct ChatChannelId(#[specta(type = Number)] pub i64);

impl From<ChatChannelId> for chat::ChatChannelId {
    fn from(id: ChatChannelId) -> Self {
        Self(id.0)
    }
}

impl From<chat::ChatChannelId> for ChatChannelId {
    fn from(id: chat::ChatChannelId) -> Self {
        Self(id.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct ChatThreadId(#[specta(type = Number)] pub i64);

impl From<ChatThreadId> for chat::ChatThreadId {
    fn from(id: ChatThreadId) -> Self {
        Self(id.0)
    }
}

impl From<chat::ChatThreadId> for ChatThreadId {
    fn from(id: chat::ChatThreadId) -> Self {
        Self(id.0)
    }
}

/// Where a message is: a channel itself (`{ "channel": 1 }`) or one of its threads
/// (`{ "thread": 3 }`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ChatPlace {
    Channel(ChatChannelId),
    Thread(ChatThreadId),
}

impl From<ChatPlace> for chat::ChatPlace {
    fn from(place: ChatPlace) -> Self {
        match place {
            ChatPlace::Channel(id) => Self::Channel(id.into()),
            ChatPlace::Thread(id) => Self::Thread(id.into()),
        }
    }
}

/// The place an agent names with an optional `channel_id` and `thread_id`: at most one of
/// them, and neither for every place or the default one.
pub(crate) fn place(
    channel: Option<ChatChannelId>,
    thread: Option<ChatThreadId>,
) -> CommandResult<Option<chat::ChatPlace>> {
    match (channel, thread) {
        (Some(_), Some(_)) => Err(CommandError::invalid_input(
            "give channel_id or thread_id, not both; a thread_id already names its channel",
        )),
        (Some(channel), None) => Ok(Some(chat::ChatPlace::Channel(channel.into()))),
        (None, Some(thread)) => Ok(Some(chat::ChatPlace::Thread(thread.into()))),
        (None, None) => Ok(None),
    }
}

/// A channel of the chat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatChannel {
    pub id: ChatChannelId,
    pub name: String,
    /// Whether the agent's messages in it and its threads notify devices.
    pub push: bool,
    pub created_at: Timestamp,
    /// Messages of the agent and Toodo not read yet, in it and its threads that are not
    /// archived.
    #[specta(type = Number)]
    pub unread: i64,
}

impl From<&chat::ChatChannel> for ChatChannel {
    fn from(channel: &chat::ChatChannel) -> Self {
        Self {
            id: channel.id.into(),
            name: channel.name.clone(),
            push: channel.push,
            created_at: Timestamp(channel.created_at),
            unread: channel.unread,
        }
    }
}

/// Whether a thread takes messages: open, closed, or archived (closed and left out of its
/// channel's thread list unless asked for).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChatThreadStatus {
    Open,
    Closed,
    Archived,
}

impl From<chat::ThreadStatus> for ChatThreadStatus {
    fn from(status: chat::ThreadStatus) -> Self {
        match status {
            chat::ThreadStatus::Open => Self::Open,
            chat::ThreadStatus::Closed => Self::Closed,
            chat::ThreadStatus::Archived => Self::Archived,
        }
    }
}

impl From<ChatThreadStatus> for chat::ThreadStatus {
    fn from(status: ChatThreadStatus) -> Self {
        match status {
            ChatThreadStatus::Open => Self::Open,
            ChatThreadStatus::Closed => Self::Closed,
            ChatThreadStatus::Archived => Self::Archived,
        }
    }
}

/// A thread under a channel, which may follow a task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatThread {
    pub id: ChatThreadId,
    pub channel_id: ChatChannelId,
    pub title: String,
    pub task_id: Option<TaskId>,
    pub status: ChatThreadStatus,
    pub created_at: Timestamp,
    /// Set while it is closed or archived.
    pub closed_at: Option<Timestamp>,
    /// Set while it is archived.
    pub archived_at: Option<Timestamp>,
    /// Messages of the agent and Toodo in it not read yet.
    #[specta(type = Number)]
    pub unread: i64,
    pub last_message_at: Option<Timestamp>,
}

impl From<&chat::ChatThread> for ChatThread {
    fn from(thread: &chat::ChatThread) -> Self {
        Self {
            id: thread.id.into(),
            channel_id: thread.channel_id.into(),
            title: thread.title.clone(),
            task_id: thread.task_id.map(Into::into),
            status: thread.status.into(),
            created_at: Timestamp(thread.created_at),
            closed_at: thread.closed_at.map(Timestamp),
            archived_at: thread.archived_at.map(Timestamp),
            unread: thread.unread,
            last_message_at: thread.last_message_at.map(Timestamp),
        }
    }
}

/// Which threads to list: of a channel, of a task, or all; archived ones only when
/// `archived` is set.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatThreadFilter {
    #[serde(default)]
    pub channel_id: Option<ChatChannelId>,
    #[serde(default)]
    pub task_id: Option<TaskId>,
    #[serde(default)]
    pub archived: bool,
}

impl From<ChatThreadFilter> for crate::storage::ThreadFilter {
    fn from(filter: ChatThreadFilter) -> Self {
        Self {
            channel: filter.channel_id.map(Into::into),
            task: filter.task_id.map(Into::into),
            archived: filter.archived,
        }
    }
}

/// A thread to open under a channel, following a task if `taskId` is given.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewChatThread {
    pub channel_id: ChatChannelId,
    pub title: String,
    #[serde(default)]
    pub task_id: Option<TaskId>,
}

/// What changes on a channel; an omitted or `null` field stays.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatChannelEdit {
    #[serde(default)]
    pub name: Option<String>,
    /// Whether the agent's messages in the channel notify devices.
    #[serde(default)]
    pub push: Option<bool>,
}

impl ChatChannelEdit {
    pub(crate) fn parse(&self) -> CommandResult<crate::storage::ChannelEdit> {
        Ok(crate::storage::ChannelEdit {
            name: self.name.as_deref().map(channel_name).transpose()?,
            push: self.push,
        })
    }
}

/// What changes on a thread; an omitted or `null` field stays. `unlinkTask` drops its task
/// and cannot go with `taskId`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatThreadEdit {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub status: Option<ChatThreadStatus>,
    #[serde(default)]
    pub task_id: Option<TaskId>,
    #[serde(default)]
    pub unlink_task: bool,
}

impl ChatThreadEdit {
    pub(crate) fn parse(&self) -> CommandResult<crate::storage::ThreadEdit> {
        let task = match (self.task_id, self.unlink_task) {
            (Some(_), true) => {
                return Err(CommandError::invalid_input(
                    "give taskId to link a task or unlinkTask to drop it, not both",
                ));
            }
            (Some(task), false) => Some(Some(task.into())),
            (None, true) => Some(None),
            (None, false) => None,
        };
        Ok(crate::storage::ThreadEdit {
            title: self.title.as_deref().map(thread_title).transpose()?,
            status: self.status.map(Into::into),
            task,
        })
    }
}

/// Who wrote a chat message: a person in the app, the agent connected over MCP, or Toodo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ChatAuthor {
    User,
    Agent,
    System,
}

impl From<Author> for ChatAuthor {
    fn from(author: Author) -> Self {
        match author {
            Author::User => Self::User,
            Author::Agent => Self::Agent,
            Author::System => Self::System,
        }
    }
}

/// A chat message. The receipts are set only on a person's messages: when the agent
/// received it, acknowledged it, and handled it with a reply or a task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: ChatMessageId,
    pub channel_id: ChatChannelId,
    /// The thread it is in; unset for a message in the channel itself.
    pub thread_id: Option<ChatThreadId>,
    pub author: ChatAuthor,
    pub body: String,
    pub at: Timestamp,
    pub delivered_at: Option<Timestamp>,
    pub acked_at: Option<Timestamp>,
    pub handled_at: Option<Timestamp>,
    pub handled_reply_id: Option<ChatMessageId>,
    pub handled_task_id: Option<TaskId>,
    /// A person's message the agent neither handled nor answered in time.
    pub overdue: bool,
}

impl ChatMessage {
    /// The message as it stands at `now`, which decides whether it is overdue.
    pub fn at(message: &chat::ChatMessage, now: i64) -> Self {
        Self {
            id: message.id.into(),
            channel_id: message.channel_id.into(),
            thread_id: message.thread_id.map(Into::into),
            author: message.author.into(),
            body: message.body.clone(),
            at: Timestamp(message.at),
            delivered_at: message.delivered_at.map(Timestamp),
            acked_at: message.acked_at.map(Timestamp),
            handled_at: message.handled_at.map(Timestamp),
            handled_reply_id: message.handled_reply_id.map(Into::into),
            handled_task_id: message.handled_task_id.map(Into::into),
            overdue: message.overdue(now),
        }
    }

    pub fn all_at(messages: &[chat::ChatMessage], now: i64) -> Vec<Self> {
        messages
            .iter()
            .map(|message| Self::at(message, now))
            .collect()
    }
}

/// How the app shows the agent: the name and avatar the server is configured with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatAgent {
    pub name: String,
    /// An `https` URL or a path on the server.
    pub avatar_url: Option<String>,
}

/// The latest messages of the chat and what the agent is doing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatView {
    pub agent: ChatAgent,
    /// Oldest first.
    pub messages: Vec<ChatMessage>,
    /// Whether messages before the first one remain.
    pub has_earlier: bool,
    /// Until when the agent said it is writing; unset when it posted since or never said.
    pub typing_until: Option<Timestamp>,
}

/// A chat message body, trimmed: non-empty and at most [`CHAT_BODY_LIMIT`] characters.
pub(crate) fn chat_body(body: &str) -> CommandResult<String> {
    let body = body.trim();
    if body.is_empty() {
        return Err(CommandError::invalid_input(
            "chat message body must not be empty; send the message as text in body",
        ));
    }
    let length = body.chars().count();
    if length > CHAT_BODY_LIMIT {
        return Err(CommandError::invalid_input(format!(
            "chat message has {length} characters, more than the limit of {CHAT_BODY_LIMIT}; \
             split it into several messages"
        )));
    }
    Ok(body.to_owned())
}

/// One line of text, trimmed and without a leading `#` when `hash` is set: non-empty and at
/// most `limit` characters.
fn line(text: &str, what: &str, limit: usize, hash: bool) -> CommandResult<String> {
    let text = text.trim();
    let text = if hash {
        text.trim_start_matches('#').trim_start()
    } else {
        text
    };
    if text.is_empty() || text.chars().count() > limit || text.contains(char::is_control) {
        return Err(CommandError::invalid_input(format!(
            "{what} must be one line of 1 to {limit} characters"
        )));
    }
    Ok(text.to_owned())
}

/// A channel name, without the `#` it is shown with.
pub(crate) fn channel_name(name: &str) -> CommandResult<String> {
    line(name, "channel name", CHANNEL_NAME_LIMIT, true)
}

pub(crate) fn thread_title(title: &str) -> CommandResult<String> {
    line(title, "thread title", THREAD_TITLE_LIMIT, false)
}

/// The ID a client gives a message it sends: one line of at most 100 characters.
pub(crate) fn client_id(id: &str) -> CommandResult<&str> {
    if id.trim().is_empty() || id.chars().count() > CLIENT_ID_LIMIT || id.contains(char::is_control)
    {
        return Err(CommandError::invalid_input(format!(
            "clientId must be one line of 1 to {CLIENT_ID_LIMIT} characters"
        )));
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies_are_trimmed_and_limited() {
        assert_eq!(chat_body("  Hi \n").unwrap(), "Hi");
        assert!(chat_body(" \n ").is_err());
        let longest = "é".repeat(CHAT_BODY_LIMIT);
        assert_eq!(chat_body(&longest).unwrap(), longest);
        assert!(chat_body(&format!("{longest}x")).is_err());
    }

    #[test]
    fn channel_names_drop_their_hash_and_titles_stay_single_lines() {
        assert_eq!(channel_name(" #work ").unwrap(), "work");
        for bad in ["#", " ", "a\nb", &"x".repeat(CHANNEL_NAME_LIMIT + 1)] {
            assert!(channel_name(bad).is_err(), "{bad:?}");
        }
        assert_eq!(thread_title(" #12 Deploy ").unwrap(), "#12 Deploy");
        assert!(thread_title("a\nb").is_err());
    }

    #[test]
    fn places_and_thread_edits_refuse_two_answers_at_once() {
        assert!(place(Some(ChatChannelId(1)), Some(ChatThreadId(2))).is_err());
        assert_eq!(
            place(None, Some(ChatThreadId(2))).unwrap(),
            Some(chat::ChatPlace::Thread(chat::ChatThreadId(2)))
        );
        assert_eq!(place(None, None).unwrap(), None);
        let both = ChatThreadEdit {
            task_id: Some(TaskId(1)),
            unlink_task: true,
            ..ChatThreadEdit::default()
        };
        assert!(both.parse().is_err());
        let unlink = ChatThreadEdit {
            unlink_task: true,
            ..ChatThreadEdit::default()
        };
        assert_eq!(unlink.parse().unwrap().task, Some(None));
        assert_eq!(
            serde_json::from_value::<ChatPlace>(serde_json::json!({ "thread": 3 })).unwrap(),
            ChatPlace::Thread(ChatThreadId(3))
        );
    }

    #[test]
    fn client_ids_are_short_single_lines() {
        assert_eq!(client_id("c-1").unwrap(), "c-1");
        for bad in ["", " ", "a\nb", &"x".repeat(CLIENT_ID_LIMIT + 1)] {
            assert!(client_id(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn messages_use_camel_case_keys_and_snake_case_authors() {
        let stored = chat::ChatMessage {
            id: chat::ChatMessageId(3),
            channel_id: chat::FIRST_CHANNEL,
            thread_id: Some(chat::ChatThreadId(2)),
            author: Author::Agent,
            body: "Hello".to_owned(),
            at: 5,
            delivered_at: None,
            acked_at: None,
            handled_at: None,
            handled_reply_id: None,
            handled_task_id: None,
            due_at: None,
        };
        assert_eq!(
            serde_json::to_value(ChatMessage::at(&stored, 5)).unwrap(),
            serde_json::json!({
                "id": 3, "channelId": 1, "threadId": 2, "author": "agent", "body": "Hello",
                "at": 5, "deliveredAt": null,
                "ackedAt": null, "handledAt": null, "handledReplyId": null,
                "handledTaskId": null, "overdue": false
            })
        );
    }
}
