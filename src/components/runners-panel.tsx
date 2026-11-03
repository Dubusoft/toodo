import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentAdapter, AgentHealth, HerdrHealth, TmuxHealth } from "@/lib/bindings";
import { useRunnerHealth } from "@/lib/queries";
import { toneChip, type Tone } from "@/lib/status-styles";
import { cn } from "@/lib/utils";

/** Whether a runner can start agents, named and coloured in the tones of the status glossary. */
type Readiness = { label: string; tone: Tone };

const agentNames: Record<AgentAdapter, string> = { claude: "Claude", codex: "Codex" };

function herdrReadiness(herdr: HerdrHealth): Readiness {
  if (herdr.running) return { label: "Running", tone: "success" };
  return { label: herdr.installed ? "Not running" : "Not installed", tone: "attention" };
}

function tmuxReadiness(tmux: TmuxHealth): Readiness {
  return tmux.installed ? { label: "Installed", tone: "success" } : { label: "Not installed", tone: "attention" };
}

function agentReadiness(agent: AgentHealth): Readiness {
  return agent.installed ? { label: "Installed", tone: "success" } : { label: "Not installed", tone: "attention" };
}

/** `text` ending as a sentence, so that another one can follow it. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function ReadinessChip({ readiness }: { readiness: Readiness }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        toneChip[readiness.tone],
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {readiness.label}
    </span>
  );
}

/**
 * One tool the server starts agents with: whether it is ready, its version or where it was
 * found, and the server's next step while it is not ready.
 */
function RunnerRow({
  name,
  readiness,
  detail,
  message,
}: {
  name: string;
  readiness: Readiness;
  detail: string | null;
  message: string | null;
}) {
  return (
    <li aria-label={name} className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="w-14 shrink-0 font-medium">{name}</span>
        <ReadinessChip readiness={readiness} />
        {/* A phone has no room for a path beside the state: it goes on its own line. */}
        {detail !== null && (
          <span className="min-w-0 font-mono text-xs break-all text-muted-foreground max-md:basis-full md:ml-auto">
            {detail}
          </span>
        )}
      </div>
      {message !== null && <p className="text-xs break-words">{message}</p>}
    </li>
  );
}

/**
 * What the server starts agents with: herdr for workspaces with runner herdr, tmux for local
 * workspaces with runner tmux, and the Claude and Codex CLIs of runner plain and tmux. A tool
 * that is not ready shows the server's next step.
 */
export function RunnersPanel() {
  const health = useRunnerHealth();
  const data = health.data;

  return (
    <section aria-label="Runners" className="flex flex-col gap-3 text-sm">
      <p className="text-muted-foreground">
        The tools this server starts agents with: herdr for workspaces with runner herdr, tmux for local workspaces
        with runner tmux, and the Claude or Codex CLI for runner plain and tmux. Runner plain works without herdr. SSH
        workspaces use the tmux and agent CLIs of their host.
      </p>
      {health.isPending && <p className="text-muted-foreground">Checking the runners...</p>}
      {health.isError && (
        <p role="alert" className="break-words text-destructive">
          Failed to check the runners: {sentence(health.error.message)} Press Refresh to check again.
        </p>
      )}
      {data && (
        <ul aria-label="Runners on this server" className="flex min-w-0 flex-col divide-y rounded-lg border">
          <RunnerRow
            name="herdr"
            readiness={herdrReadiness(data.herdr)}
            detail={data.herdr.version === null ? null : `v${data.herdr.version}`}
            message={data.herdr.message}
          />
          <RunnerRow
            name="tmux"
            readiness={tmuxReadiness(data.tmux)}
            detail={data.tmux.version}
            message={data.tmux.message}
          />
          {data.agents.map((agent) => (
            <RunnerRow
              key={agent.adapter}
              name={agentNames[agent.adapter]}
              readiness={agentReadiness(agent)}
              detail={agent.path}
              message={agent.message}
            />
          ))}
        </ul>
      )}
      <Button
        size="xs"
        variant="outline"
        className="self-start"
        aria-label="Refresh runners"
        title="Check herdr, tmux, and the agent CLIs on the server again"
        disabled={health.isFetching}
        onClick={() => void health.refetch()}
      >
        <RefreshCw className={cn(health.isFetching && "animate-spin")} />
        Refresh
      </Button>
    </section>
  );
}
