//! The chat between the people using Toodo and an agent connected over MCP: who wrote a
//! message, and the receipts of the agent's work on a person's message.

use super::model::TaskId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ChatMessageId(pub i64);

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
    fn only_unhandled_messages_past_their_due_time_are_overdue() {
        let message = ChatMessage {
            id: ChatMessageId(1),
            author: ChatAuthor::User,
            body: "Hi".to_owned(),
            at: 0,
            delivered_at: None,
            acked_at: None,
            handled_at: None,
            handled_reply_id: None,
            handled_task_id: None,
            due_at: Some(10),
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
