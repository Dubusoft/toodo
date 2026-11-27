//! The chat between the people using Toodo and an agent connected over MCP: its channels
//! and the threads under them, who wrote a message, the receipts of the agent's work on a
//! person's message, the actions the agent offers on its messages with the one a person
//! chose, and the files attached to messages.

use super::model::TaskId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ChatMessageId(pub i64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ChatChannelId(pub i64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ChatThreadId(pub i64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ChatAttachmentId(pub i64);

/// How the button of an action looks: plain, the suggested choice, or a destructive one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionStyle {
    Default,
    Primary,
    Danger,
}

impl ActionStyle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Primary => "primary",
            Self::Danger => "danger",
        }
    }

    pub fn parse(stored: &str) -> Option<Self> {
        [Self::Default, Self::Primary, Self::Danger]
            .into_iter()
            .find(|style| style.as_str() == stored)
    }
}

/// A choice the agent offers on its message, shown as a button: `key` is what the agent
/// gets back when a person picks it, `label` what the button says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatAction {
    pub key: String,
    pub label: String,
    pub style: ActionStyle,
}

/// The action a person chose on the agent's message: once chosen, the others are closed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatChoice {
    pub key: String,
    pub at: i64,
    /// The person's message that records the choice, which the agent receives.
    pub choice_id: ChatMessageId,
}

/// The agent's message and action a person's message chose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChoiceOf {
    pub message_id: ChatMessageId,
    pub key: String,
}

/// A file uploaded to the chat, attached to a message once it is sent with one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatAttachment {
    pub id: ChatAttachmentId,
    /// Whose upload it is: a person's goes only on a person's message, the agent's only on
    /// the agent's.
    pub uploader: ChatAuthor,
    pub name: String,
    pub content_type: String,
    /// Bytes.
    pub size: i64,
    pub message_id: Option<ChatMessageId>,
    pub created_at: i64,
}

/// The channel every chat has: the one chat of earlier versions, which cannot be removed.
pub const FIRST_CHANNEL: ChatChannelId = ChatChannelId(1);

/// Where a message is: in a channel itself, or in one of its threads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChatPlace {
    Channel(ChatChannelId),
    Thread(ChatThreadId),
}

/// A channel of the chat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatChannel {
    pub id: ChatChannelId,
    pub name: String,
    /// Whether the agent's messages in the channel and its threads notify devices.
    pub push: bool,
    pub created_at: i64,
    /// Messages of the agent and Toodo not read yet, in the channel and its threads that
    /// are not archived.
    pub unread: i64,
}

/// Whether a thread takes messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadStatus {
    /// It takes messages.
    Open,
    /// Its conversation is over; it takes messages again once reopened.
    Closed,
    /// Closed and put away: left out of the channel's thread list unless asked for.
    Archived,
}

impl ThreadStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
            Self::Archived => "archived",
        }
    }

    pub fn parse(stored: &str) -> Option<Self> {
        [Self::Open, Self::Closed, Self::Archived]
            .into_iter()
            .find(|status| status.as_str() == stored)
    }
}

/// A thread under a channel, which may follow a task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatThread {
    pub id: ChatThreadId,
    pub channel_id: ChatChannelId,
    pub title: String,
    pub task_id: Option<TaskId>,
    pub status: ThreadStatus,
    pub created_at: i64,
    /// Set while it is closed or archived.
    pub closed_at: Option<i64>,
    /// Set while it is archived.
    pub archived_at: Option<i64>,
    /// Messages of the agent and Toodo in it not read yet.
    pub unread: i64,
    /// When its latest message was posted.
    pub last_message_at: Option<i64>,
}

/// Who wrote a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatAuthor {
    /// A person, in the web app.
    User,
    /// The agent connected over MCP.
    Agent,
    /// Toodo itself, e.g. the report of a finished task.
    System,
}

impl ChatAuthor {
    /// The stored name. The agent's messages keep the name of the earlier lead chat, so its
    /// conversation reads on.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Agent => "lead",
            Self::System => "system",
        }
    }

    pub fn parse(stored: &str) -> Option<Self> {
        [Self::User, Self::Agent, Self::System]
            .into_iter()
            .find(|author| author.as_str() == stored)
    }
}

/// How long the agent has to acknowledge or handle a person's message before it is
/// overdue, in seconds.
pub const ANSWER_WITHIN: i64 = 10 * 60;

/// A message of the chat. The receipts are set only on a person's messages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMessage {
    pub id: ChatMessageId,
    pub channel_id: ChatChannelId,
    pub thread_id: Option<ChatThreadId>,
    pub author: ChatAuthor,
    pub body: String,
    /// Unix seconds, as are the receipts.
    pub at: i64,
    /// When the agent received the message.
    pub delivered_at: Option<i64>,
    /// When the agent acknowledged it.
    pub acked_at: Option<i64>,
    /// When the agent handled it, with its reply or the task made for it.
    pub handled_at: Option<i64>,
    pub handled_reply_id: Option<ChatMessageId>,
    pub handled_task_id: Option<TaskId>,
    /// When the message becomes overdue unless it is handled; `None` for messages stored
    /// before receipts existed.
    pub due_at: Option<i64>,
    /// The choices the agent offers on its message, in order.
    pub actions: Vec<ChatAction>,
    /// The action a person chose among them.
    pub chosen: Option<ChatChoice>,
    /// On a person's message that records a choice: what it chose.
    pub choice_of: Option<ChoiceOf>,
    pub attachments: Vec<ChatAttachment>,
}

impl ChatMessage {
    /// Whether the agent let a person's message wait past its due time.
    pub fn overdue(&self, now: i64) -> bool {
        self.handled_at.is_none() && self.due_at.is_some_and(|due| due <= now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authors_round_trip_their_stored_names() {
        for author in [ChatAuthor::User, ChatAuthor::Agent, ChatAuthor::System] {
            assert_eq!(ChatAuthor::parse(author.as_str()), Some(author));
        }
        assert_eq!(ChatAuthor::Agent.as_str(), "lead");
        assert_eq!(ChatAuthor::parse("agent"), None);
    }

    #[test]
    fn thread_statuses_round_trip_their_stored_names() {
        for status in [
            ThreadStatus::Open,
            ThreadStatus::Closed,
            ThreadStatus::Archived,
        ] {
            assert_eq!(ThreadStatus::parse(status.as_str()), Some(status));
        }
        assert_eq!(ThreadStatus::parse("deleted"), None);
    }

    #[test]
    fn action_styles_round_trip_their_stored_names() {
        for style in [
            ActionStyle::Default,
            ActionStyle::Primary,
            ActionStyle::Danger,
        ] {
            assert_eq!(ActionStyle::parse(style.as_str()), Some(style));
        }
        assert_eq!(ActionStyle::parse("link"), None);
    }

    #[test]
    fn only_unhandled_messages_past_their_due_time_are_overdue() {
        let message = ChatMessage {
            id: ChatMessageId(1),
            channel_id: FIRST_CHANNEL,
            thread_id: None,
            author: ChatAuthor::User,
            body: "Hi".to_owned(),
            at: 0,
            delivered_at: None,
            acked_at: None,
            handled_at: None,
            handled_reply_id: None,
            handled_task_id: None,
            due_at: Some(10),
            actions: Vec::new(),
            chosen: None,
            choice_of: None,
            attachments: Vec::new(),
        };
        assert!(!message.overdue(9));
        assert!(message.overdue(10));
        let handled = ChatMessage {
            handled_at: Some(5),
            acked_at: Some(5),
            ..message.clone()
        };
        assert!(!handled.overdue(10));
        let legacy = ChatMessage {
            due_at: None,
            ..message
        };
        assert!(!legacy.overdue(10));
    }
}
