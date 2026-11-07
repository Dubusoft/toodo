import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceList } from "@/components/workspace-list";
import type { AgentCapabilities, HerdrHealth, RunnerHealth, Workspace } from "@/lib/bindings";
/** What Claude and Codex can do in runs, as `runner_health` reports it. */
const agentCapabilities: AgentCapabilities = {
  mcp: true,
  resume: true,
  todo: true,
  model: true,
  permissionModes: ["read_only", "edit", "bypass"],
};

import {
  completionLabels,
  completionProblem,
  repositoryProblem,
  runnerLabels,
  runnerLocationProblem,
  runnerProblem,
  sourceLabels,
} from "@/lib/workspace-axes";

const mutation = { mutate: vi.fn(), isPending: false, isError: false };
const query = <T,>(data: T) => ({ data, isPending: false, isError: false });
let workspaces: Workspace[] = [];
let home = "/home/me";

const ready: RunnerHealth = {
  herdr: { installed: true, running: true, version: "0.9.5", message: null },
  tmux: { installed: true, version: "tmux 3.6", message: null },
  tools: [
    { tool: "git", installed: true, ready: true, version: "git version 2.43.0", message: null },
    { tool: "gh", installed: true, ready: true, version: "gh version 2.83.0", message: null },
    { tool: "ssh", installed: true, ready: true, version: "OpenSSH_9.6p1", message: null },
  ],
  agents: [
    { adapter: "claude", installed: true, path: "/usr/local/bin/claude", message: null, capabilities: agentCapabilities },
    { adapter: "codex", installed: true, path: "/usr/local/bin/codex", message: null, capabilities: agentCapabilities },
  ],
};
/** What the server said about its runners; `undefined` while it has not answered yet. */
let health: RunnerHealth | undefined = ready;

const stoppedHerdr: HerdrHealth = {
  installed: true,
  running: false,
  version: "0.9.5",
  message: "The herdr server is not running; start herdr on the server for herdr workspaces.",
};
const missingHerdr: HerdrHealth = {
  installed: false,
  running: false,
  version: null,
  message: "herdr was not found on the server's PATH; install herdr and start it for herdr workspaces.",
};
/** Why listing the machines saved in herdr fails; `null` while it succeeds. */
let machinesError: Error | null = null;
vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  useWorkspaces: () => query(workspaces),
  useHerdrMachines: () =>
    machinesError === null ? query([]) : { data: undefined, isPending: false, isError: true, error: machinesError },
  useHomeDirectory: () => query(home),
  useDirectories: () => query({ path: "/home/me", directories: [] }),
  useRunnerHealth: () => (health === undefined ? { data: undefined, isPending: true, isError: false } : query(health)),
  useCreateWorkspace: () => mutation,
  useDeleteWorkspace: () => mutation,
}));

beforeEach(() => {
  workspaces = [];
  home = "/home/me";
  health = ready;
  machinesError = null;
  mutation.mutate.mockClear();
});

/** Renders the list and opens the new workspace dialog for this server. */
function openNewWorkspace() {
  render(<WorkspaceList selectedId={null} onSelect={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Add workspace on Local" }));
  return screen.getByRole("dialog", { name: "New workspace on Local" });
}

/** Renders the list with a workspace on the SSH machine devbox and opens the new workspace dialog for devbox. */
function openNewWorkspaceOnDevbox() {
  workspaces = [
    {
      id: 2,
      name: "site",
      location: { kind: "ssh", machine: "devbox", path: "/srv/site" },
      defaultBaseBranch: "main",
      agentMerge: "never",
      pathProblem: null,
      source: "github",
      completion: "pr_merge",
      runner: "herdr",
    },
  ];
  render(<WorkspaceList selectedId={null} onSelect={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Add workspace on devbox" }));
  return screen.getByRole("dialog", { name: "New workspace on devbox" });
}

const option = (dialog: HTMLElement, name: string) => within(dialog).getByRole("radio", { name });
const next = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
const back = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));

describe("Remote machines", () => {
  it("tells how to add a remote machine while there is none", () => {
    render(<WorkspaceList selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText(/To add a remote machine, run/)).toHaveTextContent("herdr machine add <host>");
  });

  it("drops the hint once a remote machine is listed", () => {
    openNewWorkspaceOnDevbox();
    expect(screen.queryByText(/To add a remote machine, run/)).not.toBeInTheDocument();
  });
});

describe("New workspace", () => {
  it("shows the options an earlier step rules out disabled with the reason, and they cannot be picked", () => {
    const dialog = openNewWorkspace();

    expect(option(dialog, "GitHub")).toBeChecked();
    const init = option(dialog, "New repository");
    expect(init).toBeDisabled();
    expect(init).toHaveAccessibleDescription(repositoryProblem("github", "init")!);
    fireEvent.click(init);
    expect(init).not.toBeChecked();
    expect(option(dialog, "Open existing")).toBeChecked();

    fireEvent.click(option(dialog, "Plain folder"));
    expect(within(dialog).queryByRole("radio", { name: "Open existing" })).not.toBeInTheDocument();
    next(dialog);
    for (const name of ["Local merge", "PR merge"]) {
      expect(option(dialog, name)).toBeDisabled();
      fireEvent.click(option(dialog, name));
      expect(option(dialog, name)).not.toBeChecked();
    }
    expect(option(dialog, "Local merge")).toHaveAccessibleDescription(completionProblem("none", "local_merge")!);
    expect(option(dialog, "PR merge")).toHaveAccessibleDescription(completionProblem("none", "pr_merge")!);
    expect(option(dialog, "Manual")).toBeChecked();

    next(dialog);
    const herdr = option(dialog, "herdr");
    expect(herdr).toBeDisabled();
    expect(herdr).toHaveAccessibleDescription(runnerProblem("none", "manual", "herdr")!);
    fireEvent.click(herdr);
    expect(herdr).not.toBeChecked();
    expect(option(dialog, "No runner")).toBeChecked();
  });

  it("links the runner step to the runner guide in this repository", () => {
    const dialog = openNewWorkspace();
    next(dialog);
    next(dialog);

    const guide = within(dialog).getByRole("link", { name: "Compare the runners" });
    const href = guide.getAttribute("href")!;
    const prefix = "https://github.com/dev-bokdong/toodo/blob/main/";
    expect(href.startsWith(prefix)).toBe(true);
    expect(Object.keys(import.meta.glob("/docs/*.md"))).toContain(`/${href.slice(prefix.length)}`);
  });

  it("resets a later pick that an earlier change rules out to its default", () => {
    const dialog = openNewWorkspace();
    fireEvent.click(option(dialog, "Local git"));
    fireEvent.click(option(dialog, "New repository"));
    next(dialog);
    expect(option(dialog, "Local merge")).toBeChecked();
    fireEvent.click(option(dialog, "Manual"));
    next(dialog);
    fireEvent.click(option(dialog, "No runner"));
    expect(option(dialog, "No runner")).toBeChecked();

    // Local merge rules out no runner.
    back(dialog);
    fireEvent.click(option(dialog, "Local merge"));
    next(dialog);
    expect(option(dialog, "herdr")).toBeChecked();
    expect(option(dialog, "No runner")).toHaveAccessibleDescription(runnerProblem("local_git", "local_merge", "none")!);

    // GitHub rules out a new repository and local merge.
    back(dialog);
    back(dialog);
    fireEvent.click(option(dialog, "GitHub"));
    expect(option(dialog, "Open existing")).toBeChecked();
    next(dialog);
    expect(option(dialog, "PR merge")).toBeChecked();
  });

  it("adds a plain folder with no repository, manual completion, and no runner", () => {
    const dialog = openNewWorkspace();
    fireEvent.click(option(dialog, "Plain folder"));
    next(dialog);
    next(dialog);
    next(dialog);

    expect(within(dialog).queryByLabelText("Base branch")).not.toBeInTheDocument();
    const add = within(dialog).getByRole("button", { name: "Add workspace" });
    expect(add).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Folder"), { target: { value: "/home/me/notes" } });
    expect(within(dialog).getByLabelText("Name")).toHaveValue("notes");
    fireEvent.click(add);

    expect(mutation.mutate).toHaveBeenCalledWith(
      {
        name: "notes",
        location: { kind: "local", path: "/home/me/notes" },
        repository: null,
        source: "none",
        completion: "manual",
        runner: "none",
        defaultBaseBranch: null,
      },
      expect.anything(),
    );
  });

  it("clones a GitHub repository with pull request completion and herdr by default", () => {
    const dialog = openNewWorkspace();
    fireEvent.click(option(dialog, "Clone URL"));
    next(dialog);
    expect(option(dialog, "PR merge")).toBeChecked();
    next(dialog);
    expect(option(dialog, "herdr")).toBeChecked();
    next(dialog);

    fireEvent.change(within(dialog).getByLabelText("Repository URL"), {
      target: { value: "git@github.com:o/site.git" },
    });
    expect(within(dialog).getByLabelText("Parent folder")).toHaveValue("/home/me");
    expect(within(dialog).getByLabelText("Name")).toHaveValue("site");
    fireEvent.click(within(dialog).getByRole("button", { name: "Clone workspace" }));

    expect(mutation.mutate).toHaveBeenCalledWith(
      {
        name: "site",
        location: { kind: "local", path: "/home/me/site" },
        repository: { kind: "clone", url: "git@github.com:o/site.git" },
        source: "github",
        completion: "pr_merge",
        runner: "herdr",
        defaultBaseBranch: null,
      },
      expect.anything(),
    );
  });

  it("closes on Escape and gives the focus back to the button that opened it", () => {
    const dialog = openNewWorkspace();
    expect(option(dialog, "GitHub")).toHaveFocus();

    fireEvent.keyDown(option(dialog, "GitHub"), { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add workspace on Local" })).toHaveFocus();
    expect(mutation.mutate).not.toHaveBeenCalled();
  });
});

describe("Runner plain", () => {
  it("is offered for a git source on this server and adds the workspace with it", () => {
    const dialog = openNewWorkspace();
    next(dialog);
    next(dialog);
    expect(option(dialog, runnerLabels.plain)).toBeEnabled();

    back(dialog);
    back(dialog);
    fireEvent.click(option(dialog, "Local git"));
    next(dialog);
    next(dialog);
    const plain = option(dialog, runnerLabels.plain);
    expect(plain).toBeEnabled();
    fireEvent.click(plain);
    expect(plain).toBeChecked();
    next(dialog);
    fireEvent.change(within(dialog).getByLabelText("Folder"), { target: { value: "/home/me/tools" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Open workspace" }));

    expect(mutation.mutate).toHaveBeenCalledWith(
      {
        name: "tools",
        location: { kind: "local", path: "/home/me/tools" },
        repository: { kind: "open" },
        source: "local_git",
        completion: "local_merge",
        runner: "plain",
        defaultBaseBranch: null,
      },
      expect.anything(),
    );
  });

  it("is ruled out for a plain folder, with the reason", () => {
    const dialog = openNewWorkspace();
    fireEvent.click(option(dialog, "Plain folder"));
    next(dialog);
    next(dialog);

    const plain = option(dialog, runnerLabels.plain);
    expect(plain).toBeDisabled();
    expect(plain).toHaveAccessibleDescription(runnerProblem("none", "manual", "plain")!);
    fireEvent.click(plain);
    expect(plain).not.toBeChecked();
  });

  it("is offered on an SSH machine and adds the workspace with it", () => {
    const dialog = openNewWorkspaceOnDevbox();
    fireEvent.click(option(dialog, "Local git"));
    next(dialog);
    next(dialog);
    const plain = option(dialog, runnerLabels.plain);
    expect(plain).toBeEnabled();
    fireEvent.click(plain);
    next(dialog);
    fireEvent.change(within(dialog).getByLabelText("Folder"), { target: { value: "/home/me/tools" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Open workspace" }));

    expect(mutation.mutate).toHaveBeenCalledWith(
      {
        name: "tools",
        location: { kind: "ssh", machine: "devbox", path: "/home/me/tools" },
        repository: { kind: "open" },
        source: "local_git",
        completion: "local_merge",
        runner: "plain",
        defaultBaseBranch: null,
      },
      expect.anything(),
    );
  });
});

describe("Runner tmux", () => {
  it("is offered on a POSIX SSH machine and adds the workspace with it", () => {
    const dialog = openNewWorkspaceOnDevbox();
    next(dialog);
    next(dialog);
    const tmux = option(dialog, runnerLabels.tmux);
    expect(tmux).toBeEnabled();
    fireEvent.click(tmux);
    expect(tmux).toBeChecked();
    next(dialog);
    fireEvent.change(within(dialog).getByLabelText("Folder"), { target: { value: "/home/me/site" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Open workspace" }));

    expect(mutation.mutate).toHaveBeenCalledWith(
      {
        name: "site",
        location: { kind: "ssh", machine: "devbox", path: "/home/me/site" },
        repository: { kind: "open" },
        source: "github",
        completion: "pr_merge",
        runner: "tmux",
        defaultBaseBranch: null,
      },
      expect.anything(),
    );
  });

  it("is ruled out on a Windows SSH machine with the reason, while plain and herdr are offered", () => {
    home = "C:\\Users\\me";
    const dialog = openNewWorkspaceOnDevbox();
    next(dialog);
    next(dialog);

    const tmux = option(dialog, runnerLabels.tmux);
    expect(tmux).toBeDisabled();
    expect(tmux).toHaveAccessibleDescription(runnerLocationProblem("tmux", { kind: "ssh", path: home })!);
    fireEvent.click(tmux);
    expect(tmux).not.toBeChecked();
    expect(option(dialog, runnerLabels.plain)).toBeEnabled();
    expect(option(dialog, runnerLabels.herdr)).toBeChecked();
  });
});

describe("Without herdr running on this server", () => {
  const devbox: Workspace = {
    id: 2,
    name: "site",
    location: { kind: "ssh", machine: "devbox", path: "/srv/site" },
    defaultBaseBranch: "main",
    agentMerge: "never",
    pathProblem: null,
    source: "github",
    completion: "pr_merge",
    runner: "herdr",
  };

  it("defaults a git source to runner plain and notes it on herdr, which can still be picked", () => {
    health = { ...ready, herdr: stoppedHerdr };
    const dialog = openNewWorkspace();
    next(dialog);
    next(dialog);

    expect(option(dialog, runnerLabels.plain)).toBeChecked();
    const herdr = option(dialog, "herdr");
    expect(herdr).toBeEnabled();
    expect(herdr).toHaveAccessibleDescription(
      /herdr is not running on this server; start it there before starting tasks, or choose Plain\.$/,
    );
    fireEvent.click(herdr);
    expect(herdr).toBeChecked();
    next(dialog);
    fireEvent.change(within(dialog).getByLabelText("Folder"), { target: { value: "/home/me/site" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Open workspace" }));

    expect(mutation.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ source: "github", completion: "pr_merge", runner: "herdr" }),
      expect.anything(),
    );
  });

  it("adds a workspace with runner plain by default while herdr is not installed, and a plain folder with none", () => {
    health = { ...ready, herdr: missingHerdr };
    const dialog = openNewWorkspace();
    fireEvent.click(option(dialog, "Plain folder"));
    next(dialog);
    next(dialog);
    expect(option(dialog, "No runner")).toBeChecked();

    back(dialog);
    back(dialog);
    fireEvent.click(option(dialog, "Local git"));
    next(dialog);
    next(dialog);
    expect(option(dialog, runnerLabels.plain)).toBeChecked();
    expect(option(dialog, "herdr")).toHaveAccessibleDescription(
      /herdr is not running on this server since it is not installed there; install and start herdr/,
    );
    next(dialog);
    fireEvent.change(within(dialog).getByLabelText("Folder"), { target: { value: "/home/me/tools" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Open workspace" }));

    expect(mutation.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ source: "local_git", completion: "local_merge", runner: "plain" }),
      expect.anything(),
    );
  });

  it("keeps herdr as the default while the server has not said whether herdr runs", () => {
    health = undefined;
    const dialog = openNewWorkspace();
    next(dialog);
    next(dialog);

    expect(option(dialog, "herdr")).toBeChecked();
    expect(option(dialog, "herdr")).not.toHaveAccessibleDescription(/not running/);
  });

  it("keeps herdr as the default on an SSH machine, whose herdr this server does not check, and offers plain there", () => {
    health = { ...ready, herdr: stoppedHerdr };
    workspaces = [devbox];
    render(<WorkspaceList selectedId={null} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add workspace on devbox" }));
    const dialog = screen.getByRole("dialog", { name: "New workspace on devbox" });
    next(dialog);
    next(dialog);

    expect(option(dialog, "herdr")).toBeChecked();
    expect(option(dialog, "herdr")).not.toHaveAccessibleDescription(/not running/);
    expect(option(dialog, runnerLabels.plain)).toBeEnabled();
  });
});

describe("Herdr machines that cannot be listed", () => {
  it("notes instead of alerting that there are no SSH machines while herdr is not installed", () => {
    health = { ...ready, herdr: missingHerdr };
    machinesError = new Error(
      "failed to run herdr (is it installed and on PATH?): No such file or directory (os error 2)",
    );
    render(<WorkspaceList selectedId={null} onSelect={() => {}} />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/Failed to list herdr machines/)).not.toBeInTheDocument();
    expect(screen.getByText(/^herdr is not installed on this server/)).toBeInTheDocument();
  });

  it("alerts while herdr is installed, or before the server has said whether it is", () => {
    machinesError = new Error("herdr machine list: connection refused");
    for (const answer of [{ ...ready, herdr: stoppedHerdr }, undefined]) {
      health = answer;
      const { unmount } = render(<WorkspaceList selectedId={null} onSelect={() => {}} />);

      expect(screen.getByRole("alert")).toHaveTextContent(
        "Failed to list herdr machines: herdr machine list: connection refused",
      );
      expect(screen.queryByText(/herdr is not installed on this server/)).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe("Workspace list", () => {
  it("shows the source, completion, and runner of each workspace", () => {
    workspaces = [
      {
        id: 1,
        name: "notes",
        location: { kind: "local", path: "/home/me/notes" },
        defaultBaseBranch: "",
        agentMerge: "never",
        pathProblem: null,
        source: "none",
        completion: "manual",
        runner: "none",
      },
    ];
    render(<WorkspaceList selectedId={null} onSelect={() => {}} />);

    expect(screen.getByRole("button", { name: /^notes/ })).toHaveTextContent(
      `${sourceLabels.none} \u00b7 ${completionLabels.manual} \u00b7 ${runnerLabels.none}`,
    );
  });
});
