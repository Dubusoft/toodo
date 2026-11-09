import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceGuidelines } from "@/components/workspace-guidelines";
import { commands, type Guideline, type GuidelineKind, type Workspace } from "@/lib/bindings";

vi.mock("@/lib/bindings", () => ({
  commands: {
    listGuidelines: vi.fn(),
    addGuideline: vi.fn(),
    updateGuideline: vi.fn(),
    deleteGuideline: vi.fn(),
  },
}));

const mocked = vi.mocked(commands);

const app: Workspace = {
  id: 1,
  name: "app",
  description: null,
  repository: null,
  archivedAt: null,
};

function ok<T>(data: T) {
  return { status: "ok" as const, data };
}

function guideline(id: number, kind: GuidelineKind, body: string): Guideline {
  return { id, workspaceId: app.id, kind, body, createdAt: 1700000000, updatedAt: 1700000000 };
}

/** Renders the guidelines of `app`, which the server lists as `entries`. */
function renderGuidelines(entries: Guideline[]) {
  mocked.listGuidelines.mockResolvedValue(ok(entries));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceGuidelines workspace={app} />
    </QueryClientProvider>,
  );
  return screen.getByRole("region", { name: "Guidelines" });
}

/** Unfolds the guidelines, which rest folded to their counts once loaded. */
async function unfold(section: HTMLElement) {
  const toggle = await within(section).findByRole("button", { name: /^Guidelines \d/ });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
}

// Markdown is lazy-loaded; transform it once here so no test pays for that within its timeout.
beforeAll(async () => {
  await import("@/components/markdown");
});

describe("WorkspaceGuidelines", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("lists rules before memory, each as Markdown", async () => {
    const section = renderGuidelines([
      guideline(3, "memory", "The CI only typechecks."),
      guideline(1, "rule", "Run `cargo fmt` before committing."),
      guideline(2, "rule", "Write everything in English."),
    ]);

    expect(await within(section).findByRole("button", { name: "Guidelines 2 rules, 1 memory" })).toBeInTheDocument();
    expect(within(section).queryByRole("listitem")).not.toBeInTheDocument();
    await unfold(section);

    expect(within(section).getAllByRole("list").map((list) => list.getAttribute("aria-label"))).toEqual([
      "Rules",
      "Memory",
    ]);
    const items = within(section).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual(["Rule 1", "Rule 2", "Memory 1"]);
    expect(await within(items[0]).findByText("cargo fmt")).toHaveProperty("tagName", "CODE");
    expect(items[1]).toHaveTextContent("Write everything in English.");
    expect(items[2]).toHaveTextContent("The CI only typechecks.");
    expect(mocked.listGuidelines).toHaveBeenCalledWith(1);
  });

  it("says what guidelines are for while there are none and adds one of the chosen kind", async () => {
    const added = guideline(4, "memory", "The staging server resets every night.");
    mocked.addGuideline.mockResolvedValue(ok(added));
    const section = renderGuidelines([]);

    expect(await within(section).findByText(/agents read them before working on a task/)).toBeInTheDocument();
    fireEvent.click(within(section).getByRole("button", { name: "Add guideline" }));
    const form = within(section).getByRole("form", { name: "Add guideline" });
    fireEvent.change(within(form).getByRole("combobox", { name: "Kind" }), { target: { value: "memory" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Guideline" }), {
      target: { value: "  The staging server resets every night.\n" },
    });
    mocked.listGuidelines.mockResolvedValue(ok([added]));
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(mocked.addGuideline).toHaveBeenCalledWith({
        workspaceId: 1,
        kind: "memory",
        body: "The staging server resets every night.",
      }),
    );
    expect(await within(section).findByRole("listitem", { name: "Memory 1" })).toHaveTextContent(
      "The staging server resets every night.",
    );
    expect(within(section).queryByRole("form", { name: "Add guideline" })).not.toBeInTheDocument();
  });

  it("shows why a guideline could not be added and keeps what was typed", async () => {
    mocked.addGuideline.mockResolvedValue({
      status: "error",
      error: { kind: "notFound", code: "workspaceNotFound", message: "workspace 1 does not exist" },
    });
    const section = renderGuidelines([]);

    fireEvent.click(await within(section).findByRole("button", { name: "Add guideline" }));
    const form = within(section).getByRole("form", { name: "Add guideline" });
    fireEvent.change(within(form).getByRole("textbox", { name: "Guideline" }), { target: { value: "Keep it short." } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    expect(await within(form).findByRole("alert")).toHaveTextContent("workspace 1 does not exist");
    expect(within(form).getByRole("textbox", { name: "Guideline" })).toHaveValue("Keep it short.");
  });

  it("edits a guideline in place and asks before discarding typed changes", async () => {
    const edited = guideline(1, "memory", "Run the full test suite before review.");
    mocked.updateGuideline.mockResolvedValue(ok(edited));
    const section = renderGuidelines([guideline(1, "rule", "Run the tests.")]);
    await unfold(section);

    fireEvent.click(within(section).getByRole("button", { name: "Edit rule 1" }));
    const form = within(section).getByRole("form", { name: "Edit rule 1" });
    const body = within(form).getByRole("textbox", { name: "Guideline" });
    expect(body).toHaveValue("Run the tests.");
    fireEvent.change(body, { target: { value: "Run the full test suite before review." } });
    fireEvent.click(within(form).getByRole("button", { name: "Discard" }));
    fireEvent.click(within(form).getByRole("button", { name: "Keep editing" }));
    expect(body).toHaveValue("Run the full test suite before review.");

    fireEvent.change(within(form).getByRole("combobox", { name: "Kind" }), { target: { value: "memory" } });
    mocked.listGuidelines.mockResolvedValue(ok([edited]));
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocked.updateGuideline).toHaveBeenCalledWith({
        id: 1,
        kind: "memory",
        body: "Run the full test suite before review.",
      }),
    );
    expect(await within(section).findByRole("listitem", { name: "Memory 1" })).toHaveTextContent(
      "Run the full test suite before review.",
    );
    expect(within(section).queryByRole("form")).not.toBeInTheDocument();
  });

  it("deletes a guideline only once the deletion is confirmed", async () => {
    const lesson = guideline(2, "memory", "The old API is gone.");
    mocked.deleteGuideline.mockResolvedValue(ok(lesson));
    const section = renderGuidelines([guideline(1, "rule", "Write English."), lesson]);
    await unfold(section);

    fireEvent.click(within(section).getByRole("button", { name: "Delete memory 1" }));
    const question = within(section).getByRole("group", { name: "Delete memory 1?" });
    fireEvent.click(within(question).getByRole("button", { name: "Back" }));
    expect(within(section).queryByRole("group", { name: "Delete memory 1?" })).not.toBeInTheDocument();
    expect(mocked.deleteGuideline).not.toHaveBeenCalled();

    fireEvent.click(within(section).getByRole("button", { name: "Delete memory 1" }));
    mocked.listGuidelines.mockResolvedValue(ok([guideline(1, "rule", "Write English.")]));
    fireEvent.click(within(section).getByRole("button", { name: "Confirm delete memory 1" }));

    await waitFor(() => expect(mocked.deleteGuideline).toHaveBeenCalledWith(2));
    await waitFor(() =>
      expect(within(section).queryByRole("listitem", { name: "Memory 1" })).not.toBeInTheDocument(),
    );
    expect(within(section).getByRole("listitem", { name: "Rule 1" })).toBeInTheDocument();
  });
});
