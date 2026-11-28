import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enrollOverStdio, RunnerAuth, SupervisorAuth } from "../src/runner/auth.ts";
import { readRunnerEndpoints } from "../src/runner/endpoints.ts";
import { BOOTSTRAP_TEMPLATES, bootstrapScript, downloadToken, EnrollRefused, PasteEnrollments } from "../src/runner/paste-enroll.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "paste-enroll-"));
  dirs.push(root);
  const clock = { now: 1_800_000_000_000 };
  const auth = new SupervisorAuth(join(root, "state"), { now: () => clock.now });
  const enrollments = new PasteEnrollments({
    auth: () => auth, bundle: async () => "console.log('runner bundle');\n", agentCommand: ["omo"], stateDir: join(root, "state"), now: () => clock.now,
  });
  mkdirSync(join(root, "runner"), { mode: 0o700 });
  const runner = new RunnerAuth(join(root, "runner"));
  return { root, clock, auth, enrollments, runner };
};

test("a pasted enrollment downloads with the code's token, enrolls once, and the second download carries the reply the runner pins", async () => {
  const { auth, enrollments, runner, root } = setup();
  const enrollment = enrollments.issue("studio", "100.70.1.2");
  expect(enrollment).toMatchObject({ label: "studio", listen: "100.70.1.2:7411", fingerprint: auth.fingerprint });
  const token = downloadToken("studio", enrollment.code);

  await expect(enrollments.script("studio", "posix", "0".repeat(64))).rejects.toBeInstanceOf(EnrollRefused);
  await expect(enrollments.script("other", "posix", token)).rejects.toBeInstanceOf(EnrollRefused);
  const first = await enrollments.script("studio", "posix", token);
  expect(first).toContain(`F='${auth.fingerprint}'`);
  expect(first).toContain(`C='${enrollment.code}'`);
  expect(first).toContain("console.log('runner bundle');");
  expect(first).not.toContain("reply=");
  expect(await enrollments.script("studio", "windows", token)).toContain(`$F = '${auth.fingerprint}'`);

  const params = { auth: runner, code: enrollment.code, label: "studio", hostId: "studio-host", expectedFingerprint: enrollment.fingerprint };
  const request = enrollOverStdio(params) as string;
  expect(() => enrollments.exchange("studio", "f".repeat(64), request)).toThrow(EnrollRefused);
  expect(enrollments.exchange("studio", token, request)).toBe("studio");
  expect(readRunnerEndpoints(join(root, "state"))).toEqual({ studio: "100.70.1.2:7411" });
  expect(() => enrollments.exchange("studio", token, request)).toThrow("enrollment code already used");

  const second = await enrollments.script("studio", "posix", token);
  const reply = /reply=([A-Za-z0-9+/=]+)/.exec(second)?.[1];
  expect(reply).toBeDefined();
  enrollOverStdio(params, reply);
  expect(runner.supervisorKey()).toBe(auth.publicKey);
});

test("refuses a public or empty address and the host's own label, and a code past its 10 minutes", async () => {
  const { enrollments, clock } = setup();
  expect(() => enrollments.issue("far", "8.8.8.8")).toThrow("RUNNER_LISTEN_REFUSED 8.8.8.8 is not a private IP address");
  expect(() => enrollments.issue("far", "far.example.com")).toThrow("RUNNER_LISTEN_REFUSED");
  expect(() => enrollments.issue("local", "192.168.1.9")).toThrow("local is the server host's own runner");
  const enrollment = enrollments.issue("late", "192.168.1.9");
  clock.now += 10 * 60_000;
  await expect(enrollments.script("late", "posix", downloadToken("late", enrollment.code))).rejects.toThrow("expired");
});

test("the bootstrap scripts hash the token the supervisor checks, and the POSIX one parses", async () => {
  const posix = bootstrapScript("posix");
  expect(posix).not.toContain("@TOKEN_TAG@");
  expect(posix).toContain("printf 'dori-runner-enroll-download-1\\n%s\\n%s' \"$DORI_LABEL\" \"$DORI_CODE\"");
  expect(bootstrapScript("windows")).toContain('"dori-runner-enroll-download-1`n$L`n$($env:DORI_CODE)"');
  const root = mkdtempSync(join(tmpdir(), "paste-enroll-sh-"));
  dirs.push(root);
  writeFileSync(join(root, "enroll.sh"), posix);
  const parsed = Bun.spawn(["sh", "-n", join(root, "enroll.sh")], { stderr: "pipe" });
  expect(await parsed.exited).toBe(0);
  expect(BOOTSTRAP_TEMPLATES.posix.endsWith("runner-enroll.sh")).toBe(true);
});
