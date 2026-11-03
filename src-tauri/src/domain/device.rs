//! Devices that use `toodo-server`: each browser or client gets its own access token, so
//! one device can be revoked without changing the token of every other one. The server
//! keeps only a hash of each token.

use std::fmt;

/// A device's stable id, for anything kept per device (e.g. notification subscriptions).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DeviceId(pub i64);

impl fmt::Display for DeviceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    pub id: DeviceId,
    pub label: DeviceLabel,
    /// Unix seconds.
    pub created_at: i64,
    /// When the device last made a request, to within [`LAST_SEEN_PRECISION`] seconds.
    pub last_seen_at: i64,
    /// Set once the device's token stops working; it never works again.
    pub revoked_at: Option<i64>,
}

/// How stale a device's last-seen time may get, so that a request writes it at most this
/// often instead of on every request.
pub const LAST_SEEN_PRECISION: i64 = 60;

/// A device's name, as its owner recognizes it: trimmed, not empty, one line, at most
/// [`DeviceLabel::MAX_CHARS`] characters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceLabel(String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceLabelError {
    Empty,
    TooLong,
    ControlCharacter,
}

impl fmt::Display for DeviceLabelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(f, "device name is empty"),
            Self::TooLong => write!(
                f,
                "device name is longer than {} characters",
                DeviceLabel::MAX_CHARS
            ),
            Self::ControlCharacter => write!(f, "device name must be a single line of text"),
        }
    }
}

impl std::error::Error for DeviceLabelError {}

impl DeviceLabel {
    pub const MAX_CHARS: usize = 80;

    pub fn parse(label: &str) -> Result<Self, DeviceLabelError> {
        let label = label.trim();
        if label.is_empty() {
            Err(DeviceLabelError::Empty)
        } else if label.chars().count() > Self::MAX_CHARS {
            Err(DeviceLabelError::TooLong)
        } else if label.chars().any(char::is_control) {
            Err(DeviceLabelError::ControlCharacter)
        } else {
            Ok(Self(label.to_owned()))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_trimmed_single_lines_of_bounded_length() {
        assert_eq!(DeviceLabel::parse("  Phone  ").unwrap().as_str(), "Phone");
        assert_eq!(DeviceLabel::parse(" \t"), Err(DeviceLabelError::Empty));
        assert_eq!(
            DeviceLabel::parse("Work\nlaptop"),
            Err(DeviceLabelError::ControlCharacter)
        );
        let longest = "\u{d3f0}".repeat(DeviceLabel::MAX_CHARS);
        assert_eq!(DeviceLabel::parse(&longest).unwrap().as_str(), longest);
        assert_eq!(
            DeviceLabel::parse(&format!("{longest}x")),
            Err(DeviceLabelError::TooLong)
        );
    }
}
