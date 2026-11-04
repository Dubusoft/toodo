//! The logs of plain and tmux runs in pieces, for the log stream and the log download of
//! the server, and the removal of the files of runs that ended long ago.

use super::runs::managed_run;
use super::{CommandResult, PlainRunState, StorageState, TmuxRunState, lock};
use crate::domain::runtime::{RunId, RunnerKind};
use crate::runtime::RuntimeError;
use crate::runtime::log::{self, LogBytes, LogStream};
use crate::storage::StorageError;

/// The event a run gets once its files are removed; its logs are empty from then on.
pub const FILES_REMOVED: &str = "files_removed";

/// The logs of a run, read in pieces.
pub struct LogSource {
    pub run: RunId,
    kind: RunnerKind,
    /// The credential that tmux logs, unlike plain ones, are redacted of as they are read.
    secret: String,
    /// Whether the logs are on an SSH machine, so reading them costs a round trip.
    pub remote: bool,
}

/// A piece of a log: its text, and the offset of the byte after it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogPiece {
    pub text: String,
    pub next: u64,
    /// Whether the piece reaches the end the log had when it was read.
    pub at_end: bool,
}

/// The logs of the plain or tmux run `id`, rejected with the next step for another run.
pub fn log_source(
    storage: &StorageState,
    tmux: &TmuxRunState,
    id: RunId,
) -> CommandResult<LogSource> {
    let run = managed_run(storage, id, "the log of a run")?;
    let secret = if run.runner_kind == RunnerKind::Tmux {
        tmux.log_secret(id)?
    } else {
        String::new()
    };
    Ok(LogSource {
        run: id,
        kind: run.runner_kind,
        secret,
        remote: !matches!(run.host, crate::domain::runtime::HostRef::Local),
    })
}

/// Whether the run `id` ended, so its logs grow no more.
pub fn run_ended(storage: &StorageState, id: RunId) -> CommandResult<bool> {
    let run = lock(storage)
        .get_run(id)?
        .ok_or(StorageError::RunNotFound(id))?;
    Ok(!run.state.is_active())
}

impl LogSource {
    fn read_bytes(
        &self,
        plain: &PlainRunState,
        tmux: &TmuxRunState,
        stream: LogStream,
        offset: u64,
        max: usize,
    ) -> CommandResult<LogBytes> {
        Ok(match self.kind {
            RunnerKind::Tmux => tmux.read_log(self.run, stream, offset, max)?,
            _ => plain
                .read_log(self.run, stream, offset, max)
                .map_err(RuntimeError::from)?,
        })
    }

    /// The next piece of `stream` from `offset`, at most `max` bytes of the log. `ended`
    /// tells that the run ended before the read, so a last unfinished line is passed on.
    pub fn read(
        &self,
        plain: &PlainRunState,
        tmux: &TmuxRunState,
        stream: LogStream,
        offset: u64,
        max: usize,
        ended: bool,
    ) -> CommandResult<LogPiece> {
        let read = self.read_bytes(plain, tmux, stream, offset, max)?;
        let reaches_end = offset + read.bytes.len() as u64 >= read.size;
        let len = log::readable_len(&read.bytes, &self.secret, ended && reaches_end, max);
        Ok(LogPiece {
            text: log::text(&read.bytes[..len], &self.secret),
            next: offset + len as u64,
            at_end: reaches_end && len == read.bytes.len(),
        })
    }

    /// Where the last `tail` bytes of `stream` start: at the start of their first complete
    /// line, so the tail does not open in the middle of one.
    pub fn tail_start(
        &self,
        plain: &PlainRunState,
        tmux: &TmuxRunState,
        stream: LogStream,
        tail: u64,
    ) -> CommandResult<u64> {
        let size = self.read_bytes(plain, tmux, stream, 0, 0)?.size;
        if size <= tail {
            return Ok(0);
        }
        let start = size - tail;
        let head = self.read_bytes(plain, tmux, stream, start, tail.min(64 * 1024) as usize)?;
        Ok(match head.bytes.iter().position(|&byte| byte == b'\n') {
            Some(at) => start + at as u64 + 1,
            None => start,
        })
    }
}

/// Removes the run directories of the plain and tmux runs that ended more than `days` days
/// ago, on the server and on SSH machines, and records [`FILES_REMOVED`] on each. A run
/// whose host cannot be reached keeps its files until a later pass. Returns how many runs
/// lost their files.
pub fn remove_old_run_files(
    storage: &StorageState,
    plain: &PlainRunState,
    tmux: &TmuxRunState,
    days: u32,
) -> CommandResult<usize> {
    let runs = {
        let storage = lock(storage);
        let cutoff = storage.now() - i64::from(days) * 24 * 60 * 60;
        storage.runs_ended_before(cutoff, FILES_REMOVED)?
    };
    let mut removed = 0;
    for run in runs {
        let result = match run.runner_kind {
            RunnerKind::Tmux => tmux.remove_files(&run),
            _ => plain.remove_files(&run),
        };
        match result {
            Ok(()) => {
                lock(storage).append_run_event(
                    run.id,
                    FILES_REMOVED,
                    Some(&format!(
                        "the run directory with the logs was removed, since the run ended \
                         more than {days} days ago"
                    )),
                )?;
                removed += 1;
            }
            Err(error) => eprintln!(
                "toodo-server: could not remove the files of run {} ({error}); a later pass \
                 removes them once its host is reachable",
                run.id
            ),
        }
    }
    Ok(removed)
}
