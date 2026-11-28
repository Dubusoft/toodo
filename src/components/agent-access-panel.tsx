import { useState } from "react";
import { fill, useI18n } from "@/lib/i18n";
import { Button } from "@/components/button";
import type { McpServerInfo } from "@/lib/bindings";
import { useMcpServerInfo } from "@/lib/queries";
import { formatFull, formatWhen } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import type { Messages } from "@/locales/en";
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
export async function testMcpConnection(info: McpServerInfo, t: Messages["settings"]["agentAccess"]): Promise<ConnectionTest> {
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
    return { ok: false, message: text.trim() || t.badResponse(response.status, response.statusText) };
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
    return { ok: false, message: t.wrongInstance(String(title ?? t.noTitle), info.instance) };
  }
  return { ok: true, message: t.connected(info.instance) };
}

/** `url` with a line break opportunity after each "/" that does not start "//", so it never wraps mid-word. */
function breakableUrl(url: string) {
  return url.split(/(?<=\/)(?!\/)/).map((part, index) => (
    <span key={index}>
      {index > 0 && <wbr />}
      {part}
    </span>
  ));
}

export function AgentAccessPanel() {
  const { locale, m } = useI18n();
  const t = m.settings.agentAccess;
  const info = useMcpServerInfo();
  const [notice, setNotice] = useState<string | null>(null);
  const [test, setTest] = useState<ConnectionTest | "testing" | null>(null);

  async function copy(text: string, copied: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(copied);
    } catch (error) {
      setNotice(t.copyFailed(String(error)));
    }
  }

  async function testConnection(data: McpServerInfo) {
    setTest("testing");
    try {
      setTest(await testMcpConnection(data, t));
    } catch (error) {
      setTest({ ok: false, message: t.unreachable(String(error)) });
    }
  }

  const data = info.data;
  const rejection = data?.lastRejection;

  return (
    <section aria-label={m.settings.sections.agents} className="flex flex-col gap-2 text-sm">
      <p className="text-muted-foreground">
        {t.intro}
      </p>
      {data && (
        <>
          <code
            className="overflow-x-auto break-normal rounded bg-muted px-1.5 py-1 [overflow-wrap:normal]"
            aria-label={t.url}
          >
            {breakableUrl(data.url)}
          </code>
          {data.error ? (
            <p role="alert" className="text-destructive">
              {t.notRunning(data.error)}
            </p>
          ) : (
            data.token && (
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="primary"
                  label={t.copyConfig}
                  onClick={() => void copy(mcpConfig(data), t.copiedConfig)}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  label={t.copyToken}
                  onClick={() => void copy(data.token ?? "", t.copiedToken)}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  label={t.testButton}
                  isDisabled={test === "testing"}
                  onClick={() => void testConnection(data)}
                />
              </div>
            )
          )}
          {test && test !== "testing" && (
            <p role="status" aria-label={t.testStatus} className={cn("break-words", !test.ok && "text-destructive")}>
              {test.message}
            </p>
          )}
          <p className="text-muted-foreground">
            {fill(t.tokenHelp, {
              token: <code>web-token</code>,
              instance: <code aria-label={t.instance}>{data.instance}</code>,
              unauthorized: <code>401</code>,
              serverInfo: <code>serverInfo</code>,
            })}
          </p>
          {rejection && (
            <p aria-label={t.rejectionLabel} className="break-words text-destructive">
              {fill(t.rejected, {
                at: <time dateTime={new Date(rejection.at * 1000).toISOString()} title={formatFull(rejection.at, locale)}>
                  {formatWhen(rejection.at, undefined, locale, m)}
                </time>,
                reason: t.reasons[rejection.reason],
                count: rejection.count > 1 ? t.count(rejection.count) : "",
              })}
            </p>
          )}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
