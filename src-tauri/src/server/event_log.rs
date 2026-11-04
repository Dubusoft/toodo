//! The events of `GET /api/events`, with ids so a client that reconnects gets what it
//! missed.
//!
//! Every event gets an id `<epoch>-<sequence>`: `epoch` is random per server start and
//! `sequence` counts up from 1. The log keeps the most recent [`REPLAY`] events. A stream
//! opened with a `Last-Event-ID` of this epoch first replays the kept events after it; when
//! some of them are gone, or the id is of another server start or not one at all, it
//! starts with a [`RESYNC`] event instead, which tells the client to refetch everything.
//! A stream opened without one starts with a [`READY`] event that carries the current id,
//! so the client has an id to resume from even before the first change. A stream whose
//! reader falls behind the live events also gets a [`RESYNC`] and then goes on.

use std::collections::VecDeque;
use std::sync::{Mutex, PoisonError};

use futures_util::{Stream, StreamExt};
use tokio::sync::broadcast;

/// Tells the client that it missed events and has to refetch everything.
pub(super) const RESYNC: &str = "resync";
/// Opens a stream that resumes nothing, with the id to resume from later.
pub(super) const READY: &str = "ready";

/// Events kept for clients that reconnect, and for streams that read slower than events
/// arrive; a stream that falls further behind gets a [`RESYNC`].
const REPLAY: usize = 256;

/// An event as sent: its id, name, and JSON data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SentEvent {
    pub(super) id: String,
    pub(super) name: &'static str,
    pub(super) data: String,
}

#[derive(Debug, Clone)]
struct Logged {
    sequence: u64,
    name: &'static str,
    data: String,
}

struct State {
    /// The sequence of the last event; 0 before the first.
    last: u64,
    recent: VecDeque<Logged>,
}

pub(super) struct EventLog {
    epoch: String,
    capacity: usize,
    state: Mutex<State>,
    live: broadcast::Sender<Logged>,
}

impl EventLog {
    pub(super) fn new() -> Result<Self, String> {
        let mut bytes = [0u8; 4];
        getrandom::fill(&mut bytes)
            .map_err(|error| format!("cannot pick an event epoch: {error}"))?;
        Ok(Self::with_epoch(
            bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
            REPLAY,
        ))
    }

    fn with_epoch(epoch: String, capacity: usize) -> Self {
        Self {
            epoch,
            capacity,
            state: Mutex::new(State {
                last: 0,
                recent: VecDeque::with_capacity(capacity),
            }),
            live: broadcast::channel(capacity).0,
        }
    }

    fn id(&self, sequence: u64) -> String {
        format!("{}-{sequence}", self.epoch)
    }

    /// Adds an event and sends it to the open streams.
    pub(super) fn send(&self, name: &'static str, data: String) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.last += 1;
        let event = Logged {
            sequence: state.last,
            name,
            data,
        };
        if state.recent.len() == self.capacity {
            state.recent.pop_front();
        }
        state.recent.push_back(event.clone());
        // Sent under the lock, so a stream that subscribes sees each event either in its
        // replay or live, never both or neither. No stream open is the usual case.
        drop(self.live.send(event));
    }

    /// The events of a stream opened with `last_event_id`, then the live ones.
    pub(super) fn stream(
        self: &std::sync::Arc<Self>,
        last_event_id: Option<&str>,
    ) -> impl Stream<Item = SentEvent> + use<> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let receiver = self.live.subscribe();
        let first: Vec<SentEvent> = match last_event_id {
            None => vec![self.marker(READY, state.last)],
            Some(id) => match self.missed(&state, id) {
                Some(missed) => missed,
                None => vec![self.marker(RESYNC, state.last)],
            },
        };
        drop(state);
        let live = Live {
            log: self.clone(),
            receiver,
            skip_through: 0,
        };
        futures_util::stream::iter(first).chain(futures_util::stream::unfold(
            live,
            |mut live| async {
                let event = live.next().await?;
                Some((event, live))
            },
        ))
    }

    fn marker(&self, name: &'static str, sequence: u64) -> SentEvent {
        SentEvent {
            id: self.id(sequence),
            name,
            data: String::new(),
        }
    }

    /// The kept events after `id`, or `None` when the client has to refetch instead.
    fn missed(&self, state: &State, id: &str) -> Option<Vec<SentEvent>> {
        let (epoch, sequence) = id.trim().rsplit_once('-')?;
        let sequence: u64 = sequence.parse().ok()?;
        if epoch != self.epoch || sequence > state.last {
            return None;
        }
        let oldest = state
            .recent
            .front()
            .map_or(state.last + 1, |event| event.sequence);
        if sequence + 1 < oldest {
            return None;
        }
        Some(
            state
                .recent
                .iter()
                .filter(|event| event.sequence > sequence)
                .map(|event| self.sent(event))
                .collect(),
        )
    }

    fn sent(&self, event: &Logged) -> SentEvent {
        SentEvent {
            id: self.id(event.sequence),
            name: event.name,
            data: event.data.clone(),
        }
    }
}

struct Live {
    log: std::sync::Arc<EventLog>,
    receiver: broadcast::Receiver<Logged>,
    /// Events up to this sequence are covered by a [`RESYNC`] already sent.
    skip_through: u64,
}

impl Live {
    async fn next(&mut self) -> Option<SentEvent> {
        loop {
            match self.receiver.recv().await {
                Ok(event) if event.sequence <= self.skip_through => {}
                Ok(event) => return Some(self.log.sent(&event)),
                Err(broadcast::error::RecvError::Lagged(missed)) => {
                    eprintln!("toodo-server: an event stream missed {missed} events; resyncing it");
                    let last = self
                        .log
                        .state
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .last;
                    self.skip_through = last;
                    return Some(self.log.marker(RESYNC, last));
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn log(capacity: usize) -> Arc<EventLog> {
        Arc::new(EventLog::with_epoch("ab12".to_owned(), capacity))
    }

    fn send(log: &EventLog, data: &str) {
        log.send("tasks-changed", data.to_owned());
    }

    /// The `(id, name, data)` of the events `stream` has ready, without waiting for more.
    fn ready(stream: impl Stream<Item = SentEvent>) -> Vec<(String, &'static str, String)> {
        let mut stream = Box::pin(stream);
        let mut events = Vec::new();
        let waker = futures_util::task::noop_waker();
        let mut context = std::task::Context::from_waker(&waker);
        while let std::task::Poll::Ready(Some(event)) = stream.as_mut().poll_next(&mut context) {
            events.push((event.id, event.name, event.data));
        }
        events
    }

    fn event(id: &str, data: &str) -> (String, &'static str, String) {
        (id.to_owned(), "tasks-changed", data.to_owned())
    }

    fn marker(id: &str, name: &'static str) -> (String, &'static str, String) {
        (id.to_owned(), name, String::new())
    }

    #[test]
    fn a_new_stream_starts_with_the_current_id_and_numbers_every_event() {
        let log = log(4);
        send(&log, "1");
        let stream = log.stream(None);
        send(&log, "2");
        assert_eq!(
            ready(stream),
            [marker("ab12-1", READY), event("ab12-2", "2")]
        );
    }

    #[test]
    fn a_reconnecting_stream_replays_the_events_it_missed() {
        let log = log(4);
        for data in ["1", "2", "3"] {
            send(&log, data);
        }
        assert_eq!(
            ready(log.stream(Some("ab12-1"))),
            [event("ab12-2", "2"), event("ab12-3", "3")]
        );
        assert_eq!(ready(log.stream(Some("ab12-3"))), []);
        assert_eq!(ready(log.stream(Some("ab12-0"))).len(), 3);
    }

    #[test]
    fn a_stream_resyncs_when_missed_events_are_gone_or_the_id_is_unknown() {
        let log = log(2);
        for data in ["1", "2", "3", "4"] {
            send(&log, data);
        }
        // Event 2 is gone; 3 and 4 are kept.
        assert_eq!(ready(log.stream(Some("ab12-2"))).len(), 2);
        for id in ["ab12-1", "ab12-5", "ffff-3", "3", "ab12-x", ""] {
            assert_eq!(
                ready(log.stream(Some(id))),
                [marker("ab12-4", RESYNC)],
                "{id:?}"
            );
        }
    }

    #[test]
    fn a_stream_that_fell_behind_resyncs_and_goes_on() {
        let log = log(2);
        let stream = log.stream(None);
        for data in ["1", "2", "3", "4"] {
            send(&log, data);
        }
        let mut stream = Box::pin(stream);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let mut next = || runtime.block_on(stream.next()).map(|event| event.id);
        assert_eq!(next().as_deref(), Some("ab12-0"));
        // Events 1 and 2 were overwritten; the resync covers 3 and 4 too.
        assert_eq!(next().as_deref(), Some("ab12-4"));
        send(&log, "5");
        assert_eq!(next().as_deref(), Some("ab12-5"));
    }
}
