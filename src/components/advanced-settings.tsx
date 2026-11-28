import type { ReactNode } from "react";
import { AgentConnectionDetails } from "@/components/agent-access-panel";
import { DoriConfigPanel, useDoriConfig } from "@/components/dori-config-panel";
import { SupervisorStatusPanel } from "@/components/supervisor-status-panel";
import { useMessages } from "@/lib/i18n";

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="font-medium">{title}</h4>
      {children}
    </div>
  );
}

/**
 * Settings > Advanced, the last section: what whoever runs the server and Dori looks at when
 * something is wrong. The coding agents' token, Dori's status in full, its config file key by
 * key, and why the update check failed. It follows Dori only while `active` (shown).
 */
export function AdvancedSettings({ active, updateError }: { active: boolean; updateError: string | null }) {
  const m = useMessages();
  const t = m.settings.advanced;
  const dori = useDoriConfig().data;
  return (
    <section aria-label={m.settings.sections.advanced} className="flex flex-col gap-6 text-sm">
      <p className="text-muted-foreground">{t.intro}</p>
      <Block title={t.agentConnection}>
        <AgentConnectionDetails />
      </Block>
      {dori?.present && (
        <Block title={t.supervisor}>
          <SupervisorStatusPanel active={active} />
        </Block>
      )}
      {dori && (
        <Block title={t.doriConfig}>
          <DoriConfigPanel active={active} />
        </Block>
      )}
      {updateError !== null && (
        <Block title={t.updateCheck}>
          <p className="break-words text-muted-foreground">{m.settings.updateCheckFailed(updateError)}</p>
        </Block>
      )}
    </section>
  );
}
