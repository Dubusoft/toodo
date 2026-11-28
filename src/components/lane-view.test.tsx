import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoneLane, TaskLaneTabs } from "@/components/lane-view";
import type { TaskId } from "@/lib/bindings";
import type { SupervisorStatusSnapshot } from "@/lib/supervisor-status";

function streamOf(snapshot: SupervisorStatusSnapshot): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: status\ndata: ${JSON.stringify(snapshot)}\n\n`));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const snapshot = (): SupervisorStatusSnapshot => ({
  at: Date.now(),
  status: [],
  quota: null,
  lanes: [
    {
      key: "ap-7-1",
      status: "working",
      task: 7,
      machine: "mac-mini",
      model: "claude-opus",
      ageMin: 12,
      progress: "writing the view",
      threadUrl: "https://discord.com/channels/1/2",
      prUrl: "https://github.com/o/r/pull/9",
      screen: { text: "$ npm test" },
    },
    { key: "solo", status: "paused", task: null, machine: "local", model: null, ageMin: 3, progress: null, screen: null },
  ],
  machines: [{ label: "mac-mini", state: "connected", version: null, sample: null }],
});

function followStatusRecordingPaths(): string[] {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      paths.push(path);
      return streamOf(snapshot());
    }),
  );
  return paths;
}

function Details({ task }: { task: number }) {
  const [lane, setLane] = useState<string | null>(null);
  return (
    <ul>
      <TaskLaneTabs task={task as TaskId} lane={lane} onLaneChange={setLane}>
        <li>task details</li>
      </TaskLaneTabs>
    </ul>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("TaskLaneTabs", () => {
  it("shows a task no lane works on as it is, following the status without watching", async () => {
    localStorage.setItem("toodo-server-token", "secret");
    const paths = followStatusRecordingPaths();
    render(<Details task={8} />);
    expect(screen.getByText("task details")).toBeInTheDocument();
    await vi.waitFor(() => expect(paths).toEqual(["/api/supervisor/status?watch=0"]));
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("switches between the task and its lane, and watches the status only while the lane is shown", async () => {
    localStorage.setItem("toodo-server-token", "secret");
    const paths = followStatusRecordingPaths();
    render(<Details task={7} />);
    const laneTab = await screen.findByRole("tab", { name: "Lane" });
    expect(screen.getByRole("tab", { name: "Task" })).toHaveAttribute("aria-selected", "true");
    expect(paths).toEqual(["/api/supervisor/status?watch=0"]);

    fireEvent.click(laneTab);
    await screen.findByLabelText("Recent screen of ap-7-1");
    const lane = screen.getByRole("region", { name: "Lane ap-7-1" });
    await vi.waitFor(() => expect(paths.at(-1)).toBe("/api/supervisor/status"));
    expect(screen.getByText("task details")).not.toBeVisible();
    expect(within(lane).getByText("Working")).toBeInTheDocument();
    expect(within(lane).getByText("mac-mini")).toBeInTheDocument();
    expect(within(lane).getByText("writing the view")).toBeInTheDocument();
    expect(within(lane).getByRole("link", { name: "Thread" })).toHaveAttribute("href", "https://discord.com/channels/1/2");
    expect(within(lane).getByRole("link", { name: "Pull request" })).toHaveAttribute("href", "https://github.com/o/r/pull/9");
    expect(within(lane).getByLabelText("Recent screen of ap-7-1")).toHaveTextContent("$ npm test");

    fireEvent.click(screen.getByRole("tab", { name: "Task" }));
    expect(screen.getByText("task details")).toBeVisible();
    await vi.waitFor(() => expect(paths.at(-1)).toBe("/api/supervisor/status?watch=0"));
  });
});

describe("LoneLane", () => {
  it("watches the status and says a lane that is not working has no screen read", async () => {
    localStorage.setItem("toodo-server-token", "secret");
    const paths = followStatusRecordingPaths();
    render(
      <ul>
        <LoneLane laneKey="solo" />
      </ul>,
    );
    // The region shows while the first snapshot is awaited, so wait for what only the snapshot brings.
    expect(await screen.findByText("Paused")).toBeInTheDocument();
    const lane = screen.getByRole("region", { name: "Lane solo" });
    expect(paths).toEqual(["/api/supervisor/status"]);
    expect(within(lane).getByText("Dori reads the screens of working lanes only.")).toBeInTheDocument();
  });
});
