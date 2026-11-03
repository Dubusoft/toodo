//! Core domain model and rules. Pure logic: no I/O, no Tauri, no storage.

pub mod backup;
pub mod criteria;
pub mod dag;
pub mod device;
pub mod issue;
pub mod model;
pub mod naming;
pub mod path;
pub mod plan;
pub mod push;
pub mod remote;
pub mod review;
pub mod slug;
pub mod ssh_config;
pub mod status;
pub mod timeline;
