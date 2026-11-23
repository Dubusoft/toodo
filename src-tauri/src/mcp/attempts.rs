//! Rate limiting of failed sign-ins: once an address presents [`MAX_FAILURES`] wrong
//! tokens (or a surface's own limit) within [`WINDOW`], every request from it is turned
//! away with `429` until the window ends, so guessing tokens or hammering the server with
//! a stale one stays slow. Only wrong tokens count; a missing header or the other
//! surface's token does not.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use axum::extract::ConnectInfo;
use axum::http::{Extensions, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};

pub const MAX_FAILURES: u32 = 20;
pub const WINDOW: Duration = Duration::from_secs(60);

/// The most addresses tracked at once: beyond it, ones whose window ended are dropped,
/// and when every window is still open the address whose window started first makes room.
const TRACKED: usize = 1024;

#[derive(Debug, Clone, Copy)]
struct Failures {
    since: Instant,
    count: u32,
}

/// Wrong tokens per address, shared by the requests of one surface.
#[derive(Debug, Clone)]
pub struct FailedAttempts {
    tracked: Arc<Mutex<HashMap<IpAddr, Failures>>>,
    limit: u32,
}

impl Default for FailedAttempts {
    fn default() -> Self {
        Self::with_limit(MAX_FAILURES)
    }
}

impl FailedAttempts {
    /// Locks an address out after `limit` wrong tokens within [`WINDOW`].
    pub fn with_limit(limit: u32) -> Self {
        Self {
            tracked: Arc::default(),
            limit,
        }
    }

    /// How long `peer` must wait before it is heard again, if it is locked out.
    pub fn locked_out(&self, peer: IpAddr) -> Option<Duration> {
        self.locked_out_at(peer, Instant::now())
    }

    pub fn record(&self, peer: IpAddr) {
        self.record_at(peer, Instant::now());
    }

    fn locked_out_at(&self, peer: IpAddr, now: Instant) -> Option<Duration> {
        let failures = *self
            .tracked
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&peer)?;
        let ends = failures.since + WINDOW;
        (failures.count >= self.limit && now < ends).then(|| ends - now)
    }

    fn record_at(&self, peer: IpAddr, now: Instant) {
        let mut tracked = self.tracked.lock().unwrap_or_else(PoisonError::into_inner);
        if tracked.len() >= TRACKED && !tracked.contains_key(&peer) {
            tracked.retain(|_, failures| now < failures.since + WINDOW);
            if tracked.len() >= TRACKED
                && let Some(oldest) = tracked
                    .iter()
                    .min_by_key(|(_, failures)| failures.since)
                    .map(|(address, _)| *address)
            {
                tracked.remove(&oldest);
            }
        }
        let failures = tracked.entry(peer).or_insert(Failures {
            since: now,
            count: 0,
        });
        if now >= failures.since + WINDOW {
            *failures = Failures {
                since: now,
                count: 0,
            };
        }
        failures.count = failures.count.saturating_add(1);
    }
}

/// The address a request came from, given its extensions; requests served without one
/// share a single address.
pub fn peer(extensions: &Extensions) -> IpAddr {
    extensions.get::<ConnectInfo<SocketAddr>>().map_or(
        IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        |ConnectInfo(peer)| match peer.ip() {
            IpAddr::V6(ip) => ip.to_ipv4_mapped().map_or(IpAddr::V6(ip), IpAddr::V4),
            ip => ip,
        },
    )
}

/// `wait` in whole seconds, rounded up, as `Retry-After` gives it.
pub fn retry_seconds(wait: Duration) -> u64 {
    wait.as_secs() + u64::from(wait.subsec_nanos() > 0)
}

/// `429` for an address that is locked out for `wait`, with `Retry-After` in seconds.
pub fn too_many(surface: &str, wait: Duration) -> Response {
    let seconds = retry_seconds(wait);
    let body = format!(
        "Toodo {surface}: too many requests with a wrong token came from this address. Wait \
         {seconds} seconds, then retry with the right token (see the server's data \
         directory: `web-token` for the web app, `mcp-token` for agents); stop clients that \
         still send an old token, or this address is locked out again.\n"
    );
    let mut response = (StatusCode::TOO_MANY_REQUESTS, body).into_response();
    response.headers_mut().insert(
        header::RETRY_AFTER,
        HeaderValue::from_str(&seconds.to_string()).expect("digits are a valid header value"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    const PHONE: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 2));
    const LAPTOP: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 3));

    #[test]
    fn an_address_is_locked_out_after_too_many_wrong_tokens_until_its_window_ends() {
        let attempts = FailedAttempts::default();
        let start = Instant::now();
        for _ in 0..MAX_FAILURES - 1 {
            attempts.record_at(PHONE, start);
        }
        assert_eq!(attempts.locked_out_at(PHONE, start), None);
        let later = start + Duration::from_secs(10);
        attempts.record_at(PHONE, later);
        assert_eq!(
            attempts.locked_out_at(PHONE, later),
            Some(WINDOW - Duration::from_secs(10))
        );
        assert_eq!(attempts.locked_out_at(LAPTOP, later), None);

        let over = start + WINDOW;
        assert_eq!(attempts.locked_out_at(PHONE, over), None);
        // A failure after the window starts counting anew.
        attempts.record_at(PHONE, over);
        assert_eq!(attempts.locked_out_at(PHONE, over), None);
    }

    #[test]
    fn addresses_whose_window_ended_are_forgotten_once_many_are_tracked() {
        let attempts = FailedAttempts::default();
        let start = Instant::now();
        for host in 0..TRACKED as u32 {
            attempts.record_at(IpAddr::V4(Ipv4Addr::from(host)), start);
        }
        attempts.record_at(PHONE, start + WINDOW);
        assert_eq!(attempts.tracked.lock().unwrap().len(), 1);
    }

    #[test]
    fn the_oldest_address_makes_room_when_every_window_is_still_open() {
        let attempts = FailedAttempts::default();
        let start = Instant::now();
        for host in 0..TRACKED as u32 + 10 {
            let at = start + Duration::from_millis(u64::from(host));
            attempts.record_at(IpAddr::V4(Ipv4Addr::from(host)), at);
        }
        let tracked = attempts.tracked.lock().unwrap();
        assert_eq!(tracked.len(), TRACKED);
        assert!(!tracked.contains_key(&IpAddr::V4(Ipv4Addr::from(0))));
        assert!(tracked.contains_key(&IpAddr::V4(Ipv4Addr::from(TRACKED as u32 + 9))));
    }

    #[test]
    fn the_answer_says_how_long_to_wait() {
        let response = too_many("API", Duration::from_millis(1_500));
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()[header::RETRY_AFTER], "2");
    }
}
