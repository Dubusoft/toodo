import { CircleCheck, CircleDashed, CircleAlert } from "lucide-react";
import { agentNames } from "@/components/runners-panel";
import { useRunnerHealth } from "@/lib/queries";
import { toneText } from "@/lib/status-styles";
import { cn } from "@/lib/utils";

const quickstartUrl = "https://github.com/dev-bokdong/toodo/blob/main/docs/quickstart.md";

type ItemState = "ready" | "missing" | "unchecked";

type Item = { name: string; state: ItemState; detail: string };

const stateLabels: Record<ItemState, string> = { ready: "ready", missing: "not ready", unchecked: "not checked" };

function ItemIcon({ state }: { state: ItemState }) {
  const className = "mt-0.5 size-4 shrink-0";
  if (state === "ready") return <CircleCheck aria-hidden className={cn(className, toneText.success)} />;
  if (state === "missing") return <CircleAlert aria-hidden className={cn(className, toneText.attention)} />;
  return <CircleDashed aria-hidden className={cn(className, "text-muted-foreground")} />;
}

/**
 * What the server needs before the first workspace: git, ssh, and a signed-in gh, which Toodo
 * does not check here, and an agent CLI and herdr, as the runner check of the server reports them.
 */
export function PrerequisiteChecklist() {
  const health = useRunnerHealth().data;
  const agent = health?.agents.find((candidate) => candidate.installed);
  const items: Item[] = [
    {
      name: "git and OpenSSH",
      state: "unchecked",
      detail: "On the server's PATH: Toodo runs git for branches and worktrees, and ssh for workspaces on other machines.",
    },
    {
      name: "GitHub CLI",
      state: "unchecked",
      detail: "Run gh auth login on the server; workspaces with a GitHub repository open their pull requests with gh.",
    },
    {
      name: "Claude or Codex CLI",
      state: health === undefined ? "unchecked" : agent ? "ready" : "missing",
      detail: agent
        ? `${agentNames[agent.adapter]} found at ${agent.path ?? "the server's PATH"}.`
        : (health?.agents.find((candidate) => candidate.message !== null)?.message ??
          "Runners plain and tmux start the claude or codex CLI from the server's PATH."),
    },
    {
      name: "herdr (optional)",
      state: health?.herdr.running ? "ready" : "unchecked",
      detail: health?.herdr.running
        ? `herdr${health.herdr.version === null ? "" : ` v${health.herdr.version}`} is running.`
        : "Only workspaces with runner herdr need it; runner plain works without it.",
    },
  ];
  return (
    <div className="flex w-full max-w-md flex-col gap-2 text-left">
      <h3 className="text-xs font-medium uppercase text-muted-foreground">Before you start</h3>
      <ul aria-label="Prerequisites" className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.name} aria-label={`${item.name}: ${stateLabels[item.state]}`} className="flex gap-2 text-xs">
            <ItemIcon state={item.state} />
            <span className="min-w-0">
              <span className="font-medium">{item.name}</span>{" "}
              <span className="break-words text-muted-foreground">{item.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      <a
        href={quickstartUrl}
        target="_blank"
        rel="noreferrer"
        className="self-start text-xs font-medium underline underline-offset-4"
      >
        Read the quickstart
      </a>
    </div>
  );
}
