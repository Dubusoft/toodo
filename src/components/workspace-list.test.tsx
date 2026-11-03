import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceList } from "@/components/workspace-list";

const mutation = { mutate: vi.fn(), isPending: false, isError: false };
const query = <T,>(data: T) => ({ data, isPending: false, isError: false });

vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  useWorkspaces: () => query([]),
  useHerdrMachines: () => query([]),
  useCreateWorkspace: () => mutation,
  useDeleteWorkspace: () => mutation,
}));

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
