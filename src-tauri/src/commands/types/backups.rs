use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Number;

use super::Timestamp;
use crate::commands::{CommandError, CommandResult};
use crate::domain::backup;
use crate::storage;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BackupSettings {
    pub enabled: bool,
    pub interval_hours: u32,
    /// Number of automatic backups kept; older ones are deleted.
    pub keep: u32,
}

impl TryFrom<BackupSettings> for backup::BackupSettings {
    type Error = CommandError;

    fn try_from(settings: BackupSettings) -> CommandResult<Self> {
        Self {
            enabled: settings.enabled,
            interval_hours: settings.interval_hours,
            keep: settings.keep,
        }
        .validate()
        .map_err(|error| CommandError::invalid_input(error.to_string()))
    }
}

impl From<backup::BackupSettings> for BackupSettings {
    fn from(settings: backup::BackupSettings) -> Self {
        Self {
            enabled: settings.enabled,
            interval_hours: settings.interval_hours,
            keep: settings.keep,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BackupKind {
    Automatic,
    PreRestore,
}

/// A backup in Toodo's backup directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub path: String,
    pub kind: BackupKind,
    pub created_at: Timestamp,
    #[specta(type = Number)]
    pub size_bytes: u64,
}

impl From<&storage::BackupFile> for BackupEntry {
    fn from(file: &storage::BackupFile) -> Self {
        Self {
            path: file.path.display().to_string(),
            kind: match file.kind {
                backup::BackupKind::Automatic => BackupKind::Automatic,
                backup::BackupKind::PreRestore => BackupKind::PreRestore,
            },
            created_at: Timestamp(file.created_at),
            size_bytes: file.size_bytes,
        }
    }
}
