import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { McpRejectionReason, McpServerInfo, McpTunnel, McpTunnelState } from "@/lib/bindings";
import { useMcpServerInfo, useMcpTunnels } from "@/lib/queries";
import { formatFull, formatWhen } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import { toneFill } from "@/lib/status-styles";
import { serverFetch } from "@/web/connection";

export function mcpConfig(info: McpServerInfo): string {
  const server = {
    type: "http",
    url: info.url,
    headers: { Authorization: `Bearer ${info.token ?? ""}` },
  };
  return JSON.stringify({ mcpServers: { toodo: server } }, null, 2);
}

export type ConnectionTest = { ok: boolean; message: string };

/**
 * Sends the MCP `initialize` an agent sends, with the token shown, to this server's `/mcp`, and tells whether the server
 * accepted it and is the instance shown; a 401 gives the server's reason.
 */
export async function testMcpConnection(info: McpServerInfo): Promise<ConnectionTest> {
  const headers = {
    Authorization: `Bearer ${info.token ?? ""}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "toodo-web", version: "1" } },
  };
  const response = await serverFetch("/mcp", { method: "POST", headers, body: JSON.stringify(initialize) });
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, message: text.trim() || `The MCP server answered ${response.status} ${response.statusText}.` };
  }
  const session = response.headers.get("mcp-session-id");
  if (session) {
    // The test needs no session; end it rather than leave it open on the server.
    void serverFetch("/mcp", { method: "DELETE", headers: { ...headers, "mcp-session-id": session } }).catch(() => {});
  }
  let title: unknown;
  try {
    title = JSON.parse(text)?.result?.serverInfo?.title;
  } catch {
    title = undefined;
  }
  if (typeof title !== "string" || !title.includes(info.instance)) {
    return { ok: false, message: `The answer came from another server (${String(title ?? "no server title")}), not instance ${info.instance}.` };
  }
  return { ok: true, message: `Connected: instance ${info.instance} accepts this token.` };
}

const rejectionReasons: Record<McpRejectionReason, string> = {
  no_header: "no Authorization header",
  not_bearer: "the header was not Bearer <token>",
  wrong_token: "a token this server does not accept (old, mistyped, or another server's)",
  web_token: "the web sign-in token instead of the MCP token",
};

/** `url` with a line break opportunity after each "/" that does not start "//", so it never wraps mid-word. */
function breakableUrl(url: string) {
  return url.split(/(?<=\/)(?!\/)/).map((part, index) => (
    <span key={index}>
      {index > 0 && <wbr />}
      {part}
    </span>
  ));
}

const tunnelStates: Record<McpTunnelState, { label: string; className: string }> = {
  open: { label: "Connected", className: toneFill.success },
  connecting: { label: "Connecting", className: toneFill.attention },
  retrying: { label: "Retrying", className: "bg-destructive" },
};

function TunnelList({ tunnels }: { tunnels: McpTunnel[] }) {
  if (tunnels.length === 0) return null;
  return (
    <ul aria-label="Remote machines" className="flex flex-col gap-1">
      {tunnels.map((tunnel) => {
        const state = tunnelStates[tunnel.state];
        return (
          <li key={tunnel.machine} aria-label={`Tunnel to ${tunnel.machine}`} className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", state.className)} />
              <span className="truncate font-medium">{tunnel.machine}</span>
              <span className="text-muted-foreground">{state.label}</span>
            </span>
            {tunnel.error && <span className="break-words text-destructive">{tunnel.error}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** How many tunnels to SSH machines are retrying, shown next to the Agent access settings; nothing while none is. */
export function AgentAccessStatus() {
  const tunnels = useMcpTunnels();
  const retrying = (tunnels.data ?? []).filter((tunnel) => tunnel.state === "retrying").length;
  if (retrying === 0) return null;
  return (
    <span className="text-destructive">{retrying === 1 ? "1 tunnel retrying" : `${retrying} tunnels retrying`}</span>
  );
}

export function AgentAccessPanel() {
  const info = useMcpServerInfo();
  const tunnels = useMcpTunnels();
  const [notice, setNotice] = useState<string | null>(null);
  const [test, setTest] = useState<ConnectionTest | "testing" | null>(null);

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`Copied ${what}.`);
    } catch (error) {
      setNotice(`Could not copy: ${String(error)}`);
    }
  }

  async function testConnection(data: McpServerInfo) {
    setTest("testing");
    try {
      setTest(await testMcpConnection(data));
    } catch (error) {
      setTest({ ok: false, message: `Could not reach the MCP server: ${String(error)}` });
    }
  }

  const data = info.data;
  const rejection = data?.lastRejection;

  return (
    <section aria-label="Agent access" className="flex flex-col gap-2 text-sm">
      <p className="text-muted-foreground">
        Agents on the server can plan tasks and connect dependencies through the Toodo server's MCP endpoint.
      </p>
      {data && (
        <>
          <code
            className="overflow-x-auto break-normal rounded bg-muted px-1.5 py-1 [overflow-wrap:normal]"
            aria-label="MCP server URL"
          >
            {breakableUrl(data.url)}
          </code>
          {data.error ? (
            <p role="alert" className="text-destructive">
              MCP server is not running: {data.error}
            </p>
          ) : (
            data.token && (
              <div className="flex flex-wrap gap-1.5">
                <Button size="xs" onClick={() => void copy(mcpConfig(data), "the MCP config")}>
                  Copy MCP config
                </Button>
                <Button size="xs" variant="outline" onClick={() => void copy(data.token ?? "", "the MCP token for agents")}>
                  Copy MCP token for agents
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={test === "testing"}
                  onClick={() => void testConnection(data)}
                >
                  Test connection
                </Button>
              </div>
            )
          )}
          {test && test !== "testing" && (
            <p role="status" aria-label="Connection test" className={cn("break-words", !test.ok && "text-destructive")}>
              {test.message}
            </p>
          )}
          <p className="text-muted-foreground">
            The MCP token is for agents only; the web app signs in with the server's web token (<code>web-token</code>).
            Server instance <code aria-label="Server instance">{data.instance}</code>, which agents see in{" "}
            <code>401</code> replies and <code>serverInfo</code>.
          </p>
          {rejection && (
            <p aria-label="Last rejected agent request" className="break-words text-destructive">
              Last rejected agent request{" "}
              <time dateTime={new Date(rejection.at * 1000).toISOString()} title={formatFull(rejection.at)}>
                {formatWhen(rejection.at)}
              </time>
              : {rejectionReasons[rejection.reason]}
              {rejection.count > 1 && ` (${rejection.count} since the server started)`}.
            </p>
          )}
          {!data.error && (
            <>
              <p className="text-muted-foreground">
                Agents on SSH machines use the same config: the server forwards its port to each machine with a workspace.
              </p>
              <TunnelList tunnels={tunnels.data ?? []} />
            </>
          )}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
