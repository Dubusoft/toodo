import { useState } from "react";
import { fill, useI18n, useMessages } from "@/lib/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/button";
import { formatFull, formatWhen } from "@/lib/timeline";
import { escapeCloses } from "@/components/workspace-list";
import { commands, type ConnectedApp } from "@/lib/bindings";
import { unwrap } from "@/lib/queries";

const connectedAppsKey = ["connected-apps"];

/** The MCP URL chat apps connect to in public mode, or how to turn public mode on. */
function PublicMcpUrl({ url }: { url: string | null }) {
  const m = useMessages();
  const t = m.settings.connectedApps;
  const [notice, setNotice] = useState<string | null>(null);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(t.copied);
    } catch (error) {
      setNotice(t.copyFailed(String(error)));
    }
  }

  if (url === null) {
    return (
      <p className="text-muted-foreground">
        {fill(t.publicSetup, { env: <code>TOODO_PUBLIC_URL</code>, scheme: <code>https://</code>, docs: <code>docs/server.md</code> })}
      </p>
    );
  }
  return (
    <>
      <p className="text-muted-foreground">
        {fill(t.connector, { token: <code>web-token</code> })}
      </p>
      <code
        className="overflow-x-auto break-normal rounded bg-muted px-1.5 py-1 [overflow-wrap:normal]"
        aria-label={t.url}
      >
        {url}
      </code>
      <Button size="sm" variant="primary" className="self-start" label={t.copy} onClick={() => void copy(url)} />
      {notice && <p role="status">{notice}</p>}
    </>
  );
}

function AppRow({ app }: { app: ConnectedApp }) {
  const { locale, m } = useI18n();
  const t = m.settings.connectedApps;
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () => unwrap(commands.revokeConnectedApp(app.grantId)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectedAppsKey }),
  });
  // An app that registered without a name goes by its client ID.
  const name = app.clientName ?? app.clientId;

  return (
    <li aria-label={t.app(name)} className="flex flex-col gap-0.5">
      <span className="truncate font-medium">{name}</span>
      <span className="text-muted-foreground">{app.scopes.split(" ").includes("toodo.write") ? t.readWrite : t.read}</span>
      <span className="text-muted-foreground">
        <time dateTime={new Date(app.createdAt * 1000).toISOString()} title={formatFull(app.createdAt, locale)}>{t.connected(formatWhen(app.createdAt, undefined, locale, m))}</time>
        {" · "}
        {app.lastUsedAt === null ? t.notUsed : <time dateTime={new Date(app.lastUsedAt * 1000).toISOString()} title={formatFull(app.lastUsedAt, locale)}>{t.used(formatWhen(app.lastUsedAt, undefined, locale, m))}</time>}
      </span>
      {confirming ? (
        <div
          role="alertdialog"
          aria-label={t.confirm(name)}
          className="flex flex-col gap-1 rounded-md border border-destructive/40 p-2"
          onKeyDown={escapeCloses(() => setConfirming(false), revoke.isPending)}
        >
          <p>{t.revokeExplanation}</p>
          <div className="flex gap-1">
            <Button
              changesData
              size="sm"
              variant="destructive"
              label={t.revoke}
              isDisabled={revoke.isPending}
              onClick={() => revoke.mutate()}
            />
            <Button size="sm" variant="ghost" label={t.keep} autoFocus onClick={() => setConfirming(false)} />
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          className="self-start"
          label={t.revokeNamed(name)}
          onClick={() => setConfirming(true)}
        >
          {t.revoke}
        </Button>
      )}
      {revoke.error && (
        <p role="alert" className="break-words text-destructive">
          {revoke.error.message}
        </p>
      )}
    </li>
  );
}

/** Chat apps such as ChatGPT and Claude that the owner approved over OAuth, and where they connect. */
export function ConnectedAppsPanel() {
  const m = useMessages();
  const t = m.settings.connectedApps;
  const connected = useQuery({ queryKey: connectedAppsKey, queryFn: () => unwrap(commands.listConnectedApps()) });

  return (
    <section aria-label={m.settings.sections.apps} className="flex flex-col gap-2 text-sm">
      {connected.error && (
        <p role="alert" className="break-words text-destructive">
          {connected.error.message}
        </p>
      )}
      {connected.data && (
        <>
          <PublicMcpUrl url={connected.data.publicMcpUrl} />
          {connected.data.apps.length === 0 ? (
            <p className="text-muted-foreground">{t.empty}</p>
          ) : (
            <ul aria-label={t.list} className="flex flex-col gap-2">
              {connected.data.apps.map((app) => (
                <AppRow key={app.grantId} app={app} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
