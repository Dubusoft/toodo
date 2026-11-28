import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { MachinesPanel } from "@/components/machines-panel";
import type { Enrollment, MachineJob, MachineRequest, MachineRow, RunnerPrecheck } from "@/lib/machines";

const TOKEN_KEY = "toodo-server-token";

const host: MachineRow = {
  label: "local", state: "connected", version: "137aa4c", os: "linux", tools: { hc: "0.1.22", omo: null }, toolsError: null, jobsUnavailable: null,
  config: true,
};
const mini: MachineRow = {
  label: "mac-mini", state: "connected", version: "1e37e35", os: "darwin", tools: null,
  toolsError: "the runner does not report tool versions yet; update it (dori update)", jobsUnavailable: null, config: false,
};
const login: MachineJob = {
  id: "job-1", kind: "login", tool: "omo", machine: "local", state: "running", command: "omo login --no-browser", startedAt: 1, endedAt: null,
  log: "$ omo login --no-browser\nOpen https://signin.omo.dev/device?code=TWJM-QTWV\n", exitCode: null, version: null,
  device: { url: "https://signin.omo.dev/device?code=TWJM-QTWV", userCode: "TWJM-QTWV", matchingCode: "932 514" }, problem: null,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

/**
 * The server: lists `machines` and `jobs`; a POST is recorded and answered with a started job, or with `answers` for a
 * pre-check or an enrollment code. The job stream stays open and quiet.
 */
function serve(
  machines: readonly MachineRow[],
  jobs: readonly MachineJob[] = [],
  answers: { precheck?: RunnerPrecheck; enrollment?: Enrollment } = {},
) {
  localStorage.setItem(TOKEN_KEY, "secret");
  const posted: MachineRequest[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
    if (path === "/api/machines/jobs") return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
    expect(path).toBe("/api/machines");
    if (init?.method !== "POST") return Response.json({ ok: true, machines, jobs });
    const request = JSON.parse(String(init.body)) as MachineRequest;
    posted.push(request);
    if (request.op === "precheck") return Response.json({ ok: true, precheck: answers.precheck });
    if (request.op === "enroll-code") return Response.json({ ok: true, enrollment: answers.enrollment });
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
    await vi.waitFor(() => expect(posted).toEqual([{ op: "install", machine: "local", tool: "hc" }]));
  });

  it("updates hc on a runner that runs tool jobs, and says why an outdated runner cannot", async () => {
    const studio: MachineRow = { ...mini, label: "studio", tools: { hc: "0.1.20", omo: "5.1.80" }, toolsError: null, jobsUnavailable: "runner-outdated" };
    const posted = serve([host, { ...mini, tools: { hc: "0.1.22", omo: "5.1.84" }, toolsError: null }, studio]);
    renderPanel();

    const outdated = await screen.findByRole("listitem", { name: "Machine studio" });
    expect(within(outdated).getByText(/needs a newer runner/)).toBeInTheDocument();
    expect(within(outdated).queryByRole("button", { name: "Update hc" })).not.toBeInTheDocument();
    const runner = screen.getByRole("listitem", { name: "Machine mac-mini" });
    expect(within(runner).getByRole("checkbox", { name: "Replace mac-mini's earlier OmO device" })).toBeInTheDocument();
    fireEvent.click(within(runner).getByRole("button", { name: "Update hc" }));
    const confirm = within(runner).getByRole("alertdialog", { name: "Update hc" });
    expect(within(confirm).getByText(/Update hc on mac-mini to its newest release/)).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "Run" }));
    await vi.waitFor(() => expect(posted).toEqual([{ op: "install", machine: "mac-mini", tool: "hc" }]));
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

  it("explains each failed pre-check of an ssh target, and installs only once the checks pass", async () => {
    const failed: RunnerPrecheck = {
      target: "me@studio", label: "studio", os: "linux", listen: "192.168.1.20:7411",
      problems: [{ code: "no-hc", detail: "hc is not on the login PATH there" }, { code: "no-bun", detail: "bun is not on the PATH there" }],
    };
    const posted = serve([host], [], { precheck: failed });
    renderPanel();

    fireEvent.click(await screen.findByText("Add a computer"));
    const form = screen.getByRole("form", { name: "Over ssh from this server" });
    fireEvent.change(within(form).getByLabelText("ssh target"), { target: { value: "me@studio" } });
    fireEvent.click(within(form).getByRole("button", { name: "Check" }));
    const problems = await screen.findByRole("alert");
    expect(within(problems).getByText(/hc is missing there/)).toBeInTheDocument();
    expect(within(problems).getByText("curl -fsSL https://releases.herdr.dev/core/install.sh | sh")).toBeInTheDocument();
    expect(within(problems).getByText(/Bun is missing there/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install the runner on studio" })).not.toBeInTheDocument();
    expect(posted).toEqual([{ op: "precheck", target: "me@studio", label: "" }]);
  });

  it("shows the one-line command of a pasted enrollment for macOS or Linux and for PowerShell, and how long it still works", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const opened = Date.now();
    const enrollment: Enrollment = {
      label: "studio", code: "Q29kZS1mb3ItdGVzdHMtb25seS0zMi1ieXRlcy1sb25nIQ", fingerprint: "sha256:ab12", listen: "100.70.1.2:7411",
      expiresAt: opened + 60_000 + 10 * 60_000,
    };
    const posted = serve([host], [], { enrollment });
    renderPanel();
    // The command is made a minute after the section opened: its countdown starts from then.
    vi.setSystemTime(opened + 60_000);

    fireEvent.click(await screen.findByText("Add a computer"));
    fireEvent.click(screen.getByRole("radio", { name: "Paste a command" }));
    const form = screen.getByRole("form", { name: "Paste a command" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "studio" } });
    fireEvent.change(within(form).getByLabelText("Its private address"), { target: { value: "100.70.1.2" } });
    fireEvent.click(within(form).getByRole("button", { name: "Make the command" }));
    const command = await within(form).findByLabelText("Command");
    expect(posted).toEqual([{ op: "enroll-code", label: "studio", address: "100.70.1.2" }]);
    expect(command.textContent).toBe(
      `curl -fsSL '${location.origin}/runner-enroll/install.sh' | DORI_SERVER='${location.origin}' DORI_LABEL='studio' DORI_CODE='${enrollment.code}' DORI_FINGERPRINT='sha256:ab12' sh`,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Windows (PowerShell)" }));
    expect(command.textContent).toContain(`irm '${location.origin}/runner-enroll/install.ps1' | iex`);
    expect(screen.getByText("Waiting for studio to connect...")).toBeInTheDocument();
    expect(await screen.findByText("It works once, for 10:00 more.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Over ssh from this server" }));
    fireEvent.click(screen.getByRole("radio", { name: "Paste a command" }));
    expect(within(screen.getByRole("form", { name: "Paste a command" })).getByLabelText("Command")).toBe(command);
  });
});
