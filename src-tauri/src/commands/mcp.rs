//! How agents connect to Toodo's MCP server.

use super::{CommandResult, State, StorageState, lock};
use serde::Serialize;
use specta::Type;

use crate::commands::types::{ConnectedApp, ConnectedApps, OAuthGrantId, Timestamp};
use crate::mcp::{Rejection, ServerStatus};
use crate::oauth::PublicUrl;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub url: String,
    /// Bearer token agents send in the `Authorization` header.
    pub token: Option<String>,
    /// Why the server is not running, e.g. its port is taken.
    pub error: Option<String>,
    /// Tells this server apart from other Toodo servers; `401` answers from `/mcp` and
    /// the MCP `serverInfo` name it too.
    pub instance: String,
    /// The last request `/mcp` turned away, from agents here or on SSH machines.
    pub last_rejection: Option<McpRejection>,
}

/// Why `/mcp` turned a request away.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum McpRejectionReason {
    /// No `Authorization` header.
    NoHeader,
    /// The header is not `Bearer <token>`.
    NotBearer,
    /// A token this server does not accept, e.g. an old or another server's one.
    WrongToken,
    /// The web sign-in token instead of the MCP token.
    WebToken,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpRejection {
    pub reason: McpRejectionReason,
    pub at: Timestamp,
    /// How many requests `/mcp` turned away since the server started.
    pub count: u32,
}

impl From<&ServerStatus> for McpServerInfo {
    fn from(status: &ServerStatus) -> Self {
        Self {
            url: status.url.clone(),
            token: status.token.clone(),
            error: status.error.clone(),
            instance: status.instance.clone(),
            last_rejection: status.rejections.last().map(|last| McpRejection {
                reason: match last.reason {
                    Rejection::NoHeader => McpRejectionReason::NoHeader,
                    Rejection::NotBearer => McpRejectionReason::NotBearer,
                    Rejection::WrongToken => McpRejectionReason::WrongToken,
                    Rejection::OtherSurfaceToken => McpRejectionReason::WebToken,
                },
                at: Timestamp(last.at),
                count: u32::try_from(last.count).unwrap_or(u32::MAX),
            }),
        }
    }
}

#[specta::specta]
pub fn mcp_server_info(status: State<'_, ServerStatus>) -> McpServerInfo {
    McpServerInfo::from(&*status)
}

/// Lists live OAuth connections and the MCP URL to paste into a chat app.
#[specta::specta]
pub fn list_connected_apps(
    storage: State<'_, StorageState>,
    public_url: State<'_, Option<PublicUrl>>,
) -> CommandResult<ConnectedApps> {
    Ok(ConnectedApps {
        public_mcp_url: public_url.as_ref().map(PublicUrl::resource),
        apps: lock(&storage)
            .oauth_list_grants()?
            .into_iter()
            .map(|grant| ConnectedApp {
                grant_id: OAuthGrantId(grant.id),
                client_name: grant.client_name,
                client_id: grant.client_id,
                scopes: grant.scopes.to_string(),
                created_at: Timestamp(grant.created_at),
                last_used_at: grant.last_used_at.map(Timestamp),
            })
            .collect(),
    })
}

/// Disconnects an app by revoking its whole token family.
#[specta::specta]
pub fn revoke_connected_app(
    storage: State<'_, StorageState>,
    grant_id: OAuthGrantId,
) -> CommandResult<()> {
    Ok(lock(&storage).oauth_revoke_grant(grant_id.0)?)
}
