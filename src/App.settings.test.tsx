import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, onTestFinished } from "vitest";
import { formatFull, formatWhen } from "@/lib/timeline";
import {
  findAlert,
  herdr,
  mocked,
  mockedEvents,
  openDetails,
  openSettings,
  renderApp,
  renderWorkspace,
  row,
  setUpApp,
  task,
  taskList,
  toodo,
} from "@/test/app";

describe("App: workspaces and settings", () => {
  setUpApp();

  it("shows the backend version once the app info command resolves", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [] });
    renderApp();

    expect(screen.getByRole("heading", { name: "Toodo" })).toBeInTheDocument();
    expect(await screen.findByText("v1.2.3")).toBeInTheDocument();
    expect(await screen.findByText("No workspaces yet.")).toBeInTheDocument();
  });

  it("lists workspaces and the tasks of the selected one", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage", {
          status: "done",
          milestones: { ...task(1, 1, "").milestones, plannedAt: 1760000000, completedAt: 1760500000 },
        }),
        task(2, 1, "Add UI", { status: "planned", dependsOn: [1] }),
        task(3, 2, "Fix ssh"),
      ],
    });
    await renderWorkspace();

    const tasks = await taskList();
    // Done tasks are folded away until asked for.
    expect(within(tasks).queryByText("Add storage")).not.toBeInTheDocument();
    fireEvent.click(within(tasks).getByRole("button", { name: "Done 1" }));
    expect(within(tasks).getByText("Add storage")).toBeInTheDocument();
    // Its only prerequisite is done, so #2 can be started now.
    expect(within(row("Add UI")).getByText("Ready")).toBeInTheDocument();
    expect(within(tasks).queryByText("Fix ssh")).not.toBeInTheDocument();
    let details = await openDetails("Add UI");
    const dependencies = within(details).getByRole("group", { name: "Dependencies of #2" });
    expect(within(dependencies).getByText("#1")).toBeInTheDocument();
    expect(within(details).queryByLabelText("Timeline of #2")).not.toBeInTheDocument();
    details = await openDetails("Add storage");
    const timeline = within(details).getByLabelText("Timeline of #1");
    expect(timeline).toHaveTextContent(`Planned${formatWhen(1760000000)}`);
    expect(timeline).toHaveTextContent(`Completed${formatWhen(1760500000)}`);
    expect(within(timeline).getByText(formatWhen(1760500000))).toHaveAttribute("title", formatFull(1760500000));
    expect(timeline).not.toHaveTextContent("Paused");

    fireEvent.click(screen.getByRole("button", { name: /^herdr/ }));
    expect(await screen.findByText("Fix ssh")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "herdr" })).toBeInTheDocument();
    expect(screen.queryByText("Add storage")).not.toBeInTheDocument();
  });

  it("removes a workspace from the list only after confirming", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [task(1, 1, "Add storage"), task(3, 2, "Fix ssh")],
    });
    mocked.deleteWorkspace
      .mockResolvedValueOnce({ status: "error", error: { kind: "internal", code: "internal", message: "database is locked" } })
      .mockResolvedValueOnce({ status: "ok", data: null });
    await renderWorkspace();

    expect(await screen.findByText("Add storage")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove toodo" }));
    expect(mocked.deleteWorkspace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("button", { name: "Confirm remove toodo" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove toodo" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove toodo" }));
    expect(await findAlert()).toHaveTextContent("database is locked");
    expect(screen.getByRole("region", { name: "Workspaces" })).toHaveTextContent("toodo");

    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [herdr] });
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove toodo" }));

    expect(await screen.findByText("Fix ssh")).toBeInTheDocument();
    expect(mocked.deleteWorkspace).toHaveBeenLastCalledWith(1);
    expect(within(screen.getByRole("region", { name: "Workspaces" })).queryByRole("button", { name: /^toodo/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "herdr" })).toBeInTheDocument();
  });

  it("shows a workspace an agent added once the app hears of it", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    renderApp();
    await screen.findByRole("button", { name: /^toodo/ });
    await waitFor(() => expect(mockedEvents.workspacesChanged.listen).toHaveBeenCalled());

    mocked.listWorkspaces.mockResolvedValue({
      status: "ok",
      data: [toodo, { ...toodo, id: 2, name: "site" }],
    });
    const [[onWorkspacesChanged]] = mockedEvents.workspacesChanged.listen.mock.calls;
    act(() => {
      onWorkspacesChanged({ event: "workspaces-changed", id: 3, payload: null });
    });

    expect(await screen.findByRole("button", { name: /^site/ })).toBeInTheDocument();
  });

  it("shows a guideline an agent added to the open workspace once the app hears of it", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    await renderWorkspace();
    const guidelines = await screen.findByRole("region", { name: "Guidelines" });
    expect(await within(guidelines).findByText(/agents read them/)).toBeInTheDocument();
    await waitFor(() => expect(mockedEvents.guidelinesChanged.listen).toHaveBeenCalled());

    mocked.listGuidelines.mockResolvedValue({
      status: "ok",
      data: [{ id: 1, workspaceId: 1, kind: "rule", body: "Write English.", createdAt: 1700000000, updatedAt: 1700000000 }],
    });
    const [[onGuidelinesChanged]] = mockedEvents.guidelinesChanged.listen.mock.calls;
    act(() => {
      onGuidelinesChanged({ event: "guidelines-changed", id: 4, payload: { workspaceId: 1 } });
    });

    expect(await within(guidelines).findByRole("button", { name: "Guidelines 1 rule" })).toBeInTheDocument();
    expect(mocked.listGuidelines).toHaveBeenLastCalledWith(1);
  });

  it("copies the MCP config for agents", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [] });
    renderApp();
    await openSettings("Agent access");

    const panel = await screen.findByRole("region", { name: "Agent access" });
    expect(await within(panel).findByLabelText("MCP server URL")).toHaveTextContent("http://127.0.0.1:47615/mcp");
    fireEvent.click(within(panel).getByRole("button", { name: "Copy MCP config" }));
    expect(await within(panel).findByText("Copied the MCP config.")).toBeInTheDocument();
    expect(JSON.parse(writeText.mock.calls[0][0] as string)).toEqual({
      mcpServers: {
        toodo: {
          type: "http",
          url: "http://127.0.0.1:47615/mcp",
          headers: { Authorization: "Bearer secret" },
        },
      },
    });
  });

  it("tests the MCP connection with the token shown and shows the last rejected agent request", async () => {
    mocked.mcpServerInfo.mockResolvedValue({
      url: "http://127.0.0.1:47615/mcp",
      token: "secret",
      error: null,
      instance: "0123456789ab",
      lastRejection: { reason: "wrong_token", at: Math.floor(Date.now() / 1000) - 120, count: 3 },
    });
    const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("Authorization");
      if (authorization !== "Bearer secret") return new Response("Toodo MCP: this server does not accept the token.", { status: 401 });
      const body = { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "toodo", title: "Toodo (server instance 0123456789ab)" } } };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    onTestFinished(() => void vi.unstubAllGlobals());
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [] });
    renderApp();
    await openSettings("Agent access");

    const panel = await screen.findByRole("region", { name: "Agent access" });
    expect(await within(panel).findByLabelText("Server instance")).toHaveTextContent("0123456789ab");
    expect(within(panel).getByLabelText("Last rejected agent request")).toHaveTextContent(
      "Last rejected agent request 2 min. ago: a token this server does not accept (old, mistyped, or another server's) (3 since the server started).",
    );
    expect(within(panel).getByRole("button", { name: "Copy MCP token for agents" })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Test connection" }));
    expect(await within(panel).findByRole("status", { name: "Connection test" })).toHaveTextContent(
      "Connected: instance 0123456789ab accepts this token.",
    );
    const [path, init] = fetch.mock.calls[0];
    expect(path).toBe("/mcp");
    expect(JSON.parse(init?.body as string)).toMatchObject({ method: "initialize" });
  });

  it("shows why the MCP server is not running", async () => {
    mocked.mcpServerInfo.mockResolvedValue({
      url: "http://127.0.0.1:47615/mcp",
      token: "secret",
      error: "could not listen on port 47615: address in use",
      instance: "0123456789ab",
      lastRejection: null,
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [] });
    renderApp();
    await openSettings("Agent access");

    const panel = await screen.findByRole("region", { name: "Agent access" });
    expect(await within(panel).findByRole("alert")).toHaveTextContent("address in use");
    expect(within(panel).queryByRole("button", { name: "Copy MCP config" })).not.toBeInTheDocument();
  });

  it("flags a failed automatic backup on the Settings button and the Backups tab", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [] });
    mocked.getBackupStatus.mockResolvedValue({ lastFailure: { at: 1_791_970_205, message: "file error: disk full" } });
    renderApp();

    const settings = await screen.findByRole("button", { name: /^Settings.*Backup failed$/ });
    fireEvent.click(settings);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByRole("tab", { name: /^Backups.*Backup failed/ })).toBeInTheDocument();
  });

  it("groups the settings in a dialog that Escape and a click beside it close", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [] });
    renderApp();
    const settings = await screen.findByRole("button", { name: /^Settings/ });
    expect(screen.queryByRole("region", { name: "Backups" })).not.toBeInTheDocument();

    fireEvent.click(settings);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(settings).toHaveAttribute("aria-expanded", "true");
    const general = within(dialog).getByRole("tab", { name: "General" });
    expect(general).toHaveAttribute("aria-selected", "true");
    expect(general).toHaveFocus();
    expect(within(dialog).getByRole("group", { name: "Theme" })).toBeInTheDocument();
    expect(within(dialog).getByRole("tab", { name: "Backups" })).toBeInTheDocument();

    fireEvent.keyDown(general, { key: "ArrowDown" });
    const agents = within(dialog).getByRole("tab", { name: "Agent access" });
    expect(agents).toHaveAttribute("aria-selected", "true");
    expect(agents).toHaveFocus();
    expect(within(dialog).getByRole("region", { name: "Agent access" })).toBeVisible();
    expect(within(dialog).queryByRole("region", { name: "General" })).not.toBeInTheDocument();

    fireEvent.keyDown(agents, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    expect(settings).toHaveFocus();

    fireEvent.click(settings);
    fireEvent.click(document.querySelector("[aria-hidden].bg-black\\/40")!);
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("shows a newer version of the server in the general settings", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [] });
    mocked.checkUpdate.mockResolvedValue({ current: "1.2.3", channel: "latest", latest: "1.3.0", newer: true, error: null });
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /^Settings/ }));
    const general = within(screen.getByRole("dialog", { name: "Settings" })).getByRole("region", { name: "General" });
    // Buttons carry live regions of their own, so the update notice is the status with text.
    await waitFor(() =>
      expect(within(general).getAllByRole("status").filter((status) => status.textContent !== "")).toEqual([
        expect.objectContaining({
          textContent: "v1.3.0 is available on the latest channel. Update the server with toodo update.",
        }),
      ]),
    );
  });
});
