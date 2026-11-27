//! Finding earlier chat messages: full-text search over the `chat_search` index, matched as
//! `search_tasks` matches tasks.

use rusqlite::ToSql;

use super::chat::messages_by_id;
use super::search::{TRIGRAM, fts_string, like_pattern};
use super::{Result, Storage};
use crate::domain::chat::{ChatMessage, ChatPlace};

/// What [`Storage::search_chat`] looks for. Every word of `query` (split on whitespace)
/// must appear in a message, as a case-insensitive substring; the words are taken
/// literally, never as search operators. A channel takes in its threads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatSearch<'a> {
    pub query: &'a str,
    pub place: Option<ChatPlace>,
    pub limit: u32,
}

/// A message found, with the names of where it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatHit {
    pub message: ChatMessage,
    pub channel: String,
    pub thread: Option<String>,
}

impl Storage {
    /// The messages matching `search`, best match first, at most `search.limit`. Words of
    /// three or more characters go through the trigram index and rank the results by bm25;
    /// when every word is shorter, the newest messages come first. Ties go to the newer
    /// message. A query without words matches nothing.
    pub fn search_chat(&self, search: &ChatSearch<'_>) -> Result<Vec<ChatHit>> {
        let (indexed, short): (Vec<&str>, Vec<&str>) = search
            .query
            .split_whitespace()
            .partition(|word| word.chars().count() >= TRIGRAM);
        if indexed.is_empty() && short.is_empty() {
            return Ok(Vec::new());
        }
        let mut conditions = Vec::new();
        let mut parameters: Vec<Box<dyn ToSql>> = Vec::new();
        if !indexed.is_empty() {
            conditions.push("chat_search MATCH ?".to_owned());
            let words: Vec<String> = indexed.iter().map(|word| fts_string(word)).collect();
            parameters.push(Box::new(words.join(" ")));
        }
        for word in &short {
            conditions.push("m.body LIKE ? ESCAPE '\\'".to_owned());
            parameters.push(Box::new(like_pattern(word)));
        }
        match search.place {
            Some(ChatPlace::Channel(channel)) => {
                conditions.push("m.channel_id = ?".to_owned());
                parameters.push(Box::new(channel.0));
            }
            Some(ChatPlace::Thread(thread)) => {
                conditions.push("m.thread_id = ?".to_owned());
                parameters.push(Box::new(thread.0));
            }
            None => {}
        }
        parameters.push(Box::new(search.limit));
        let sql = if indexed.is_empty() {
            format!(
                "SELECT m.id FROM chat_messages m WHERE {} ORDER BY m.id DESC LIMIT ?",
                conditions.join(" AND ")
            )
        } else {
            format!(
                "SELECT m.id FROM chat_search JOIN chat_messages m ON m.id = chat_search.rowid
                 WHERE {} ORDER BY bm25(chat_search), m.id DESC LIMIT ?",
                conditions.join(" AND ")
            )
        };
        let ids = self
            .conn
            .prepare(&sql)?
            .query_map(
                rusqlite::params_from_iter(parameters.iter().map(Box::as_ref)),
                |row| row.get(0),
            )?
            .collect::<rusqlite::Result<Vec<i64>>>()?;
        messages_by_id(&self.conn, &ids)?
            .into_iter()
            .map(|message| {
                let (channel, thread) = self.conn.query_row(
                    "SELECT c.name, t.title FROM chat_channels c
                     LEFT JOIN chat_threads t ON t.id = ?2
                     WHERE c.id = ?1",
                    rusqlite::params![message.channel_id.0, message.thread_id.map(|t| t.0)],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                Ok(ChatHit {
                    message,
                    channel,
                    thread,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::chat::{ChatChannelId, FIRST_CHANNEL};

    const GENERAL: ChatPlace = ChatPlace::Channel(FIRST_CHANNEL);

    fn search<'a>(query: &'a str, place: Option<ChatPlace>) -> ChatSearch<'a> {
        ChatSearch {
            query,
            place,
            limit: 20,
        }
    }

    fn bodies(hits: &[ChatHit]) -> Vec<&str> {
        hits.iter().map(|hit| hit.message.body.as_str()).collect()
    }

    #[test]
    fn every_word_must_match_and_short_words_match_as_substrings() {
        let mut storage = Storage::open_in_memory().unwrap();
        storage
            .post_user_message(GENERAL, "Deploy the server tonight", "c1", &[])
            .unwrap();
        storage
            .post_agent_message(None, "The deploy finished; 배포 완료", &[], &[], &[])
            .unwrap();
        storage
            .post_user_message(GENERAL, "Unrelated", "c2", &[])
            .unwrap();
        assert_eq!(
            bodies(&storage.search_chat(&search("DEPLOY", None)).unwrap()).len(),
            2
        );
        assert_eq!(
            bodies(
                &storage
                    .search_chat(&search("deploy tonight", None))
                    .unwrap()
            ),
            ["Deploy the server tonight"]
        );
        // Two-character Korean words cannot use the trigram index.
        assert_eq!(
            bodies(&storage.search_chat(&search("배포", None)).unwrap()),
            ["The deploy finished; 배포 완료"]
        );
        assert!(storage.search_chat(&search("  ", None)).unwrap().is_empty());
        // Operators are plain text.
        assert!(
            storage
                .search_chat(&search("deploy OR unrelated", None))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_channel_takes_in_its_threads_and_hits_name_where_they_are() {
        let mut storage = Storage::open_in_memory().unwrap();
        let work = storage.create_chat_channel("work").unwrap();
        let thread = storage
            .create_chat_thread(work.id, "Release", None)
            .unwrap();
        storage
            .post_user_message(ChatPlace::Thread(thread.id), "Ship it", "c1", &[])
            .unwrap();
        storage
            .post_user_message(GENERAL, "Ship later", "c2", &[])
            .unwrap();
        let hits = storage
            .search_chat(&search("ship", Some(ChatPlace::Channel(work.id))))
            .unwrap();
        assert_eq!(bodies(&hits), ["Ship it"]);
        assert_eq!(
            (hits[0].channel.as_str(), hits[0].thread.as_deref()),
            ("work", Some("Release"))
        );
        let general = storage.search_chat(&search("ship", Some(GENERAL))).unwrap();
        assert_eq!(
            (general[0].channel.as_str(), general[0].thread.as_deref()),
            ("general", None)
        );
        assert!(
            storage
                .search_chat(&search("ship", Some(ChatPlace::Channel(ChatChannelId(9)))))
                .unwrap()
                .is_empty()
        );
    }
}
