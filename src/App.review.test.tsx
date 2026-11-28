import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@/lib/bindings";
import { formatWhen } from "@/lib/timeline";
import {
  chooseOption,
  commit,
  herdr,
  localMidnight,
  mocked,
  renderApp,
  reviewOf,
  setUpApp,
  task,
  toodo,
} from "@/test/app";

describe("App: review", () => {
  setUpApp();

  it("names reviewed tasks without a plan and adds an estimate from the review", async () => {
    const at = Date.now() / 1000 - 60;
    const unplanned = task(1, 1, "Add storage", { status: "done" });
    const estimated = { ...unplanned, estimate: { unit: "hours" as const, amount: 2 } };
    let reviewed = unplanned;
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    mocked.reviewPeriod.mockImplementation(async (from, to) =>
      reviewOf(from, to, [{ task: reviewed, outcome: "completed", at, commits: [], archived: false, pullRequest: null }]),
    );
    mocked.updateTask.mockImplementation(async () => {
      reviewed = estimated;
      return { status: "ok", data: estimated };
    });
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    const plan = await screen.findByRole("region", { name: "Plan vs actual" });
    expect(plan).toHaveTextContent("No reviewed task has an estimate or a due date");
    expect(within(plan).getByText("Missing plan").nextSibling).toHaveTextContent(
      "1 task without an estimate, 1 task without a due date; add them from the marks on the tasks below",
    );
    const completed = screen.getByRole("region", { name: "Completed" });
    fireEvent.click(within(completed).getByRole("button", { name: "Edit plan of #1: no estimate or due date" }));
    const form = within(completed).getByRole("form", { name: "Edit task #1" });
    expect(within(form).getByLabelText("Estimate of #1")).toHaveFocus();
    fireEvent.change(within(form).getByLabelText("Estimate of #1"), { target: { value: "2" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    expect(await within(completed).findByRole("button", { name: "Edit plan of #1: no due date" })).toBeInTheDocument();
    expect(within(completed).queryByRole("form", { name: "Edit task #1" })).not.toBeInTheDocument();
    expect(mocked.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, estimate: { unit: "hours", amount: 2 }, dueDate: null, criteria: null }),
    );
  });

  it("saves the review as a snapshot and reopens it as it was saved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 14, 10));
    const at = new Date(2026, 9, 13, 15).getTime() / 1000;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    // Since the review was saved, its completed task was reopened.
    mocked.reviewPeriod.mockImplementation(async (from, to) =>
      reviewOf(from, to, [{ task: task(1, 1, "Add storage"), outcome: "started", at, commits: [], archived: false, pullRequest: null }]),
    );
    const summary = {
      id: 7,
      title: "Week review 2026-10-12 to 2026-10-18",
      period: "week" as const,
      from: "2026-10-12",
      to: "2026-10-18",
      timeZone: "Asia/Seoul",
      workspaceId: null,
      label: null,
      start: localMidnight("2026-10-12"),
      end: localMidnight("2026-10-19"),
      savedAt: at + 3600,
      entryCount: 1,
    };
    mocked.saveReviewSnapshot.mockImplementation(async () => {
      mocked.listReviewSnapshots.mockResolvedValue({ status: "ok", data: [summary] });
      return { status: "ok", data: summary };
    });
    const report = (fileName: string, contents: string) => ({
      fileName,
      mediaType: "text/markdown",
      from: "2026-10-12",
      to: "2026-10-18",
      contents,
    });
    mocked.getReviewSnapshot.mockResolvedValue({
      status: "ok",
      data: {
        summary,
        entries: [{ task: task(1, 1, "Add storage", { status: "done" }), outcome: "completed", at, commits: [], archived: false, pullRequest: null }],
        workspaces: [{ id: 1, name: "toodo before renaming" }],
        markdown: report("toodo-review-2026-10-12-to-2026-10-18.md", "# Saved week\n"),
        csv: report("toodo-review-2026-10-12-to-2026-10-18.csv", "Task\r\n"),
      },
    });
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    expect(await screen.findByRole("region", { name: "Started" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change time zone" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Save as snapshot" }));
    expect(
      await screen.findByText('Saved "Week review 2026-10-12 to 2026-10-18" with 1 task; reopen it from Saved reviews.'),
    ).toBeInTheDocument();
    expect(mocked.saveReviewSnapshot).toHaveBeenCalledWith({
      period: "week",
      from: "2026-10-12",
      to: null,
      workspaceId: null,
      label: null,
      title: null,
    });

    chooseOption(await screen.findByRole("combobox", { name: "Saved reviews" }), /^Week review 2026-10-12 to 2026-10-18 \(saved/);
    expect(await screen.findByRole("heading", { name: "Week review 2026-10-12 to 2026-10-18" })).toBeInTheDocument();
    expect(mocked.getReviewSnapshot).toHaveBeenCalledWith(7);
    expect(screen.getByText(/with days in Asia\/Seoul; it stays as it was when saved/)).toBeInTheDocument();
    const completed = await screen.findByRole("region", { name: "Completed" });
    expect(within(completed).getByText("toodo before renaming ·")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Started" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Week starting")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(screen.queryByRole("menuitem", { name: "Save as snapshot" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy as Markdown" }));
    expect(await screen.findByText("Copied as Markdown.")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith("# Saved week\n");
    expect(mocked.reviewReport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back to the live review" }));
    expect(await screen.findByRole("region", { name: "Started" })).toBeInTheDocument();
  });

  it("reviews the chosen period across workspaces, copies it as Markdown, and downloads it as CSV", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 14, 10));
    const at = new Date(2026, 9, 13, 15).getTime() / 1000;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    const createObjectURL = vi.fn((_blob: Blob) => "blob:review");
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    const downloads: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    mocked.reviewPeriod.mockImplementation(async (from, to) =>
      reviewOf(
        from,
        to,
        from === "2026-10-12" || from === "2026-01-01"
          ? [
              {
                task: task(1, 1, "Add storage", {
                  status: "done",
                  refs: ["pr:https://github.com/acme/toodo/pull/7"],
                }),
                outcome: "completed",
                at,
                commits: [{ ...commit(1, "0123456789", "Add the storage schema\n\nBody"), committedAt: at }],
                archived: false,
                pullRequest: null,
              },
              { task: task(3, 2, "Fix ssh", { labels: ["infra"] }), outcome: "worked_on", at, commits: [], archived: false, pullRequest: null },
            ]
          : [],
      ),
    );
    mocked.reviewReport.mockImplementation(async ({ format }) => ({
      status: "ok",
      data:
        format === "csv"
          ? { fileName: "toodo-review-2026.csv", mediaType: "text/csv", from: "2026-01-01", to: "2026-12-31", contents: "\uFEFFTask\r\n1,toodo\r\n" }
          : {
              fileName: "toodo-review-2026-10-12-to-2026-10-18.md",
              mediaType: "text/markdown",
              from: "2026-10-12",
              to: "2026-10-18",
              contents: "# Week review: 2026-10-12 to 2026-10-18\n",
            },
    }));
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));

    expect(await screen.findByRole("heading", { name: "Week review" })).toBeInTheDocument();
    expect(screen.getByLabelText("Week starting")).toHaveValue("2026-10-12");
    const completed = await screen.findByRole("region", { name: "Completed" });
    expect(within(completed).getByText("Add storage")).toBeInTheDocument();
    expect(within(completed).getByText("toodo ·")).toHaveTextContent(`toodo · ${formatWhen(at)}`);
    const pullRequest = within(completed).getByRole("link", { name: "Pull request #7" });
    expect(pullRequest).toHaveTextContent("#7");
    expect(pullRequest).toHaveAttribute("href", "https://github.com/acme/toodo/pull/7");
    expect(within(completed).getByRole("button", { name: "Open #1 Add storage" })).toBeInTheDocument();
    expect(within(completed).getByRole("list", { name: "Commits of #1 this week" })).toHaveTextContent(
      "0123456Add the storage schema",
    );
    const workedOn = screen.getByRole("region", { name: "Worked on" });
    expect(within(workedOn).getByText("herdr ·")).toHaveTextContent(`herdr · ${formatWhen(at)}`);
    expect(mocked.reviewPeriod).toHaveBeenCalledWith("2026-10-12", "2026-10-18");
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(within(summary).getByText("Completed by type").nextSibling).toHaveTextContent("Feature 1");
    expect(within(summary).queryByRole("list", { name: "Completed per month" })).not.toBeInTheDocument();
    expect(within(workedOn).getByRole("list", { name: "Labels of #3" })).toHaveTextContent("infra");

    chooseOption(screen.getByRole("combobox", { name: "Workspace" }), "herdr");
    expect(screen.queryByRole("region", { name: "Completed" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Worked on" })).toBeInTheDocument();
    expect(screen.getByText(/to 2026-10-18 in herdr\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    chooseOption(screen.getByRole("combobox", { name: "Label" }), "infra");
    expect(screen.queryByRole("region", { name: "Completed" })).not.toBeInTheDocument();
    expect(screen.getByText(/across all workspaces, labelled infra\./)).toBeInTheDocument();
    chooseOption(screen.getByRole("combobox", { name: "Workspace" }), "toodo");
    expect(screen.getByText("No recorded activity in this week matches the filters.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("region", { name: "Completed" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy as Markdown" }));
    expect(await screen.findByText("Copied as Markdown.")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith("# Week review: 2026-10-12 to 2026-10-18\n");
    expect(mocked.reviewReport).toHaveBeenLastCalledWith({
      period: "week",
      date: null,
      from: "2026-10-12",
      to: null,
      format: "markdown",
      timeZone: null,
      workspaceId: null,
      label: null,
    });

    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    expect(await screen.findByText("No recorded activity in this week.")).toBeInTheDocument();
    expect(screen.getByLabelText("Week starting")).toHaveValue("2026-10-05");
    expect(mocked.reviewPeriod).toHaveBeenLastCalledWith("2026-10-05", "2026-10-11");

    fireEvent.click(within(screen.getByRole("group", { name: "Review period" })).getByRole("button", { name: "Year" }));
    expect(screen.getByRole("heading", { name: "Year review" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Completed" })).toBeInTheDocument();
    expect(mocked.reviewPeriod).toHaveBeenLastCalledWith("2026-01-01", "2026-12-31");
    const months = within(screen.getByRole("region", { name: "Summary" })).getByRole("list", {
      name: "Completed per month",
    });
    expect(within(months).getAllByRole("listitem")).toHaveLength(12);
    expect(within(months).getAllByRole("listitem")[9]).toHaveTextContent("2026-101");

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Save as CSV" }));
    expect(await screen.findByText("Downloaded toodo-review-2026.csv")).toBeInTheDocument();
    expect(downloads).toEqual(["toodo-review-2026.csv"]);
    const saved = [...new Uint8Array(await createObjectURL.mock.calls[0][0].arrayBuffer())];
    expect(saved).toEqual([...new TextEncoder().encode("\uFEFFTask\r\n1,toodo\r\n")]);
    expect(mocked.reviewReport).toHaveBeenLastCalledWith(
      expect.objectContaining({ period: "year", from: "2026-01-01", to: null, format: "csv" }),
    );
    click.mockRestore();

    fireEvent.click(screen.getByRole("button", { name: /^toodo/ }));
    expect(await screen.findByRole("heading", { name: "toodo" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Year review" })).not.toBeInTheDocument();
  });

  it("tells why the review could not be copied or exported in the server's words", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn() }, configurable: true });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    mocked.reviewPeriod.mockImplementation(async (from, to) => reviewOf(from, to, []));
    mocked.reviewReport.mockResolvedValue({
      status: "error",
      error: { kind: "internal", code: "internal", message: "database is locked" },
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    expect(await screen.findByText("No recorded activity in this week.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Save as CSV" }));
    expect(await screen.findByText("Could not export: database is locked")).toBeInTheDocument();
    expect(click).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy as Markdown" }));
    expect(await screen.findByText("Could not copy: database is locked")).toBeInTheDocument();
    click.mockRestore();
  });

  it("shows pull request snapshots and research conclusions in the year in review", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 14, 10));
    const at = new Date(2026, 5, 1, 15).getTime() / 1000;
    const pullRequest = (number: number, additions: number, reviewCount: number) => ({
      number,
      title: `Pull request ${number}`,
      additions,
      deletions: 10,
      changedFiles: 3,
      mergeCommitSha: null,
      reviewCount,
      reviewerCount: reviewCount,
      firstReviewedAt: null,
    });
    const done = (id: number, title: string, overrides: Partial<Task>) =>
      task(id, 1, title, { status: "done", resolution: "merged", ...overrides });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    mocked.reviewPeriod.mockImplementation(async (from, to) =>
      reviewOf(from, to, [
        { task: done(1, "Add login", {}), pullRequest: pullRequest(11, 40, 2) },
        { task: done(2, "Rewrite storage", {}), pullRequest: pullRequest(12, 400, 0) },
        { task: done(3, "Try a cache", { taskType: "rnd", resolution: "not_adopted", completionNote: "Twice as slow" }), pullRequest: null },
      ].map(({ task, pullRequest }) => ({ task, pullRequest, outcome: "completed" as const, at, commits: [], archived: false }))),
    );
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    await screen.findByRole("region", { name: "Summary" });
    expect(screen.queryByText("Year in review")).not.toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("group", { name: "Review period" })).getByRole("button", { name: "Year" }));

    const year = (await screen.findByText("Year in review")).closest("section")!;
    expect(year).toHaveAccessibleName("Year in review");
    expect(within(year).getByText("Merged pull requests").nextSibling).toHaveTextContent("2");
    expect(within(year).getByText("Lines changed").nextSibling).toHaveTextContent("+440 / -20");
    expect(within(year).getByText("Reviews").nextSibling).toHaveTextContent("2on 1 of 2");
    const largest = within(within(year).getByRole("list", { name: "Largest pull requests" })).getAllByRole("listitem");
    expect(largest.map((item) => item.textContent)).toEqual([
      "FeatureRewrite storage#12, +400/-10 in 3 files, 0 reviews",
      "FeatureAdd login#11, +40/-10 in 3 files, 2 reviews",
    ]);
    const research = within(year).getByRole("list", { name: "Research conclusions" });
    expect(within(research).getByText("Not adopted")).toBeInTheDocument();
    expect(within(research).getByLabelText("Research conclusion of #3")).toHaveTextContent("Twice as slow");
  });
});
