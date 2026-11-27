//! The agent's side of the chat: it takes people's messages, acknowledges them, replies,
//! and marks them handled; each step is a receipt the app shows on the message.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::commands::CommandResult;
use crate::commands::types::{self, ChatMessage, ChatMessageId, TaskId};
use crate::storage::{CHAT_PAGE_LIMIT, Storage};

/// How many messages `list_chat` returns without a limit.
const DEFAULT_LIST: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ReplyInChat {
    /// The message to the people in the app, as text or Markdown.
    pub body: String,
    /// IDs of people's messages this reply answers; each is marked handled by it.
    #[serde(default)]
    pub handles: Vec<ChatMessageId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct AckChat {
    /// IDs of people's messages, e.g. from take_pending.
    pub ids: Vec<ChatMessageId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct MarkChatHandled {
    /// The person's message that was handled.
    pub id: ChatMessageId,
    /// The reply that handled it, an ID reply_in_chat returned.
    #[serde(default)]
    pub reply_id: Option<ChatMessageId>,
    /// The task created or updated for it.
    #[serde(default)]
    pub task_id: Option<TaskId>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ListChat {
    /// Only messages before this one, to page back through the chat.
    #[serde(default)]
    pub before: Option<ChatMessageId>,
    /// At most this many messages, 50 when omitted and 200 at most.
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct SetTyping {
    /// true while writing a reply (it lapses after 30 seconds unless sent again), false to stop.
    pub typing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Typing {
    pub typing: bool,
}

pub fn pending_chat(storage: &mut Storage, take: bool) -> CommandResult<Vec<ChatMessage>> {
    let messages = storage.pending_chat_messages(take)?;
    Ok(ChatMessage::all_at(&messages, storage.now()))
}

pub fn reply_in_chat(storage: &mut Storage, request: ReplyInChat) -> CommandResult<ChatMessage> {
    let body = types::chat_body(&request.body)?;
    let handles: Vec<_> = request.handles.into_iter().map(Into::into).collect();
    let message = storage.post_agent_message(&body, &handles)?;
    Ok(ChatMessage::at(&message, storage.now()))
}

pub fn ack_chat(storage: &mut Storage, request: AckChat) -> CommandResult<Vec<ChatMessage>> {
    let ids: Vec<_> = request.ids.into_iter().map(Into::into).collect();
    let messages = storage.ack_chat_messages(&ids)?;
    Ok(ChatMessage::all_at(&messages, storage.now()))
}

pub fn mark_chat_handled(
    storage: &mut Storage,
    request: MarkChatHandled,
) -> CommandResult<ChatMessage> {
    let message = storage.mark_chat_handled(
        request.id.into(),
        request.reply_id.map(Into::into),
        request.task_id.map(Into::into),
    )?;
    Ok(ChatMessage::at(&message, storage.now()))
}

pub fn list_chat(storage: &Storage, request: ListChat) -> CommandResult<Vec<ChatMessage>> {
    let limit = request.limit.unwrap_or(DEFAULT_LIST).min(CHAT_PAGE_LIMIT);
    let messages = storage.list_chat_messages(request.before.map(Into::into), limit)?;
    Ok(ChatMessage::all_at(&messages, storage.now()))
}
