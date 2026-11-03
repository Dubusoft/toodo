import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceList } from "@/components/workspace-list";
import type { Workspace } from "@/lib/bindings";
import {
  completionLabels,
  completionProblem,
  repositoryProblem,
  runnerLabels,
  runnerProblem,
  sourceLabels,
} from "@/lib/workspace-axes";

const mutation = { mutate: vi.fn(), isPending: false, isError: false };
const query = <T,>(data: T) => ({ data, isPending: false, isError: false });
let workspaces: Workspace[] = [];

vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  useWorkspaces: () => query(workspaces),
  useHerdrMachines: () => query([]),
  useHomeDirectory: () => query("/home/me"),
  useCreateWorkspace: () => mutation,
  useDeleteWorkspace: () => mutation,
}));

beforeEach(() => {
  workspaces = [];
  mutation.mutate.mockClear();
});

/** Renders the list and opens the new workspace dialog for this server. */
function openNewWorkspace() {
  render(<WorkspaceList selectedId={null} onSelect={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Add workspace on Local" }));
  return screen.getByRole("dialog", { name: "New workspace on Local" });
}

const option = (dialog: HTMLElement, name: string) => within(dialog).getByRole("radio", { name });
const next = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
const back = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));

describe("Add machine", () => {
  it("shows the command to run on the server and copies it instead of offering a form", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<WorkspaceList selectedId={null} onSelect={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Add machine" }));

    expect(screen.queryByRole("form", { name: "Add machine" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Add machine command")).toHaveTextContent("herdr machine add <host>");
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    expect(writeText).toHaveBeenCalledWith("herdr machine add <host>");
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
