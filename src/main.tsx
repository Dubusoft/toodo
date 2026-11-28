// First: the stylesheet declares the cascade-layer order every later stylesheet joins.
import "@/index.css";
import { Theme } from "@astryxdesign/core/theme";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import { ErrorBoundary } from "@/components/error-boundary";
import { UpdateBanner } from "@/components/update-banner";
import { toodoTheme } from "@/lib/astryx-theme";
import { flushChatOutbox } from "@/lib/chat-outbox";
import { I18nProvider } from "@/lib/i18n";
import { queryKeys } from "@/lib/queries";
import { initPanelSizes } from "@/lib/panel-sizes";
import { initTheme, useColorMode } from "@/lib/theme";
import { checkForNewBuild, watchBuild } from "@/web/build";
import { watchConnection } from "@/web/connection";
import { watchInstallOffer } from "@/web/install";
import { indexedDbStore, pauseQueriesWhileUnreachable, restoreQueries, saveQueries } from "@/web/query-cache";

initTheme();
initPanelSizes();

// A change waits for no reconnect: while the server is unreachable it fails at once.
const queryClient = new QueryClient({ defaultOptions: { mutations: { networkMode: "always" } } });
const savedQueries = indexedDbStore();

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

/** Astryx components follow the same light or dark mode as the `.dark` class. */
function ThemedApp({ children }: { children: ReactNode }) {
  return (
    <Theme theme={toodoTheme} mode={useColorMode()}>
      {children}
    </Theme>
  );
}

function render(app: ReactNode) {
  root.render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <ThemedApp>
            {/* Outside the boundary: an earlier build that fails against a newer server still offers the reload. */}
            <UpdateBanner />
            <ErrorBoundary label="Toodo" className="m-4">
              {app}
            </ErrorBoundary>
          </ThemedApp>
        </I18nProvider>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

// The app signs in to the server that serves it and follows it.
// The browser may announce that it can install the app before the app has loaded.
watchInstallOffer();
watchConnection();
pauseQueriesWhileUnreachable();
watchBuild();
void Promise.all([
  import("@/components/server-access"),
  import("@/components/offline-screen"),
  import("@/web/event"),
  restoreQueries(queryClient, savedQueries),
]).then(
  ([{ ServerAccess }, { ConnectionGate }, { onReconnect }]) => {
    // Events sent while the stream was down are lost, and what failed while the server was
    // unreachable shows its data again; one recovery tells once (see event.ts).
    onReconnect(() => void queryClient.invalidateQueries());
    // A reconnect or recovery often means the server restarted, perhaps into a new build.
    onReconnect(() => void checkForNewBuild());
    // Chat messages sent while the server was unreachable, or before a reload, go out now.
    const sendChatOutbox = () =>
      void flushChatOutbox(() => queryClient.invalidateQueries({ queryKey: queryKeys.chat }));
    onReconnect(sendChatOutbox);
    sendChatOutbox();
    saveQueries(queryClient, savedQueries);
    // The service worker comes with the built app (see vite-pwa.ts), not the dev server.
    if (import.meta.env.PROD && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
        console.error("Toodo: could not register the service worker", error);
      });
    }
    render(
      <ConnectionGate>
        <ServerAccess>
          <App />
        </ServerAccess>
      </ConnectionGate>,
    );
  },
);
