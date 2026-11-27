use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Number;

use super::{TaskId, Timestamp};
use crate::commands::{CommandError, CommandResult};
use crate::domain::chat::{self, ChatAuthor as Author};

/// The most characters a chat message may have, after trimming.
pub const CHAT_BODY_LIMIT: usize = 8000;

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
                "id": 3, "author": "agent", "body": "Hello", "at": 5, "deliveredAt": null,
                "ackedAt": null, "handledAt": null, "handledReplyId": null,
                "handledTaskId": null, "overdue": false
            })
        );
    }
}
