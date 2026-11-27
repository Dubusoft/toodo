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
    getBackupStatus: vi.fn(),
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

function pickFile(file: File) {
  const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementationOnce(function (this: HTMLInputElement) {
    fireEvent.change(this, { target: { files: [file] } });
  });
  try {
    fireEvent.click(screen.getByRole("button", { name: "Restore from file" }));
  } finally {
    click.mockRestore();
  }
}

describe("BackupPanel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocked.listBackups.mockResolvedValue({ status: "ok", data: [automatic] });
    mocked.getBackupSettings.mockResolvedValue({ enabled: true, intervalHours: 24, keep: 7, directory: null });
    mocked.getBackupStatus.mockResolvedValue({ lastFailure: null });
  });

  it("downloads a snapshot instead of asking for a path", async () => {
    vi.mocked(downloadExport).mockResolvedValue("toodo-backup-2026-10-14.sqlite3");
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Export..." }));

    // Astryx buttons and fields carry empty live regions of their own, so the notice is found by its text.
    expect(await screen.findByText("Downloaded toodo-backup-2026-10-14.sqlite3")).toHaveAttribute("role", "status");
  });

  it("does not expose the restore picker to a page-wide file input selector", () => {
    renderPanel();

    expect(screen.getByRole("region", { name: "Backups" }).querySelector('input[type="file"]')).toBeNull();
  });

  it("uploads a picked file only after confirmation and refetches everything", async () => {
    vi.mocked(uploadRestore).mockResolvedValue(safety);
    const { invalidate } = renderPanel();
    const file = new File(["SQLite format 3"], "laptop.sqlite3");

    pickFile(file);
    const dialog = await screen.findByRole("alertdialog", { name: "Confirm restore" });
    expect(dialog).toHaveTextContent("laptop.sqlite3");
    expect(uploadRestore).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace data" }));

    expect(
      await screen.findByText(
        "Restored laptop.sqlite3. The previous data was saved as toodo-pre-restore-20261014-100000.sqlite3.",
      ),
    ).toHaveAttribute("role", "status");
    expect(vi.mocked(uploadRestore).mock.calls[0][0]).toBe(file);
    expect(invalidate).toHaveBeenCalledWith();
  });

  it("shows why the server refused an upload", async () => {
    vi.mocked(uploadRestore).mockRejectedValue(new Error("invalid backup: not a Toodo database"));
    renderPanel();

    pickFile(new File(["x"], "notes.db"));
    fireEvent.click(await screen.findByRole("button", { name: "Replace data" }));

    expect(await screen.findByText(/not a Toodo database/)).toHaveAttribute("role", "alert");
  });

  it("downloads a listed backup by name", async () => {
    vi.mocked(downloadBackup).mockResolvedValue("toodo-auto-20261014-093005.sqlite3");
    renderPanel();

    const list = await screen.findByRole("list", { name: "Saved backups" });
    fireEvent.click(await within(list).findByRole("button", { name: /^Download backup from/ }));

    expect(await screen.findByText("Downloaded toodo-auto-20261014-093005.sqlite3")).toHaveAttribute("role", "status");
    expect(vi.mocked(downloadBackup).mock.calls[0][0]).toBe("toodo-auto-20261014-093005.sqlite3");
  });

  it("restores a listed backup by name and shows a rejected backup's error", async () => {
    mocked.restoreBackup.mockResolvedValue({
      status: "error",
      error: { kind: "invalidInput", code: "invalidInput", message: "invalid backup x: not a Toodo database" },
    });
    renderPanel();

    const list = await screen.findByRole("list", { name: "Saved backups" });
    fireEvent.click(await within(list).findByRole("button", { name: /^Restore this backup from/ }));
    fireEvent.click(screen.getByRole("button", { name: "Replace data" }));

    expect(await screen.findByText(/not a Toodo database/)).toHaveAttribute("role", "alert");
    expect(mocked.restoreBackup).toHaveBeenCalledWith("toodo-auto-20261014-093005.sqlite3");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("saves the automatic backup schedule and directory", async () => {
    mocked.saveBackupSettings.mockResolvedValue({
      status: "ok",
      data: { enabled: true, intervalHours: 6, keep: 3, directory: "/mnt/backup/toodo" },
    });
    renderPanel();

    // A number field commits what was typed when it loses the focus.
    const hours = await screen.findByLabelText("Hours between backups");
    fireEvent.change(hours, { target: { value: "6" } });
    fireEvent.blur(hours);
    const keep = screen.getByLabelText("Backups to keep");
    fireEvent.change(keep, { target: { value: "3" } });
    fireEvent.blur(keep);
    fireEvent.change(screen.getByLabelText("Backup directory"), { target: { value: " /mnt/backup/toodo " } });
    fireEvent.click(screen.getByRole("button", { name: "Save backup settings" }));

    await waitFor(() =>
      expect(mocked.saveBackupSettings).toHaveBeenCalledWith({
        enabled: true,
        intervalHours: 6,
        keep: 3,
        directory: "/mnt/backup/toodo",
      }),
    );
    await waitFor(() => expect(mocked.listBackups).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocked.getBackupStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Backup directory")).toHaveValue("/mnt/backup/toodo");
  });

  it("keeps backups in the data directory when the directory is left empty", async () => {
    mocked.getBackupSettings.mockResolvedValue({ enabled: true, intervalHours: 24, keep: 7, directory: "/mnt/old" });
    mocked.saveBackupSettings.mockResolvedValue({
      status: "ok",
      data: { enabled: true, intervalHours: 24, keep: 7, directory: null },
    });
    renderPanel();

    fireEvent.change(await screen.findByDisplayValue("/mnt/old"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save backup settings" }));

    await waitFor(() =>
      expect(mocked.saveBackupSettings).toHaveBeenCalledWith({ enabled: true, intervalHours: 24, keep: 7, directory: null }),
    );
  });

  it("shows a failed automatic backup with its reason", async () => {
    mocked.getBackupStatus.mockResolvedValue({
      lastFailure: { at: 1_791_970_205, message: "file error: Read-only file system (os error 30)" },
    });
    renderPanel();

    const alert = await screen.findByRole("alert", { name: "Automatic backup failed" });
    expect(alert).toHaveTextContent("Read-only file system");
  });

  it("labels backups taken before an update", async () => {
    mocked.listBackups.mockResolvedValue({
      status: "ok",
      data: [{ ...automatic, kind: "preMigration", path: "/data/backups/toodo-pre-migration-20261014-093005.sqlite3" }],
    });
    renderPanel();

    const list = await screen.findByRole("list", { name: "Saved backups" });
    expect(await within(list).findByText(/Before update/)).toBeInTheDocument();
  });
});
