import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { When } from "@/components/when";
import { escapeCloses } from "@/components/workspace-list";
import { commands, type ConnectedApp } from "@/lib/bindings";
import { unwrap } from "@/lib/queries";

const connectedAppsKey = ["connected-apps"];

/** What the scopes of an app let it do; `toodo.write` includes reading. */
function accessLabel(scopes: string): string {
  return scopes.split(" ").includes("toodo.write") ? "Read and write access" : "Read access";
}

/** The MCP URL chat apps connect to in public mode, or how to turn public mode on. */
function PublicMcpUrl({ url }: { url: string | null }) {
  const [notice, setNotice] = useState<string | null>(null);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied the MCP URL.");
    } catch (error) {
      setNotice(`Could not copy (${String(error)}). Select the URL and copy it by hand.`);
    }
  }

  if (url === null) {
    return (
      <p className="text-muted-foreground">
        To connect ChatGPT or Claude, restart the server with <code>TOODO_PUBLIC_URL</code> set to the{" "}
        <code>https://</code> origin they reach it at; see <code>docs/server.md</code>.
      </p>
    );
  }
  return (
    <>
      <p className="text-muted-foreground">
        Add this URL to ChatGPT or Claude as a remote MCP connector with OAuth, leaving client ID and secret empty, then
        approve the app with <code>web-token</code>.
      </p>
      <code
        className="overflow-x-auto break-normal rounded bg-muted px-1.5 py-1 [overflow-wrap:normal]"
        aria-label="Public MCP URL"
      >
        {url}
      </code>
      <Button size="xs" className="self-start" onClick={() => void copy(url)}>
        Copy MCP URL
      </Button>
      {notice && <p role="status">{notice}</p>}
    </>
  );
}

function AppRow({ app }: { app: ConnectedApp }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () => unwrap(commands.revokeConnectedApp(app.grantId)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectedAppsKey }),
  });
  // An app that registered without a name goes by its client ID.
  const name = app.clientName ?? app.clientId;

  return (
    <li aria-label={`App ${name}`} className="flex flex-col gap-0.5">
      <span className="truncate font-medium">{name}</span>
      <span className="text-muted-foreground">{accessLabel(app.scopes)}</span>
      <span className="text-muted-foreground">
        <When at={app.createdAt} prefix="Connected " />
        {" · "}
        {app.lastUsedAt === null ? "Not used yet" : <When at={app.lastUsedAt} prefix="Last used " />}
      </span>
      {confirming ? (
        <div
          role="alertdialog"
          aria-label={`Confirm revoke of ${name}`}
          className="flex flex-col gap-1 rounded-md border border-destructive/40 p-2"
          onKeyDown={escapeCloses(() => setConfirming(false), revoke.isPending)}
        >
          <p>The app's tokens stop working at once; to use it later, connect it again from the app.</p>
          <div className="flex gap-1">
            <Button changesData size="xs" variant="destructive" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
              Revoke
            </Button>
            <Button size="xs" variant="ghost" autoFocus onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </div>
        </div>
      ) : (
        <Button size="xs" variant="outline" className="self-start" aria-label={`Revoke ${name}`} onClick={() => setConfirming(true)}>
          Revoke
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
  const connected = useQuery({ queryKey: connectedAppsKey, queryFn: () => unwrap(commands.listConnectedApps()) });

  return (
    <section aria-label="Connected apps" className="flex flex-col gap-2 text-sm">
      {connected.error && (
        <p role="alert" className="break-words text-destructive">
          {connected.error.message}
        </p>
      )}
      {connected.data && (
        <>
          <PublicMcpUrl url={connected.data.publicMcpUrl} />
          {connected.data.apps.length === 0 ? (
            <p className="text-muted-foreground">No apps connected yet.</p>
          ) : (
            <ul aria-label="Apps with access" className="flex flex-col gap-2">
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
