import { type FormEvent, useEffect, useState } from "react";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@/components/button";
import { fill, useMessages } from "@/lib/i18n";
import { ENROLL_SHELLS, type EnrollShell, enrollCommands, type RunnerProblem } from "@/lib/machines";
import type { Messages } from "@/locales/en";
import { useEnrollCode, useMachineJobAction, useMachines, usePrecheck } from "@/web/machines";

type Texts = Messages["settings"]["machines"];
type Method = "ssh" | "paste";

const HC_INSTALL_COMMAND = "curl -fsSL https://releases.herdr.dev/core/install.sh | sh";

/** One problem in plain words, with what the host saw folded under it. */
export function ProblemText({ problem, t }: { problem: Pick<RunnerProblem, "code"> & { detail?: string }; t: Texts }) {
  const text = t.add.problems[problem.code];
  return (
    <>
      <p>{problem.code === "no-hc" ? fill(text, { command: <code className="break-all">{HC_INSTALL_COMMAND}</code> }) : text}</p>
      {problem.detail && <p className="break-words text-xs text-muted-foreground">{t.add.detail(problem.detail)}</p>}
    </>
  );
}

/** ssh target and name, the host's checks, then the install job once they pass. */
function SshForm({ t }: { t: Texts }) {
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");
  const precheck = usePrecheck();
  const add = useMachineJobAction();
  const checked = precheck.data;
  // A result stands only for the inputs it checked.
  const current = checked !== undefined && checked.target === target.trim() && (label.trim() === "" || checked.label === label.trim());
  const check = (event: FormEvent) => {
    event.preventDefault();
    add.reset();
    precheck.mutate({ op: "precheck", target: target.trim(), label: label.trim() });
  };
  return (
    <form aria-label={t.add.methods.ssh} className="flex flex-col gap-3" onSubmit={check}>
      <p className="text-muted-foreground">{t.add.sshIntro}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <TextInput size="sm" label={t.add.target} description={t.add.targetHelp} placeholder="user@192.168.1.20" hasSpellCheck={false} value={target} onChange={setTarget} />
        <TextInput size="sm" label={t.add.label} description={t.add.labelHelp} placeholder="studio" hasSpellCheck={false} value={label} onChange={setLabel} />
      </div>
      <Button type="submit" size="sm" variant="secondary" className="self-start" label={precheck.isPending ? t.add.checking : t.add.check} isDisabled={precheck.isPending || target.trim() === ""} />
      {precheck.error && <p role="alert" className="break-words text-destructive">{precheck.error.message}</p>}
      {current && checked.problems.length > 0 && (
        <div role="alert" className="flex flex-col gap-2 rounded-md border border-destructive/50 p-3">
          <p className="font-medium">{t.add.fix}</p>
          <ul className="flex list-disc flex-col gap-2 pl-5">
            {checked.problems.map((problem) => (
              <li key={problem.code}><ProblemText problem={problem} t={t} /></li>
            ))}
          </ul>
        </div>
      )}
      {current && checked.problems.length === 0 && (
        <div className="flex flex-col gap-2 rounded-md border border-primary/40 p-3">
          <p role="status">{t.add.ready(checked.label, checked.os ?? "")}</p>
          <Button
            changesData
            size="sm"
            variant="primary"
            className="self-start"
            label={t.add.install(checked.label)}
            isDisabled={add.isPending || add.isSuccess}
            onClick={() => add.mutate({ op: "add-ssh", target: checked.target, label: checked.label })}
          />
          {add.isSuccess && <p role="status" className="text-muted-foreground">{t.add.started}</p>}
          {add.error && <p role="alert" className="break-words text-destructive">{add.error.message}</p>}
        </div>
      )}
    </form>
  );
}

const minutesSeconds = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** The current time, read again whenever `until` changes and each second while there is one. */
function useNow(until: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return now;
}

/** Name, private address and server address, then the one-line command and its countdown until the computer connects. */
function PasteForm({ t }: { t: Texts }) {
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [server, setServer] = useState(() => window.location.origin);
  const [shell, setShell] = useState<EnrollShell>(() => (navigator.userAgent.includes("Windows") ? "windows" : "posix"));
  const [copied, setCopied] = useState(false);
  const issue = useEnrollCode();
  const enrollment = issue.data;
  const now = useNow(enrollment?.expiresAt);
  const machines = useMachines(true, enrollment !== undefined);
  const connected = enrollment !== undefined && (machines.data?.machines ?? []).some((row) => row.label === enrollment.label && row.state === "connected");
  const remaining = enrollment === undefined ? 0 : enrollment.expiresAt - now;
  const command = enrollment === undefined ? "" : enrollCommands(server.trim(), enrollment)[shell];
  const make = (event: FormEvent) => {
    event.preventDefault();
    setCopied(false);
    issue.mutate({ op: "enroll-code", label: label.trim(), address: address.trim() });
  };
  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
  };
  return (
    <form aria-label={t.add.methods.paste} className="flex flex-col gap-3" onSubmit={make}>
      <p className="text-muted-foreground">{t.add.pasteIntro}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <TextInput size="sm" label={t.add.label} placeholder="studio" hasSpellCheck={false} value={label} onChange={setLabel} />
        <TextInput size="sm" label={t.add.address} description={t.add.addressHelp} placeholder="192.168.1.20" hasSpellCheck={false} value={address} onChange={setAddress} />
        <TextInput size="sm" containerClassName="md:col-span-2" label={t.add.server} description={t.add.serverHelp} hasSpellCheck={false} value={server} onChange={setServer} />
      </div>
      <Button
        type="submit"
        changesData
        size="sm"
        variant="secondary"
        className="self-start"
        label={t.add.makeCommand}
        isDisabled={issue.isPending || label.trim() === "" || address.trim() === "" || !/^https?:\/\/\S+$/.test(server.trim())}
      />
      {issue.error && <p role="alert" className="break-words text-destructive">{issue.error.message}</p>}
      {enrollment && (
        <div className="flex flex-col gap-2 rounded-md border border-primary/40 p-3">
          <SegmentedControl label={t.add.shell} size="sm" value={shell} onChange={(value) => setShell(value as EnrollShell)}>
            {ENROLL_SHELLS.map((value) => <SegmentedControlItem key={value} value={value} label={t.add.shells[value]} />)}
          </SegmentedControl>
          <pre aria-label={t.add.command} className="overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre-wrap break-all dark:bg-card">{command}</pre>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" label={copied ? t.add.copied : t.add.copy} isDisabled={remaining <= 0} onClick={() => void copy()} />
            <span role="status" className={remaining > 0 || connected ? "text-muted-foreground" : "text-destructive"}>
              {connected ? t.add.connected(enrollment.label) : remaining > 0 ? t.add.expiresIn(minutesSeconds(remaining)) : t.add.expired}
            </span>
          </div>
          {!connected && remaining > 0 && <p className="text-muted-foreground">{t.add.waiting(enrollment.label)}</p>}
        </div>
      )}
    </form>
  );
}

/** Settings > Machines & accounts > Add a computer: over ssh from this server, or by a command pasted on the new one. */
export function AddMachine() {
  const t = useMessages().settings.machines;
  const [method, setMethod] = useState<Method>("ssh");
  return (
    <div className="flex flex-col gap-3 pt-2">
      <p className="rounded-md bg-muted px-3 py-2 dark:bg-card">{t.add.privateNetwork}</p>
      <SegmentedControl label={t.add.method} size="sm" value={method} onChange={(value) => setMethod(value as Method)}>
        <SegmentedControlItem value="ssh" label={t.add.methods.ssh} />
        <SegmentedControlItem value="paste" label={t.add.methods.paste} />
      </SegmentedControl>
      {/* Both stay mounted, so a command made on one tab is still there after a look at the other. */}
      <div hidden={method !== "ssh"}><SshForm t={t} /></div>
      <div hidden={method !== "paste"}><PasteForm t={t} /></div>
    </div>
  );
}
