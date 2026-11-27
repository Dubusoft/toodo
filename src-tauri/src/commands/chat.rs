//! Commands for the chat with the agent connected over MCP: the app reads the latest
//! messages and sends a person's messages; the agent's side is in `mcp::tools::chat`.
use std::sync::Mutex;

use super::types::{self, ChatAgent, ChatMessage, ChatMessageId, ChatView, Timestamp};
use super::{CommandResult, State, StorageState, lock};

/// How many messages the app loads at a time.
const PAGE: usize = 50;

/// How long the agent counts as writing after it says so, in seconds, unless it says so
/// again or posts.
pub const TYPING_FOR: i64 = 30;

/// What the server keeps about the chat besides its messages: how the app shows the
/// agent, and until when the agent said it is writing.
#[derive(Debug)]
pub struct ChatState {
    agent: ChatAgent,
    typing_until: Mutex<Option<i64>>,
}

impl ChatState {
    pub fn new(agent: ChatAgent) -> Self {
        Self {
            agent,
            typing_until: Mutex::new(None),
        }
    }

    pub fn agent(&self) -> &ChatAgent {
        &self.agent
    }

    /// Records whether the agent is writing, as of `now`, and returns until when.
    pub fn set_typing(&self, typing: bool, now: i64) -> Option<i64> {
        let until = typing.then_some(now + TYPING_FOR);
        *self
            .typing_until
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = until;
        until
    }

    fn typing_until(&self, now: i64) -> Option<i64> {
        self.typing_until
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .filter(|until| *until > now)
    }
}

/// The latest messages before `before` (the latest of all without it), and what the agent
/// is doing.
#[specta::specta]
pub fn list_chat(
    storage: State<'_, StorageState>,
    chat: State<'_, ChatState>,
    before: Option<ChatMessageId>,
) -> CommandResult<ChatView> {
    let storage = lock(&storage);
    let now = storage.now();
    // One more than a page tells whether earlier messages remain.
    let mut messages = storage.list_chat_messages(before.map(Into::into), PAGE + 1)?;
    let has_earlier = messages.len() > PAGE;
    if has_earlier {
        messages.remove(0);
    }
    Ok(ChatView {
        agent: chat.agent.clone(),
        messages: ChatMessage::all_at(&messages, now),
        has_earlier,
        typing_until: chat.typing_until(now).map(Timestamp),
    })
}

/// Sends a person's message to the agent. `client_id` names it, so sending it again after a
/// lost answer stores it once.
#[specta::specta]
pub fn send_chat_message(
    storage: State<'_, StorageState>,
    body: String,
    client_id: String,
) -> CommandResult<ChatMessage> {
    let body = types::chat_body(&body)?;
    let client_id = types::client_id(&client_id)?;
    let mut storage = lock(&storage);
    let message = storage.post_user_message(&body, client_id)?;
    Ok(ChatMessage::at(&message, storage.now()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;

    fn state() -> ChatState {
        ChatState::new(ChatAgent {
            name: "Agent".to_owned(),
            avatar_url: None,
        })
    }

    #[test]
    fn a_page_tells_whether_earlier_messages_remain() {
        let storage = Mutex::new(Storage::open_in_memory().unwrap());
        let chat = state();
        for n in 0..=PAGE {
            send_chat_message(State(&storage), format!("m{n}"), format!("c{n}")).unwrap();
        }
        let latest = list_chat(State(&storage), State(&chat), None).unwrap();
        assert_eq!((latest.messages.len(), latest.has_earlier), (PAGE, true));
        let earlier =
            list_chat(State(&storage), State(&chat), Some(latest.messages[0].id)).unwrap();
        assert_eq!((earlier.messages.len(), earlier.has_earlier), (1, false));
        assert_eq!(earlier.messages[0].body, "m0");
    }

    #[test]
    fn typing_lasts_until_it_runs_out_or_is_turned_off() {
        let chat = state();
        assert_eq!(chat.set_typing(true, 100), Some(100 + TYPING_FOR));
        assert_eq!(
            chat.typing_until(100 + TYPING_FOR - 1),
            Some(100 + TYPING_FOR)
        );
        assert_eq!(chat.typing_until(100 + TYPING_FOR), None);
        chat.set_typing(true, 100);
        assert_eq!(chat.set_typing(false, 101), None);
        assert_eq!(chat.typing_until(101), None);
    }

    #[test]
    fn blank_messages_and_bad_client_ids_are_refused() {
        let storage = Mutex::new(Storage::open_in_memory().unwrap());
        assert!(send_chat_message(State(&storage), " ".into(), "c1".into()).is_err());
        assert!(send_chat_message(State(&storage), "Hi".into(), "".into()).is_err());
        let sent = send_chat_message(State(&storage), " Hi ".into(), "c1".into()).unwrap();
        assert_eq!(sent.body, "Hi");
    }
}
