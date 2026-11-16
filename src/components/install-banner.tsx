import { useState, useSyncExternalStore } from "react";
import { Download, Share } from "lucide-react";
import { Button } from "@/components/button";
import { tonePanel } from "@/lib/status-styles";
import { cn } from "@/lib/utils";
import { dismissInstall, install, installOffer, subscribeInstallOffer } from "@/web/install";

export function InstallBanner() {
  const offer = useSyncExternalStore(subscribeInstallOffer, installOffer);
  const [installing, setInstalling] = useState(false);
  if (offer === "none") {
    return null;
  }

  const run = () => {
    setInstalling(true);
    void install().finally(() => setInstalling(false));
  };

  return (
    <div
      role="region"
      aria-label="Install Toodo"
      className={cn("mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3 py-2", tonePanel.info)}
    >
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <p className="text-sm font-medium">Install Toodo on this device</p>
        <p className="text-xs break-words">
          {offer === "prompt" ? (
            "It opens in its own window and can show notifications."
          ) : (
            <>
              Tap <Share aria-label="Share" className="inline size-3.5 align-text-bottom" />, then{" "}
              <span className="font-medium">Add to Home Screen</span>. Notifications need the installed app.
            </>
          )}
        </p>
      </div>
      <div className="flex gap-1 max-md:gap-2">
        {offer === "prompt" && (
          <Button size="sm" variant="primary" label="Install" icon={<Download />} isDisabled={installing} onClick={run} />
        )}
        <Button
          size="sm"
          variant="secondary"
          label={offer === "prompt" ? "Not now" : "Dismiss"}
          onClick={dismissInstall}
        />
      </div>
    </div>
  );
}
