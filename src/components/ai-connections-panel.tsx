import { Card } from "@astryxdesign/core/Card";
import { CodingAgentsCard } from "@/components/agent-access-panel";
import { ChatAppsCard } from "@/components/connected-apps-panel";
import { useMessages } from "@/lib/i18n";

/**
 * Settings > AI app connections: the other AI apps that read and change the tasks, coding agents
 * and, in public mode, chat apps.
 */
export function AiConnectionsPanel() {
  const m = useMessages();
  return (
    <section aria-label={m.settings.sections.connections} className="flex flex-col gap-4 text-sm break-words-keep">
      <p className="text-muted-foreground">{m.settings.connections.intro}</p>
      <ChatAppsCard />
      <Card>
        <CodingAgentsCard />
      </Card>
    </section>
  );
}
