//! How agents connect to Toodo's MCP server.

use super::State;
use serde::Serialize;
use specta::Type;

use crate::commands::types::Timestamp;
use crate::mcp::tunnels::{TunnelState, TunnelStatus, TunnelsState};
use crate::mcp::{Rejection, ServerStatus};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum McpTunnelState {
    Connecting,
    Open,
    Retrying,
}

/// The reverse tunnel that lets agents on one SSH machine reach the MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpTunnel {
    pub machine: String,
    pub state: McpTunnelState,
    /// Why the last tunnel ended, until a new one is open.
    pub error: Option<String>,
}

impl From<TunnelStatus> for McpTunnel {
    fn from(status: TunnelStatus) -> Self {
        Self {
            machine: status.machine.as_str().to_owned(),
            state: match status.state {
                TunnelState::Connecting => McpTunnelState::Connecting,
                TunnelState::Open => McpTunnelState::Open,
                TunnelState::Retrying => McpTunnelState::Retrying,
            },
            error: status.error,
        }
    }
}

#[specta::specta]
pub fn list_mcp_tunnels(tunnels: State<'_, TunnelsState>) -> Vec<McpTunnel> {
    let tunnels = tunnels
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    tunnels.statuses().into_iter().map(Into::into).collect()
}
