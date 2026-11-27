//! The agent's side of the chat: it takes people's messages, acknowledges them, replies,
//! and marks them handled, each step a receipt the app shows on the message; it offers
//! actions people choose among and attaches files; it keeps channels and the threads under
//! them, which may follow a task; and it searches earlier messages.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::commands::CommandResult;
use crate::commands::chat::body_with_files;
use crate::commands::types::{
    self, ChatAction, ChatAttachmentId, ChatChannel, ChatChannelId, ChatMessage, ChatMessageId,
    ChatSearchHit, ChatThread, ChatThreadEdit, ChatThreadFilter, ChatThreadId, ChatThreadStatus,
    TaskId,
};
use crate::domain::chat::FIRST_CHANNEL;
use crate::storage::{CHAT_PAGE_LIMIT, ChatNotice, ChatSearch, Storage};

/// How many messages `search_chat` returns without a limit.
const DEFAULT_SEARCH: u32 = 20;

/// How many messages `list_chat` returns without a limit.
const DEFAULT_LIST: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ReplyInChat {
    /// The message to the people in the app, as text or Markdown; may be blank when
    /// attachments are given.
    #[serde(default)]
    pub body: String,
    /// IDs of people's messages this reply answers; each is marked handled by it.
    #[serde(default)]
    pub handles: Vec<ChatMessageId>,
    /// The channel to post in. Give this or thread_id, or neither to post where the first
    /// message in handles is, else in the first channel.
    #[serde(default)]
    pub channel_id: Option<ChatChannelId>,
    /// The open thread to post in.
    #[serde(default)]
    pub thread_id: Option<ChatThreadId>,
    /// Up to 10 choices shown as buttons under the message. A person may choose one; you
    /// receive it from take_pending as their message with the label as body and choiceOf
    /// naming this message and the action key.
    #[serde(default)]
    pub actions: Vec<ChatAction>,
    /// IDs of files you uploaded with POST /mcp/attachments, up to 10.
    #[serde(default)]
    pub attachments: Vec<ChatAttachmentId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct SearchChat {
    /// Words that must all appear in a message, as case-insensitive substrings.
    pub query: String,
    /// Only messages in this channel and its threads.
    #[serde(default)]
    pub channel_id: Option<ChatChannelId>,
    /// Only messages in this thread.
    #[serde(default)]
    pub thread_id: Option<ChatThreadId>,
    /// At most this many messages, 20 when omitted and 100 at most.
    #[serde(default)]
    pub limit: Option<u32>,
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
    /// Only messages in this channel itself, not its threads.
    #[serde(default)]
    pub channel_id: Option<ChatChannelId>,
    /// Only messages in this thread. Without channel_id or thread_id, every message.
    #[serde(default)]
    pub thread_id: Option<ChatThreadId>,
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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct CreateChannel {
    /// The channel's name, shown after `#`; one line of at most 50 characters.
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ListThreads {
    /// Only threads under this channel.
    #[serde(default)]
    pub channel_id: Option<ChatChannelId>,
    /// Only threads that follow this task.
    #[serde(default)]
    pub task_id: Option<TaskId>,
    /// Include archived threads, which are left out otherwise.
    #[serde(default)]
    pub include_archived: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct CreateThread {
    /// The channel to open it under; the first channel when omitted.
    #[serde(default)]
    pub channel_id: Option<ChatChannelId>,
    /// The thread's title; one line of at most 200 characters.
    pub title: String,
    /// The task it follows; the task's detail in the app shows the thread.
    #[serde(default)]
    pub task_id: Option<TaskId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct UpdateThread {
    pub id: ChatThreadId,
    /// A new title.
    #[serde(default)]
    pub title: Option<String>,
    /// open takes messages again; closed ends the conversation; archived also puts it away.
    #[serde(default)]
    pub status: Option<ChatThreadStatus>,
    /// A task for it to follow, replacing any other.
    #[serde(default)]
    pub task_id: Option<TaskId>,
    /// true drops the task it follows; cannot go with task_id.
    #[serde(default)]
    pub unlink_task: bool,
}

pub fn pending_chat(storage: &mut Storage, take: bool) -> CommandResult<Vec<ChatMessage>> {
    let messages = storage.pending_chat_messages(take)?;
    Ok(ChatMessage::all_at(&messages, storage.now()))
}

/// Posts the agent's reply and returns it with how its notification names where it is, or
/// `None` when that channel's notifications are off.
pub fn reply_in_chat(
    storage: &mut Storage,
    request: ReplyInChat,
) -> CommandResult<(ChatMessage, Option<ChatNotice>)> {
    let place = types::place(request.channel_id, request.thread_id)?;
    let actions = types::chat_actions(&request.actions)?;
    let attachments = types::attachment_ids(&request.attachments)?;
    let body = body_with_files(storage, &request.body, &attachments)?;
    let handles: Vec<_> = request.handles.into_iter().map(Into::into).collect();
    let message = storage.post_agent_message(place, &body, &handles, &actions, &attachments)?;
    let notice = storage.chat_notice(message.channel_id, message.thread_id)?;
    Ok((ChatMessage::at(&message, storage.now()), notice))
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
    let place = types::place(request.channel_id, request.thread_id)?;
    let messages = storage.list_chat_messages(place, request.before.map(Into::into), limit)?;
    Ok(ChatMessage::all_at(&messages, storage.now()))
}

pub fn search_chat(storage: &Storage, request: SearchChat) -> CommandResult<Vec<ChatSearchHit>> {
    let query = types::search_query(&request.query)?;
    let place = types::place(request.channel_id, request.thread_id)?;
    let hits = storage.search_chat(&ChatSearch {
        query,
        place,
        limit: request
            .limit
            .unwrap_or(DEFAULT_SEARCH)
            .clamp(1, types::SEARCH_LIMIT),
    })?;
    Ok(ChatSearchHit::all_at(&hits, storage.now()))
}

pub fn list_channels(storage: &Storage) -> CommandResult<Vec<ChatChannel>> {
    Ok(storage
        .list_chat_channels()?
        .iter()
        .map(Into::into)
        .collect())
}

pub fn create_channel(storage: &mut Storage, request: CreateChannel) -> CommandResult<ChatChannel> {
    let name = types::channel_name(&request.name)?;
    Ok((&storage.create_chat_channel(&name)?).into())
}

pub fn list_threads(storage: &Storage, request: ListThreads) -> CommandResult<Vec<ChatThread>> {
    let filter = ChatThreadFilter {
        channel_id: request.channel_id,
        task_id: request.task_id,
        archived: request.include_archived,
    };
    Ok(storage
        .list_chat_threads(filter.into())?
        .iter()
        .map(Into::into)
        .collect())
}

pub fn create_thread(storage: &mut Storage, request: CreateThread) -> CommandResult<ChatThread> {
    let title = types::thread_title(&request.title)?;
    let channel = request.channel_id.map_or(FIRST_CHANNEL, Into::into);
    let created = storage.create_chat_thread(channel, &title, request.task_id.map(Into::into))?;
    Ok((&created).into())
}

pub fn update_thread(storage: &mut Storage, request: UpdateThread) -> CommandResult<ChatThread> {
    let edit = ChatThreadEdit {
        title: request.title,
        status: request.status,
        task_id: request.task_id,
        unlink_task: request.unlink_task,
    }
    .parse()?;
    Ok((&storage.update_chat_thread(request.id.into(), &edit)?).into())
}
