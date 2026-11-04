//! Runtime records: the runner workspaces tasks are open in, and the runs (agent
//! launches) made in them. Wire strings match the CHECK constraints of the
//! `runtime_workspaces`, `agent_conversations`, `task_runs`, and `run_operations` tables.

use std::fmt;

use super::model::Machine;

/// Placeholder for a later tenant context. Nothing filters or authenticates by it yet.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct OwnerKey(pub String);

impl OwnerKey {
    pub fn implicit() -> Self {
        Self("implicit".to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RunId(pub i64);

impl fmt::Display for RunId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RuntimeWorkspaceId(pub i64);

/// A wire string that names no known value of a runtime enum.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownWireValue {
    pub kind: &'static str,
    pub value: String,
}

impl fmt::Display for UnknownWireValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown {} {:?}", self.kind, self.value)
    }
}

impl std::error::Error for UnknownWireValue {}

fn unknown<T>(kind: &'static str, value: &str) -> Result<T, UnknownWireValue> {
    Err(UnknownWireValue {
        kind,
        value: value.to_owned(),
    })
}

/// The host a runtime workspace or run lives on: `local`, or `ssh:<target>` for a saved
/// herdr SSH machine.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum HostRef {
    Local,
    Ssh(String),
}

impl HostRef {
    const SSH_PREFIX: &'static str = "ssh:";

    pub fn as_wire(&self) -> String {
        match self {
            Self::Local => "local".to_owned(),
            Self::Ssh(target) => format!("{}{target}", Self::SSH_PREFIX),
        }
    }

    pub fn parse(raw: &str) -> Result<Self, UnknownWireValue> {
        if raw == "local" {
            return Ok(Self::Local);
        }
        match raw.strip_prefix(Self::SSH_PREFIX) {
            Some(target) if !target.is_empty() => Ok(Self::Ssh(target.to_owned())),
            _ => unknown("host reference", raw),
        }
    }
}

impl From<&Machine> for HostRef {
    fn from(machine: &Machine) -> Self {
        match machine {
            Machine::Local => Self::Local,
            Machine::Ssh(label) => Self::Ssh(label.as_str().to_owned()),
        }
    }
}

impl fmt::Display for HostRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.as_wire())
    }
}

/// Declares a fieldless enum with its wire strings, `as_wire`, `parse`, and `Display`.
macro_rules! wire_enum {
    ($(#[$meta:meta])* $name:ident, $kind:literal, { $($variant:ident => $wire:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            #[cfg(test)]
            pub(crate) const ALL: &'static [Self] = &[$(Self::$variant),+];

            pub fn as_wire(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire),+
                }
            }

            pub fn parse(raw: &str) -> Result<Self, UnknownWireValue> {
                match raw {
                    $($wire => Ok(Self::$variant),)+
                    _ => unknown($kind, raw),
                }
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_wire())
            }
        }
    };
}

wire_enum!(
    /// What runs agents for a task. Herdr is the default; `Plain` runs agent CLIs as
    /// managed processes on the host; `Tmux` uses a POSIX tmux session; `None` records
    /// tasks worked on by hand.
    RunnerKind, "runner kind", { Herdr => "herdr", None => "none", Plain => "plain", Tmux => "tmux" }
);

wire_enum!(
    /// A writer may change its checkout, so only one writer is active per checkout; an
    /// observer only reads.
    RunRole, "run role", { Writer => "writer", Observer => "observer" }
);

wire_enum!(
    /// Where a run is in its life.
    RunState, "run state", {
        Reserved => "reserved",
        Running => "running",
        Settled => "settled",
        Exited => "exited",
        Failed => "failed",
        Cancelled => "cancelled",
        Unknown => "unknown",
    }
);

impl RunState {
    /// Whether the run may still be writing to its checkout. `Unknown` counts as active:
    /// a run whose fate is not confirmed may still be writing.
    pub fn is_active(self) -> bool {
        matches!(self, Self::Reserved | Self::Running | Self::Unknown)
    }
}

wire_enum!(
    /// A request made to the runner for a run.
    OperationKind, "operation kind", { Launch => "launch", Input => "input", Stop => "stop" }
);

wire_enum!(
    OperationState, "operation state", {
        Pending => "pending",
        Applied => "applied",
        Failed => "failed",
    }
);

wire_enum!(
    /// How an agent conversation can be resumed.
    ResumeKind, "resume kind", {
        None => "none",
        ExactId => "exact_id",
        ExactPath => "exact_path",
        NamedSession => "named_session",
        Transcript => "transcript",
    }
);

wire_enum!(
    /// What the agent in a task's herdr workspace is doing, as herdr reports it for its
    /// panes. Wire strings match the CHECK constraint of `agent_status_transitions`.
    AgentState, "agent state", {
        Idle => "idle",
        Working => "working",
        Blocked => "blocked",
        Done => "done",
    }
);

/// Tokens an agent reported using in a run. `input_tokens` includes the cached ones.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RunUsage {
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::model::MachineLabel;

    #[test]
    fn owner_key_defaults_to_implicit() {
        assert_eq!(OwnerKey::implicit().as_str(), "implicit");
    }

    #[test]
    fn host_refs_round_trip_and_come_from_machines() {
        let ssh = HostRef::from(&Machine::Ssh(MachineLabel::parse("devbox").unwrap()));
        assert_eq!(ssh, HostRef::Ssh("devbox".to_owned()));
        assert_eq!(ssh.as_wire(), "ssh:devbox");
        assert_eq!(HostRef::from(&Machine::Local).as_wire(), "local");
        for host in [HostRef::Local, ssh] {
            assert_eq!(HostRef::parse(&host.as_wire()), Ok(host));
        }
        for bad in ["", "ssh:", "remote", "LOCAL"] {
            assert!(HostRef::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn wire_strings_round_trip() {
        fn check<T: Copy + PartialEq + fmt::Debug>(
            all: &[T],
            wire: fn(T) -> &'static str,
            parse: fn(&str) -> Result<T, UnknownWireValue>,
        ) {
            for value in all {
                assert_eq!(parse(wire(*value)), Ok(*value));
            }
            assert!(parse("bogus").is_err());
        }
        check(RunnerKind::ALL, RunnerKind::as_wire, RunnerKind::parse);
        check(RunRole::ALL, RunRole::as_wire, RunRole::parse);
        check(RunState::ALL, RunState::as_wire, RunState::parse);
        check(
            OperationKind::ALL,
            OperationKind::as_wire,
            OperationKind::parse,
        );
        check(
            OperationState::ALL,
            OperationState::as_wire,
            OperationState::parse,
        );
        check(ResumeKind::ALL, ResumeKind::as_wire, ResumeKind::parse);
        check(AgentState::ALL, AgentState::as_wire, AgentState::parse);
        assert_eq!(RunState::ALL.len(), 7);
        assert_eq!(ResumeKind::NamedSession.as_wire(), "named_session");
    }

    #[test]
    fn reserved_running_and_unknown_runs_are_active() {
        let active: Vec<RunState> = RunState::ALL
            .iter()
            .copied()
            .filter(|state| state.is_active())
            .collect();
        assert_eq!(
            active,
            [RunState::Reserved, RunState::Running, RunState::Unknown]
        );
    }
}
