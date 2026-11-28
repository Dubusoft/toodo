import { useState, useSyncExternalStore } from "react";
import { Download, Share } from "lucide-react";
import { Button } from "@/components/button";
import { fill, useMessages } from "@/lib/i18n";
import { tonePanel } from "@/lib/status-styles";
import { cn } from "@/lib/utils";
import { dismissInstall, install, installOffer, subscribeInstallOffer } from "@/web/install";

export function InstallBanner() {
  const { app: { install: copy } } = useMessages();
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
      aria-label={copy.region}
      className={cn("mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3 py-2", tonePanel.info)}
    >
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <p className="text-sm font-medium">{copy.title}</p>
        <p className="text-xs break-words">
          {offer === "prompt" ? copy.prompt : fill(copy.homeScreen, {
            share: <Share aria-label={copy.share} className="inline size-3.5 align-text-bottom" />,
            add: <span className="font-medium">{copy.addToHomeScreen}</span>,
          })}
        </p>
      </div>
      <div className="flex gap-1 max-md:gap-2">
        {offer === "prompt" && (
          <Button size="sm" variant="primary" label={copy.action} icon={<Download />} isDisabled={installing} onClick={run} />
        )}
        <Button
          size="sm"
          variant="secondary"
          label={offer === "prompt" ? copy.notNow : copy.dismiss}
          onClick={dismissInstall}
        />
      </div>
    </div>
  );
}
