//! Web Push subscriptions of `toodo-server` devices: where a device's browser receives
//! notifications while Toodo is closed, and which kinds of notification it wants.

use std::fmt;

use super::device::DeviceId;

/// The kinds of notification a device can turn on and off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PushKind {
    /// An agent finished its turn or needs input.
    Agent,
    /// The CI checks of a task's pull request passed or failed, or a reviewer approved it
    /// or requested changes.
    PullRequests,
    /// A task is awaiting completion.
    Completion,
}

/// Which kinds of notification a device receives. New subscriptions receive every kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PushSettings {
    pub agent: bool,
    pub pull_requests: bool,
    pub completion: bool,
}

impl Default for PushSettings {
    fn default() -> Self {
        Self {
            agent: true,
            pull_requests: true,
            completion: true,
        }
    }
}

impl PushSettings {
    pub fn allows(self, kind: PushKind) -> bool {
        match kind {
            PushKind::Agent => self.agent,
            PushKind::PullRequests => self.pull_requests,
            PushKind::Completion => self.completion,
        }
    }
}

/// The length of a subscription's public key: an uncompressed P-256 point.
pub const P256DH_LEN: usize = 65;

/// The length of a subscription's authentication secret.
pub const AUTH_LEN: usize = 16;

/// The longest endpoint URL accepted; push services hand out a few hundred characters.
pub const MAX_ENDPOINT_LEN: usize = 2048;

/// Where and how to reach one device's browser: the push service URL it subscribed at and
/// the keys that encrypt messages for it (RFC 8291).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushSubscription {
    pub device: DeviceId,
    pub endpoint: PushEndpoint,
    pub p256dh: [u8; P256DH_LEN],
    pub auth: [u8; AUTH_LEN],
    pub settings: PushSettings,
    /// Unix seconds.
    pub created_at: i64,
}

/// A push service URL: `https`, one line, at most [`MAX_ENDPOINT_LEN`] bytes. The server
/// posts to it, so plain HTTP is refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushEndpoint(String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushSubscriptionError {
    EndpointNotHttps,
    EndpointTooLong,
    BadP256dh,
    BadAuth,
}

impl fmt::Display for PushSubscriptionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EndpointNotHttps => write!(f, "push endpoint must be an https URL"),
            Self::EndpointTooLong => write!(
                f,
                "push endpoint is longer than {MAX_ENDPOINT_LEN} characters"
            ),
            Self::BadP256dh => write!(
                f,
                "push subscription key p256dh must be an uncompressed P-256 public key"
            ),
            Self::BadAuth => write!(f, "push subscription key auth must be {AUTH_LEN} bytes"),
        }
    }
}

impl std::error::Error for PushSubscriptionError {}

impl PushEndpoint {
    pub fn parse(url: &str) -> Result<Self, PushSubscriptionError> {
        if url.len() > MAX_ENDPOINT_LEN {
            return Err(PushSubscriptionError::EndpointTooLong);
        }
        let host = url
            .strip_prefix("https://")
            .ok_or(PushSubscriptionError::EndpointNotHttps)?;
        let host_end = host.find(['/', '?', '#']).unwrap_or(host.len());
        if host_end == 0 || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(PushSubscriptionError::EndpointNotHttps);
        }
        Ok(Self(url.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// `https://host[:port]`, the audience of the VAPID token for this endpoint.
    pub fn origin(&self) -> &str {
        let rest = &self.0["https://".len()..];
        let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        &self.0[..("https://".len() + host_end)]
    }
}

/// Checks the shape of a subscription's keys: the point format and the secret's length.
/// Whether the point is on the curve is checked when a message is encrypted for it.
pub fn subscription_keys(
    p256dh: &[u8],
    auth: &[u8],
) -> Result<([u8; P256DH_LEN], [u8; AUTH_LEN]), PushSubscriptionError> {
    let p256dh: [u8; P256DH_LEN] = p256dh
        .try_into()
        .ok()
        .filter(|key: &[u8; P256DH_LEN]| key[0] == 0x04)
        .ok_or(PushSubscriptionError::BadP256dh)?;
    let auth: [u8; AUTH_LEN] = auth
        .try_into()
        .map_err(|_| PushSubscriptionError::BadAuth)?;
    Ok((p256dh, auth))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_are_https_urls_with_a_host() {
        let endpoint = PushEndpoint::parse("https://fcm.googleapis.com/fcm/send/abc").unwrap();
        assert_eq!(endpoint.origin(), "https://fcm.googleapis.com");
        assert_eq!(
            PushEndpoint::parse("https://push.example:8443?x=1")
                .unwrap()
                .origin(),
            "https://push.example:8443"
        );
        for bad in [
            "http://fcm.googleapis.com/fcm/send/abc",
            "https:///path",
            "https://",
            "https://host/a b",
            "ftp://host",
        ] {
            assert_eq!(
                PushEndpoint::parse(bad),
                Err(PushSubscriptionError::EndpointNotHttps),
                "{bad}"
            );
        }
        let long = format!("https://host/{}", "a".repeat(MAX_ENDPOINT_LEN));
        assert_eq!(
            PushEndpoint::parse(&long),
            Err(PushSubscriptionError::EndpointTooLong)
        );
    }

    #[test]
    fn keys_must_be_an_uncompressed_point_and_a_16_byte_secret() {
        let mut point = [7u8; P256DH_LEN];
        point[0] = 4;
        assert!(subscription_keys(&point, &[1; AUTH_LEN]).is_ok());
        assert_eq!(
            subscription_keys(&point[..64], &[1; AUTH_LEN]),
            Err(PushSubscriptionError::BadP256dh)
        );
        let mut compressed = point;
        compressed[0] = 2;
        assert_eq!(
            subscription_keys(&compressed, &[1; AUTH_LEN]),
            Err(PushSubscriptionError::BadP256dh)
        );
        assert_eq!(
            subscription_keys(&point, &[1; 15]),
            Err(PushSubscriptionError::BadAuth)
        );
    }

    #[test]
    fn settings_filter_their_kind() {
        let settings = PushSettings {
            agent: false,
            ..PushSettings::default()
        };
        assert!(!settings.allows(PushKind::Agent));
        assert!(settings.allows(PushKind::PullRequests));
        assert!(settings.allows(PushKind::Completion));
    }
}
