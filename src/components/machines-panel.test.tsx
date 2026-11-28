import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { MachinesPanel } from "@/components/machines-panel";
import type { MachineJob, MachineRequest, MachineRow } from "@/lib/machines";

const TOKEN_KEY = "toodo-server-token";

const host: MachineRow = {
  label: "local", state: "connected", version: "137aa4c", os: "linux", tools: { hc: "0.1.22", omo: null }, toolsError: null, config: true,
};
const mini: MachineRow = {
  label: "mac-mini", state: "connected", version: "1e37e35", os: "darwin", tools: null,
  toolsError: "the runner does not report tool versions yet; update it (dori update)", config: false,
};
const login: MachineJob = {
  id: "job-1", kind: "login", tool: "omo", machine: "local", state: "running", command: "omo login --no-browser", startedAt: 1, endedAt: null,
  log: "$ omo login --no-browser\nOpen https://signin.omo.dev/device?code=TWJM-QTWV\n", exitCode: null, version: null,
  device: { url: "https://signin.omo.dev/device?code=TWJM-QTWV", userCode: "TWJM-QTWV", matchingCode: "932 514" }, problem: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** The server: lists `machines` and `jobs`; a POST is recorded and answered with a started job. The job stream stays open and quiet. */
function serve(machines: readonly MachineRow[], jobs: readonly MachineJob[] = []) {
  localStorage.setItem(TOKEN_KEY, "secret");
  const posted: MachineRequest[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
    if (path === "/api/machines/jobs") return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
    expect(path).toBe("/api/machines");
    if (init?.method !== "POST") return Response.json({ ok: true, machines, jobs });
    posted.push(JSON.parse(String(init.body)) as MachineRequest);
    return Response.json({ ok: true, job: { ...login, id: "job-2", kind: "install", tool: "hc", command: "hc update", device: null } });
  }));
  return posted;
}

function renderPanel() {
  localStorage.setItem("toodo-locale", "en");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <MachinesPanel active />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("MachinesPanel", () => {
  it("lists the server host with its tools and each runner, and updates hc on the host only after the confirm step", async () => {
    const posted = serve([host, mini]);
    renderPanel();

    const server = await screen.findByRole("listitem", { name: "Machine This server" });
    expect(within(server).getByText("hc 0.1.22")).toBeInTheDocument();
    expect(within(server).getByText("omo not installed")).toBeInTheDocument();
    expect(within(server).getByText("linux · runner 137aa4c")).toBeInTheDocument();
    expect(within(server).queryByRole("button", { name: "Sign in to OmO" })).not.toBeInTheDocument();
    const runner = screen.getByRole("listitem", { name: "Machine mac-mini" });
    expect(within(runner).getByText(/the runner does not report tool versions yet/)).toBeInTheDocument();
    expect(within(runner).getByText("This runner's settings are changed on that machine, with dori runner setup.")).toBeInTheDocument();
    expect(within(runner).queryByRole("button", { name: "Update hc" })).not.toBeInTheDocument();

    fireEvent.click(within(server).getByRole("button", { name: "Update hc" }));
    expect(posted).toEqual([]);
    const confirm = within(server).getByRole("alertdialog", { name: "Update hc" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Run" }));
    await vi.waitFor(() => expect(posted).toEqual([{ op: "install", tool: "hc" }]));
  });

  it("shows a running sign-in's code, matching code and sign-in page, and its log", async () => {
    serve([{ ...host, tools: { hc: "0.1.22", omo: "5.1.84" } }], [login]);
    renderPanel();

    const job = await screen.findByRole("listitem", { name: "OmO sign-in" });
    expect(within(job).getByLabelText("Code")).toHaveTextContent("TWJM-QTWV");
    expect(within(job).getByLabelText("Matching code")).toHaveTextContent("932 514");
    expect(within(job).getByRole("link", { name: "Open the sign-in page" })).toHaveAttribute("href", "https://signin.omo.dev/device?code=TWJM-QTWV");
    expect(within(job).getByLabelText("Log of OmO sign-in")).toHaveTextContent("$ omo login --no-browser");
    expect(within(job).getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in to OmO" })).toHaveAttribute("aria-disabled", "true");
  });
});
