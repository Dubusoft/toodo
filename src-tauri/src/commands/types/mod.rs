//! Serializable shapes of the domain model exchanged with the frontend. Inputs are
//! validated when they are converted into domain types.

mod agent_options;
mod agents;
mod backups;
mod criterion;
mod ids;
mod inputs;
mod pull_request_options;
mod review;
mod runs;
mod tasks;
#[cfg(test)]
mod tests;
mod workspaces;

pub use agent_options::*;
pub use agents::*;
pub use backups::*;
pub use criterion::*;
pub use ids::*;
pub use inputs::*;
pub use pull_request_options::*;
pub use review::*;
pub use runs::*;
pub use tasks::*;
pub use workspaces::*;

pub(crate) fn map_all<'a, T: 'a, U: From<&'a T>>(items: &'a [T]) -> Vec<U> {
    items.iter().map(U::from).collect()
}
