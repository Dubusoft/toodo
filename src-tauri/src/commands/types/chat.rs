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

/// The most actions one message offers.
pub const ACTION_LIMIT: usize = 10;

/// The longest action key, in characters.
const ACTION_KEY_LIMIT: usize = 100;

/// The longest action label, in characters.
const ACTION_LABEL_LIMIT: usize = 80;

/// The most files one message carries.
pub const ATTACHMENT_LIMIT: usize = 10;

/// The longest file name of an upload, in characters.
const FILE_NAME_LIMIT: usize = 200;

/// The most messages one search returns.
pub const SEARCH_LIMIT: u32 = 100;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, schemars::JsonSchema)]
#[serde(transparent)]
pub struct ChatAttachmentId(#[specta(type = Number)] pub i64);

impl From<ChatAttachmentId> for chat::ChatAttachmentId {
    fn from(id: ChatAttachmentId) -> Self {
        Self(id.0)
    }
}

impl From<chat::ChatAttachmentId> for ChatAttachmentId {
    fn from(id: chat::ChatAttachmentId) -> Self {
        Self(id.0)
    }
}

/// How an action's button looks: plain (`default`), the suggested choice (`primary`), or a
/// destructive one (`danger`).
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum ChatActionStyle {
    #[default]
    Default,
    Primary,
    Danger,
}

impl From<chat::ActionStyle> for ChatActionStyle {
    fn from(style: chat::ActionStyle) -> Self {
        match style {
            chat::ActionStyle::Default => Self::Default,
            chat::ActionStyle::Primary => Self::Primary,
            chat::ActionStyle::Danger => Self::Danger,
        }
    }
}

impl From<ChatActionStyle> for chat::ActionStyle {
    fn from(style: ChatActionStyle) -> Self {
        match style {
            ChatActionStyle::Default => Self::Default,
            ChatActionStyle::Primary => Self::Primary,
            ChatActionStyle::Danger => Self::Danger,
        }
    }
}

/// A choice offered on the agent's message, shown as a button. A person's click comes back
/// to the agent with `key`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatAction {
    /// What the agent gets back when this is chosen, e.g. `approve`; unique in the message.
    pub key: String,
    /// What the button says.
    pub label: String,
    #[serde(default)]
    pub style: ChatActionStyle,
}

impl From<&chat::ChatAction> for ChatAction {
    fn from(action: &chat::ChatAction) -> Self {
        Self {
            key: action.key.clone(),
            label: action.label.clone(),
            style: action.style.into(),
        }
    }
}

/// The actions of a message to post: at most [`ACTION_LIMIT`], each key and label one line,
/// keys unique.
pub(crate) fn chat_actions(actions: &[ChatAction]) -> CommandResult<Vec<chat::ChatAction>> {
    if actions.len() > ACTION_LIMIT {
        return Err(CommandError::invalid_input(format!(
            "a message offers at most {ACTION_LIMIT} actions, not {}",
            actions.len()
        )));
    }
    let mut parsed: Vec<chat::ChatAction> = Vec::with_capacity(actions.len());
    for action in actions {
        let key = line(&action.key, "action key", ACTION_KEY_LIMIT, false)?;
        if parsed.iter().any(|other| other.key == key) {
            return Err(CommandError::invalid_input(format!(
                "action key {key:?} is given twice; each action of a message needs its own key"
            )));
        }
        parsed.push(chat::ChatAction {
            key,
            label: line(&action.label, "action label", ACTION_LABEL_LIMIT, false)?,
            style: action.style.into(),
        });
    }
    Ok(parsed)
}

/// The action a person chose on the agent's message, and the person's message recording it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatChoice {
    pub key: String,
    pub at: Timestamp,
    pub choice_id: ChatMessageId,
}

/// The agent's message and the key of the action a person's message chose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatChoiceOf {
    pub message_id: ChatMessageId,
    pub key: String,
}

/// A file uploaded to the chat. People's apps read it at
/// `/api/chat/attachments/<id>`, the agent at `/mcp/attachments/<id>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachment {
    pub id: ChatAttachmentId,
    pub name: String,
    pub content_type: String,
    /// Bytes.
    #[specta(type = Number)]
    pub size: i64,
}

impl From<&chat::ChatAttachment> for ChatAttachment {
    fn from(attachment: &chat::ChatAttachment) -> Self {
        Self {
            id: attachment.id.into(),
            name: attachment.name.clone(),
            content_type: attachment.content_type.clone(),
            size: attachment.size,
        }
    }
}

/// The files of a message to post: at most [`ATTACHMENT_LIMIT`].
pub(crate) fn attachment_ids(
    ids: &[ChatAttachmentId],
) -> CommandResult<Vec<chat::ChatAttachmentId>> {
    if ids.len() > ATTACHMENT_LIMIT {
        return Err(CommandError::invalid_input(format!(
            "a message carries at most {ATTACHMENT_LIMIT} files, not {}",
            ids.len()
        )));
    }
    Ok(ids.iter().copied().map(Into::into).collect())
}

/// The name an upload is kept under: the last part of `name` as a path, one line of at most
/// [`FILE_NAME_LIMIT`] characters.
pub(crate) fn file_name(name: &str) -> CommandResult<String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    line(base, "file name", FILE_NAME_LIMIT, false)
}

/// The media type an upload is served with: the `type/subtype` of `declared` in lower case,
/// or `application/octet-stream` when it is missing or malformed.
pub fn content_type(declared: Option<&str>) -> String {
    let essence = declared
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let token = |part: &str| {
        !part.is_empty()
            && part.len() <= 100
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$&-^_.+".contains(&b))
    };
    match essence.split_once('/') {
        Some((kind, subtype)) if token(kind) && token(subtype) => essence,
        _ => "application/octet-stream".to_owned(),
    }
}

/// A message a search found, with the name of its channel and the title of its thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatSearchHit {
    pub message: ChatMessage,
    pub channel_name: String,
    pub thread_title: Option<String>,
}

impl ChatSearchHit {
    pub fn all_at(hits: &[crate::storage::ChatHit], now: i64) -> Vec<Self> {
        hits.iter()
            .map(|hit| Self {
                message: ChatMessage::at(&hit.message, now),
                channel_name: hit.channel.clone(),
                thread_title: hit.thread.clone(),
            })
            .collect()
    }
}

/// A search query: some words, at most 200 characters.
pub(crate) fn search_query(query: &str) -> CommandResult<&str> {
    if query.trim().is_empty() || query.chars().count() > 200 {
        return Err(CommandError::invalid_input(
            "the search query must have 1 to 200 characters",
        ));
    }
    Ok(query)
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
    /// The choices the agent offers on its message, shown as buttons.
    pub actions: Vec<ChatAction>,
    /// The action a person chose on the agent's message; the message takes no other.
    pub chosen: Option<ChatChoice>,
    /// On a person's message that records a choice: the agent's message and the action.
    pub choice_of: Option<ChatChoiceOf>,
    pub attachments: Vec<ChatAttachment>,
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
            actions: message.actions.iter().map(Into::into).collect(),
            chosen: message.chosen.as_ref().map(|chosen| ChatChoice {
                key: chosen.key.clone(),
                at: Timestamp(chosen.at),
                choice_id: chosen.choice_id.into(),
            }),
            choice_of: message.choice_of.as_ref().map(|of| ChatChoiceOf {
                message_id: of.message_id.into(),
                key: of.key.clone(),
            }),
            attachments: message.attachments.iter().map(Into::into).collect(),
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
            actions: vec![chat::ChatAction {
                key: "ok".to_owned(),
                label: "OK".to_owned(),
                style: chat::ActionStyle::Primary,
            }],
            chosen: Some(chat::ChatChoice {
                key: "ok".to_owned(),
                at: 6,
                choice_id: chat::ChatMessageId(4),
            }),
            choice_of: None,
            attachments: vec![chat::ChatAttachment {
                id: chat::ChatAttachmentId(7),
                uploader: Author::Agent,
                name: "log.txt".to_owned(),
                content_type: "text/plain".to_owned(),
                size: 12,
                message_id: Some(chat::ChatMessageId(3)),
                created_at: 5,
            }],
        };
        assert_eq!(
            serde_json::to_value(ChatMessage::at(&stored, 5)).unwrap(),
            serde_json::json!({
                "id": 3, "channelId": 1, "threadId": 2, "author": "agent", "body": "Hello",
                "at": 5, "deliveredAt": null,
                "ackedAt": null, "handledAt": null, "handledReplyId": null,
                "handledTaskId": null, "overdue": false,
                "actions": [{ "key": "ok", "label": "OK", "style": "primary" }],
                "chosen": { "key": "ok", "at": 6, "choiceId": 4 },
                "choiceOf": null,
                "attachments": [
                    { "id": 7, "name": "log.txt", "contentType": "text/plain", "size": 12 }
                ]
            })
        );
    }

    #[test]
    fn actions_are_limited_single_lines_with_unique_keys() {
        let action = |key: &str, label: &str| ChatAction {
            key: key.to_owned(),
            label: label.to_owned(),
            style: ChatActionStyle::Default,
        };
        let parsed = chat_actions(&[action(" yes ", " Yes "), action("no", "No")]).unwrap();
        assert_eq!(
            parsed
                .iter()
                .map(|a| (a.key.as_str(), a.label.as_str()))
                .collect::<Vec<_>>(),
            [("yes", "Yes"), ("no", "No")]
        );
        assert!(chat_actions(&[action("a", "A"), action("a", "B")]).is_err());
        assert!(chat_actions(&[action("a", "")]).is_err());
        assert!(chat_actions(&[action("a\nb", "A")]).is_err());
        let many: Vec<_> = (0..=ACTION_LIMIT)
            .map(|n| action(&n.to_string(), "A"))
            .collect();
        assert!(chat_actions(&many).is_err());
        assert_eq!(
            serde_json::from_value::<ChatAction>(serde_json::json!({ "key": "k", "label": "L" }))
                .unwrap()
                .style,
            ChatActionStyle::Default
        );
    }

    #[test]
    fn uploads_keep_the_base_name_and_a_well_formed_media_type() {
        assert_eq!(file_name("C:\\shots\\a b.png").unwrap(), "a b.png");
        assert_eq!(file_name("../../etc/passwd").unwrap(), "passwd");
        for bad in ["", "dir/", "a\nb"] {
            assert!(file_name(bad).is_err(), "{bad:?}");
        }
        assert_eq!(content_type(Some("Image/PNG; q=1")), "image/png");
        for bad in [
            None,
            Some(""),
            Some("png"),
            Some("text/ html"),
            Some("a/b/c"),
        ] {
            assert_eq!(content_type(bad), "application/octet-stream", "{bad:?}");
        }
    }
}
