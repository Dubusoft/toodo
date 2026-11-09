//! Serializable shapes of the domain model exchanged with the frontend. Inputs are
//! validated when they are converted into domain types.

mod backups;
mod criterion;
mod guidelines;
mod ids;
mod inputs;
mod review;
mod tasks;
#[cfg(test)]
mod tests;
mod workspaces;

pub use backups::*;
pub use criterion::*;
pub use guidelines::*;
pub use ids::*;
pub use inputs::*;
pub use review::*;
pub use tasks::*;
pub use workspaces::*;

pub(crate) fn map_all<'a, T: 'a, U: From<&'a T>>(items: &'a [T]) -> Vec<U> {
    items.iter().map(U::from).collect()
}
