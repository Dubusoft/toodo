import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceList } from "@/components/workspace-list";
import type { Workspace } from "@/lib/bindings";

const mutation = { mutate: vi.fn(), isPending: false, isError: false };
const query = <T,>(data: T) => ({ data, isPending: false, isError: false });
let workspaces: Workspace[] = [];

vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  useWorkspaces: () => query(workspaces),
  useCreateWorkspace: () => mutation,
  useDeleteWorkspace: () => mutation,
}));

beforeEach(() => {
  workspaces = [];
  mutation.mutate.mockClear();
});

/** Renders the list and opens the new workspace dialog. */
function openNewWorkspace() {
  render(<WorkspaceList selectedId={null} onSelect={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Add workspace" }));
  return screen.getByRole("dialog", { name: "New workspace" });
}

describe("New workspace", () => {
  it("adds a workspace with only a name", () => {
    const dialog = openNewWorkspace();
    const add = within(dialog).getByRole("button", { name: "Add workspace" });
    expect(add).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "notes" } });
    fireEvent.click(add);

    expect(mutation.mutate).toHaveBeenCalledWith(
      { name: "notes", description: null, repository: null },
      expect.anything(),
    );
  });

  it("adds a workspace with a description and a repository reference, trimmed", () => {
    const dialog = openNewWorkspace();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: " site " } });
    fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "The **website**\n" } });
    fireEvent.change(within(dialog).getByLabelText("Repository"), { target: { value: " o/site " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add workspace" }));

    expect(mutation.mutate).toHaveBeenCalledWith(
      { name: "site", description: "The **website**", repository: "o/site" },
      expect.anything(),
    );
  });

  it("closes on Escape and gives the focus back to the button that opened it", () => {
    const dialog = openNewWorkspace();
    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveFocus();

    fireEvent.keyDown(name, { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add workspace" })).toHaveFocus();
    expect(mutation.mutate).not.toHaveBeenCalled();
  });
});

describe("Workspace list", () => {
  it("shows each workspace with its repository reference", () => {
    workspaces = [
      { id: 1, name: "toodo", description: null, repository: "dev-bokdong/toodo", archivedAt: null },
      { id: 2, name: "ops", description: "Server chores", repository: null, archivedAt: null },
    ];
    render(<WorkspaceList selectedId={1} onSelect={() => {}} />);

    const toodo = screen.getByRole("button", { name: /^toodo/ });
    expect(toodo).toHaveAttribute("aria-current", "true");
    expect(toodo).toHaveTextContent("dev-bokdong/toodo");
    expect(screen.getByRole("button", { name: /^ops/ })).toHaveTextContent(/^ops$/);
  });
});
