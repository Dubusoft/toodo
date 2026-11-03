import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import "@/index.css";
import { initTheme } from "@/lib/theme";
import { onReachable, watchConnection } from "@/web/connection";
import { watchInstallOffer } from "@/web/install";

initTheme();

const queryClient = new QueryClient();

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

function render(app: ReactNode) {
  root.render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>{app}</QueryClientProvider>
    </React.StrictMode>,
  );
}

// The app signs in to the server that serves it and follows it.
// The browser may announce that it can install the app before the app has loaded.
watchInstallOffer();
watchConnection();
void Promise.all([
  import("@/components/server-access"),
  import("@/components/offline-screen"),
  import("@/web/event"),
]).then(
  ([{ ServerAccess }, { ConnectionGate }, { onReconnect }]) => {
    // Events sent while the stream was down are lost; refetch what they would have changed.
    onReconnect(() => void queryClient.invalidateQueries());
    // What failed while the server was unreachable shows its data again.
    onReachable(() => void queryClient.invalidateQueries());
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
