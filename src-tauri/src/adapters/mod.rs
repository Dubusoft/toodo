//! Thin adapters around external tools, so the rest of the app can be tested with
//! fakes instead of real processes.

pub mod git;
pub mod github;
pub mod herdr;
pub mod herdr_events;
pub mod herdr_panes;
pub mod ssh;
pub mod ssh_tunnel;
