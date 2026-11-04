//! Reading run logs in pieces, from a byte offset: for streaming a live log and for
//! sending a whole one, rather than only its end.
//!
//! Offsets count the bytes of the log file as the runner wrote it. A piece ends where the
//! text can be cut safely: after the last complete line, so a credential is never split
//! between two pieces and redacted in neither, and never inside a UTF-8 character.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// A log of a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogStream {
    Stdout,
    Stderr,
}

impl LogStream {
    pub const ALL: [Self; 2] = [Self::Stdout, Self::Stderr];

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|stream| stream.as_wire() == value)
    }

    /// The file the runners write the log to, in the run directory.
    pub fn file_name(self) -> &'static str {
        match self {
            Self::Stdout => "stdout.log",
            Self::Stderr => "stderr.log",
        }
    }
}

/// Bytes of a log from an offset, and the size of the log when they were read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LogBytes {
    pub size: u64,
    pub bytes: Vec<u8>,
}

/// Reads at most `max` bytes of the file at `path` from `offset`; a missing file is an
/// empty log.
pub fn read_file(path: &Path, offset: u64, max: usize) -> std::io::Result<LogBytes> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LogBytes::default());
        }
        Err(error) => return Err(error),
    };
    let size = file.metadata()?.len();
    let mut bytes = Vec::new();
    if offset < size {
        file.seek(SeekFrom::Start(offset))?;
        file.take(max as u64).read_to_end(&mut bytes)?;
    }
    Ok(LogBytes {
        size: size.max(offset + bytes.len() as u64),
        bytes,
    })
}

/// Removes the directory at `path` with everything in it; a missing one is no error.
pub fn remove_dir(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// How many of `bytes` can be passed on now. All of them when the log is `complete`,
/// i.e. the run ended and they reach the end of its log. Otherwise up to the end of the
/// last complete line; and when `bytes` hold no line end but fill `max`, a line too long
/// to wait for, all but as many bytes as `secret` has, cut before any occurrence of
/// `secret` that would straddle the cut and never inside a UTF-8 character.
pub fn readable_len(bytes: &[u8], secret: &str, complete: bool, max: usize) -> usize {
    if complete {
        return bytes.len();
    }
    if let Some(at) = bytes.iter().rposition(|&byte| byte == b'\n') {
        return at + 1;
    }
    if bytes.len() < max {
        return 0;
    }
    let mut cut = bytes.len().saturating_sub(secret.len());
    let secret = secret.as_bytes();
    if !secret.is_empty() {
        let mut start = 0;
        while let Some(found) = bytes[start..]
            .windows(secret.len())
            .position(|window| window == secret)
        {
            let at = start + found;
            if at >= cut {
                break;
            }
            if at + secret.len() > cut {
                cut = at;
                break;
            }
            start = at + secret.len();
        }
    }
    char_boundary(bytes, cut)
}

/// `cut`, or the start of the UTF-8 character that `bytes[..cut]` ends in the middle of.
fn char_boundary(bytes: &[u8], cut: usize) -> usize {
    for back in 1..=cut.min(3) {
        let byte = bytes[cut - back];
        if byte & 0b1100_0000 == 0b1000_0000 {
            continue;
        }
        let width = match byte {
            0xF0.. => 4,
            0xE0.. => 3,
            0xC0.. => 2,
            _ => 1,
        };
        return if width > back { cut - back } else { cut };
    }
    cut
}

/// The text of a readable piece of a log, with `secret` redacted.
pub fn text(bytes: &[u8], secret: &str) -> String {
    super::plain::adapter::redact(&String::from_utf8_lossy(bytes), secret)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_live_log_is_read_up_to_its_last_complete_line() {
        assert_eq!(readable_len(b"one\ntwo\nthr", "", false, 64), 8);
        assert_eq!(readable_len(b"partial", "", false, 64), 0);
        assert_eq!(readable_len(b"partial", "", true, 64), 7);
    }

    #[test]
    fn a_long_line_is_cut_before_a_secret_and_a_character() {
        let secret = "s3cret-token";
        let mut line = vec![b'a'; 100];
        line[80..92].copy_from_slice(secret.as_bytes());
        assert_eq!(readable_len(&line, secret, false, line.len()), 80);
        assert_eq!(readable_len(&line[..60], secret, false, 60), 48);

        let mut wide = b"aaaa".to_vec();
        wide.extend_from_slice("한".as_bytes());
        assert_eq!(readable_len(&wide, "", false, wide.len()), 7);
        assert_eq!(readable_len(&wide[..6], "", false, 6), 4);
    }

    #[test]
    fn a_file_is_read_from_an_offset_and_a_missing_one_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stdout.log");
        assert_eq!(read_file(&path, 0, 8).unwrap(), LogBytes::default());
        std::fs::write(&path, b"0123456789").unwrap();
        let read = read_file(&path, 4, 3).unwrap();
        assert_eq!((read.size, read.bytes.as_slice()), (10, &b"456"[..]));
        assert!(read_file(&path, 20, 3).unwrap().bytes.is_empty());
    }
}
