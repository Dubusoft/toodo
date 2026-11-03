import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackupPanel } from "@/components/backup-panel";
import { commands, type BackupEntry } from "@/lib/bindings";
import { downloadBackup, downloadExport, uploadRestore } from "@/web/files";

vi.mock("@/web/files", () => ({ downloadBackup: vi.fn(), downloadExport: vi.fn(), uploadRestore: vi.fn() }));
vi.mock("@/lib/bindings", () => ({
  commands: {
    listBackups: vi.fn(),
    getBackupSettings: vi.fn(),
    saveBackupSettings: vi.fn(),
    restoreBackup: vi.fn(),
  },
}));

const mocked = vi.mocked(commands);

const automatic: BackupEntry = {
  path: "/home/me/.local/share/toodo-server/backups/toodo-auto-20261014-093005.sqlite3",
  kind: "automatic",
  createdAt: 1_791_970_205,
  sizeBytes: 40_960,
};

const safety: BackupEntry = {
  path: "/home/me/.local/share/toodo-server/backups/toodo-pre-restore-20261014-100000.sqlite3",
  kind: "preRestore",
  createdAt: 1_791_972_000,
  sizeBytes: 40_960,
};

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <BackupPanel />
    </QueryClientProvider>,
  );
  return { invalidate };
}

describe("BackupPanel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocked.listBackups.mockResolvedValue({ status: "ok", data: [automatic] });
    mocked.getBackupSettings.mockResolvedValue({ enabled: true, intervalHours: 24, keep: 7 });
  });

  it("downloads a snapshot instead of asking for a path", async () => {
    vi.mocked(downloadExport).mockResolvedValue("toodo-backup-2026-10-14.sqlite3");
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Export..." }));

    expect(await screen.findByRole("status")).toHaveTextContent("Downloaded toodo-backup-2026-10-14.sqlite3");
  });

  it("uploads a picked file only after confirmation and refetches everything", async () => {
    vi.mocked(uploadRestore).mockResolvedValue(safety);
    const { invalidate } = renderPanel();
    const file = new File(["SQLite format 3"], "laptop.sqlite3");

    fireEvent.click(screen.getByRole("button", { name: "Restore..." }));
    fireEvent.change(screen.getByLabelText("Database file to restore"), { target: { files: [file] } });
    const dialog = await screen.findByRole("alertdialog", { name: "Confirm restore" });
    expect(dialog).toHaveTextContent("laptop.sqlite3");
    expect(uploadRestore).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace data" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Restored laptop.sqlite3. The previous data was saved as toodo-pre-restore-20261014-100000.sqlite3.",
    );
    expect(vi.mocked(uploadRestore).mock.calls[0][0]).toBe(file);
    expect(invalidate).toHaveBeenCalledWith();
  });

  it("shows why the server refused an upload", async () => {
    vi.mocked(uploadRestore).mockRejectedValue(new Error("invalid backup: not a Toodo database"));
    renderPanel();

    fireEvent.change(screen.getByLabelText("Database file to restore"), {
      target: { files: [new File(["x"], "notes.db")] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Replace data" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("not a Toodo database");
  });

  it("downloads a listed backup by name", async () => {
    vi.mocked(downloadBackup).mockResolvedValue("toodo-auto-20261014-093005.sqlite3");
    renderPanel();

    const list = await screen.findByRole("list", { name: "Saved backups" });
    fireEvent.click(await within(list).findByRole("button", { name: /^Download backup from/ }));

    expect(await screen.findByRole("status")).toHaveTextContent("Downloaded toodo-auto-20261014-093005.sqlite3");
    expect(vi.mocked(downloadBackup).mock.calls[0][0]).toBe("toodo-auto-20261014-093005.sqlite3");
  });

  it("restores a listed backup by name and shows a rejected backup's error", async () => {
    mocked.restoreBackup.mockResolvedValue({
      status: "error",
      error: { kind: "invalidInput", message: "invalid backup x: not a Toodo database" },
    });
    renderPanel();

    const list = await screen.findByRole("list", { name: "Saved backups" });
    fireEvent.click(await within(list).findByRole("button", { name: /^Restore this backup from/ }));
    fireEvent.click(screen.getByRole("button", { name: "Replace data" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("not a Toodo database");
    expect(mocked.restoreBackup).toHaveBeenCalledWith("toodo-auto-20261014-093005.sqlite3");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("saves the automatic backup schedule", async () => {
    mocked.saveBackupSettings.mockResolvedValue({
      status: "ok",
      data: { enabled: true, intervalHours: 6, keep: 3 },
    });
    renderPanel();

    fireEvent.change(await screen.findByLabelText("Hours between backups"), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText("Backups to keep"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));

    await waitFor(() =>
      expect(mocked.saveBackupSettings).toHaveBeenCalledWith({ enabled: true, intervalHours: 6, keep: 3 }),
    );
    await waitFor(() => expect(mocked.listBackups).toHaveBeenCalledTimes(2));
  });
});
