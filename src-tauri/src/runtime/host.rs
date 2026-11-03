//! Pure host command encoding. Staged contents (including credentials) travel on stdin,
//! never in an invocation. Callers own spawning, streaming, and transport lifetimes.

use crate::adapters::git::{
    Invocation, powershell_command, powershell_quote, shell_quote, windows_quote,
};
use crate::domain::model::MachineLabel;
use crate::domain::runtime::RunId;

/// Prefix for an argv entry naming a staged file, resolved on the execution host.
pub const RUN_FILE_PREFIX: &str = "{run}/";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostOs {
    Posix,
    Windows,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Host {
    Local,
    Ssh { target: MachineLabel, os: HostOs },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    Exited(i32),
    Running,
    Gone,
    Missing,
}

/// Parses exactly one probe response, allowing its terminating LF or CRLF.
pub fn parse_probe(output: &str) -> Result<Probe, &'static str> {
    let line = output
        .strip_suffix("\r\n")
        .or_else(|| output.strip_suffix('\n'))
        .unwrap_or(output);
    match line {
        "running" => Ok(Probe::Running),
        "gone" => Ok(Probe::Gone),
        "missing" => Ok(Probe::Missing),
        _ => {
            let code = line.strip_prefix("exited ").ok_or(
                "invalid host probe response; probe the run again to obtain its current state",
            )?;
            if code.is_empty()
                || !code
                    .bytes()
                    .enumerate()
                    .all(|(i, c)| c.is_ascii_digit() || (i == 0 && c == b'-'))
            {
                return Err("invalid exit code; probe the run again to obtain its current state");
            }
            code.parse()
                .map(Probe::Exited)
                .map_err(|_| "invalid exit code; probe the run again to obtain its current state")
        }
    }
}

/// The run directory as a shell expression, expanded only on the execution host.
pub fn run_directory(os: HostOs, run: RunId) -> String {
    match os {
        HostOs::Posix => format!("\"$HOME\"/{}", shell_quote(&format!(".toodo/runs/{run}"))),
        HostOs::Windows => format!(
            "(Join-Path $env:USERPROFILE {})",
            powershell_quote(&format!(r".toodo\runs\{run}"))
        ),
    }
}

fn posix_directory(run: RunId) -> String {
    format!("run={}\n", run_directory(HostOs::Posix, run))
}

fn windows_directory(run: RunId) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'\n$run = {}\n",
        run_directory(HostOs::Windows, run)
    )
}

impl Host {
    pub fn os(&self) -> HostOs {
        match self {
            Self::Local => HostOs::Posix,
            Self::Ssh { os, .. } => *os,
        }
    }

    fn remote(&self, command: String) -> Invocation {
        let Self::Ssh { target, .. } = self else {
            unreachable!("only SSH command encoding calls remote")
        };
        // Keep the same transport flags and target boundary as git::ssh_invocation.
        Invocation {
            program: "ssh",
            args: vec![
                "-o".into(),
                "BatchMode=yes".into(),
                "--".into(),
                target.as_str().into(),
                command,
            ],
        }
    }

    fn script(&self, script: String) -> Invocation {
        match self {
            Self::Local => Invocation {
                program: "sh",
                args: vec!["-c".into(), script],
            },
            Self::Ssh {
                os: HostOs::Posix, ..
            } => self.remote(format!("sh -c {}", shell_quote(&script))),
            Self::Ssh {
                os: HostOs::Windows,
                ..
            } => self.remote(powershell_command(&script)),
        }
    }

    /// Writes stdin bytes to a staged file. The contents are intentionally not an input
    /// to this builder, so a bearer token cannot become part of the command.
    pub fn stage(&self, run: RunId, file: &str) -> Invocation {
        self.script(match self.os() {
            HostOs::Posix => format!(
                "{}umask 077\nmkdir -p -- \"$run\" || exit\nchmod 700 -- \"$run\" || exit\nfile=\"$run\"/{}\n: > \"$file\" || exit\nchmod 600 -- \"$file\" || exit\ncat > \"$file\"\n",
                posix_directory(run), shell_quote(file)
            ),
            HostOs::Windows => format!(
                "{}[System.IO.Directory]::CreateDirectory($run) | Out-Null\n$file = [System.IO.File]::Open((Join-Path $run {}), [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)\ntry {{ [Console]::OpenStandardInput().CopyTo($file) }} finally {{ $file.Dispose() }}\n",
                windows_directory(run), powershell_quote(file)
            ),
        })
    }

    /// Runs an argv with brief.md on stdin and live stdout/stderr. Secret environment
    /// entries are (environment name, staged filename), never credential values.
    pub fn launch(
        &self,
        run: RunId,
        argv: &[String],
        cwd: &str,
        secret_env: &[(&str, &str)],
        env: &[(&str, &str)],
    ) -> Result<Invocation, &'static str> {
        let script = wrapper_script(self.os(), run, argv, cwd, secret_env, env, false)?;
        if matches!(
            self,
            Self::Ssh {
                os: HostOs::Posix,
                ..
            }
        ) {
            // The remote wrapper must own its session, not the ssh transport's group.
            Ok(self.remote(format!("exec setsid --wait sh -c {}", shell_quote(&script))))
        } else {
            Ok(self.script(script))
        }
    }

    /// Checks the recorded process identity before terminating its process tree/group.
    /// POSIX gives the group two seconds to stop before escalating to SIGKILL.
    pub fn stop(&self, run: RunId) -> Invocation {
        self.script(match self.os() {
            HostOs::Posix => format!(
                "{}\
umask 077
if [ -d \"$run\" ]; then : > \"$run/stop\" || exit; fi
if [ ! -f \"$run/pid\" ]; then printf 'gone\\n'; exit; fi
IFS=' ' read -r pid identity < \"$run/pid\"
case \"$pid\" in ''|*[!0-9]*) printf 'mismatch\\n'; exit;; esac
current=$(LC_ALL=C ps -o lstart= -p \"$pid\" 2>/dev/null)
if [ -z \"$current\" ]; then printf 'gone\\n'; exit; fi
if [ \"$current\" != \"$identity\" ]; then printf 'mismatch\\n'; exit; fi
env kill -TERM -- \"-$pid\" 2>/dev/null
n=0
while env kill -0 -- \"-$pid\" 2>/dev/null && [ \"$n\" -lt 20 ]; do
    sleep 0.1
    n=$((n + 1))
done
current=$(LC_ALL=C ps -o lstart= -p \"$pid\" 2>/dev/null)
if [ -n \"$current\" ] && [ \"$current\" != \"$identity\" ]; then printf 'mismatch\\n'; exit; fi
if env kill -0 -- \"-$pid\" 2>/dev/null; then env kill -KILL -- \"-$pid\" 2>/dev/null || exit 1; fi
printf 'stopped\\n'
",
                posix_directory(run)
            ),
            HostOs::Windows => format!(
                "{}\
if (Test-Path -LiteralPath $run) {{ [System.IO.File]::WriteAllText((Join-Path $run 'stop'), '') }}
if (!(Test-Path -LiteralPath (Join-Path $run 'pid'))) {{ 'gone'; exit }}
$record = [System.IO.File]::ReadAllText((Join-Path $run 'pid')).Trim() -split ' ', 2
$process = Get-Process -Id ([int]$record[0]) -ErrorAction SilentlyContinue
if (!$process) {{ 'gone'; exit }}
if ($process.StartTime.ToFileTimeUtc().ToString() -ne $record[1]) {{ 'mismatch'; exit }}
& taskkill /PID $process.Id /T /F | Out-Null
if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}
'stopped'
",
                windows_directory(run)
            ),
        })
    }

    /// Reads durable exit evidence first, then checks the recorded start identity.
    pub fn probe(&self, run: RunId) -> Invocation {
        self.script(match self.os() {
            HostOs::Posix => format!(
                "{}\
if [ -f \"$run/exit\" ]; then printf 'exited %s\\n' \"$(cat \"$run/exit\")\"; exit; fi
if [ ! -f \"$run/pid\" ]; then printf 'missing\\n'; exit; fi
IFS=' ' read -r pid identity < \"$run/pid\"
case \"$pid\" in ''|*[!0-9]*) printf 'gone\\n'; exit;; esac
current=$(LC_ALL=C ps -o lstart= -p \"$pid\" 2>/dev/null)
if [ -n \"$current\" ] && [ \"$current\" = \"$identity\" ]; then printf 'running\\n'; else printf 'gone\\n'; fi
", posix_directory(run)
            ),
            HostOs::Windows => format!(
                "{}\
if (Test-Path -LiteralPath (Join-Path $run 'exit')) {{ 'exited ' + [System.IO.File]::ReadAllText((Join-Path $run 'exit')).Trim(); exit }}
if (!(Test-Path -LiteralPath (Join-Path $run 'pid'))) {{ 'missing'; exit }}
$record = [System.IO.File]::ReadAllText((Join-Path $run 'pid')).Trim() -split ' ', 2
$process = Get-Process -Id ([int]$record[0]) -ErrorAction SilentlyContinue
if ($process -and $process.StartTime.ToFileTimeUtc().ToString() -eq $record[1]) {{ 'running' }} else {{ 'gone' }}
", windows_directory(run)
            ),
        })
    }

    fn tmux(&self, args: Vec<String>) -> Result<Invocation, &'static str> {
        if self.os() != HostOs::Posix {
            return Err("tmux requires a POSIX host; choose runner plain or herdr on Windows");
        }
        Ok(match self {
            Self::Local => Invocation {
                program: "tmux",
                args,
            },
            Self::Ssh { .. } => self.remote(format!(
                "tmux {}",
                args.iter()
                    .map(|s| shell_quote(s))
                    .collect::<Vec<_>>()
                    .join(" ")
            )),
        })
    }

    /// Starts a detached tmux session running a wrapper script from wrapper_script.
    pub fn tmux_new_session(
        &self,
        run: RunId,
        cwd: &str,
        wrapper: &str,
    ) -> Result<Invocation, &'static str> {
        self.tmux(vec![
            "new-session".into(),
            "-d".into(),
            "-s".into(),
            session(run),
            "-c".into(),
            cwd.into(),
            format!("sh -c {}", shell_quote(wrapper)),
        ])
    }

    pub fn tmux_has_session(&self, run: RunId) -> Result<Invocation, &'static str> {
        self.tmux(vec![
            "has-session".into(),
            "-t".into(),
            format!("={}", session(run)),
        ])
    }

    pub fn tmux_kill_session(&self, run: RunId) -> Result<Invocation, &'static str> {
        self.tmux(vec![
            "kill-session".into(),
            "-t".into(),
            format!("={}", session(run)),
        ])
    }

    pub fn tmux_wait_for(&self, run: RunId) -> Result<Invocation, &'static str> {
        self.tmux(vec!["wait-for".into(), session(run)])
    }

    /// Reads the last bytes of a POSIX run log without interpreting its filename.
    pub fn tail(&self, run: RunId, file: &str, bytes: usize) -> Result<Invocation, &'static str> {
        if self.os() != HostOs::Posix {
            return Err("tmux log tail requires POSIX; choose runner plain or herdr on Windows");
        }
        Ok(self.script(format!(
            "{}tail -c {} -- \"$run\"/{}\n",
            posix_directory(run),
            shell_quote(&bytes.to_string()),
            shell_quote(file)
        )))
    }
}

fn session(run: RunId) -> String {
    format!("toodo-run-{run}")
}

/// Builds the native wrapper script. tmux mode is POSIX only, tees both streams to
/// separate run logs, and signals wait-for after logs and exit status are durable.
pub fn wrapper_script(
    os: HostOs,
    run: RunId,
    argv: &[String],
    cwd: &str,
    secret_env: &[(&str, &str)],
    env: &[(&str, &str)],
    tmux: bool,
) -> Result<String, &'static str> {
    let Some(program) = argv.first() else {
        return Err("an agent argv is required; choose an agent command before launching the run");
    };
    if tmux && os == HostOs::Windows {
        return Err("tmux requires a POSIX host; choose runner plain or herdr on Windows");
    }
    Ok(match os {
        HostOs::Posix => {
            let mut script = posix_directory(run);
            if !tmux {
                script.push_str("trap '' HUP\n");
            }
            script.push_str(&format!("umask 077\ncd {} || exit\nprintf '%s %s\\n' \"$$\" \"$(LC_ALL=C ps -o lstart= -p $$)\" > \"$run/pid\"\n", shell_quote(cwd)));
            script.push_str(
                "if [ -f \"$run/stop\" ]; then printf '143\\n' > \"$run/exit\"; exit 143; fi\n",
            );
            for (name, file) in secret_env {
                script.push_str(&format!(
                    "export {}=\"$(cat \"$run\"/{})\"\n",
                    shell_quote(name),
                    shell_quote(file)
                ));
            }
            for (name, value) in env {
                script.push_str(&format!(
                    "export {}\n",
                    shell_quote(&format!("{name}={value}"))
                ));
            }
            if tmux {
                script.push_str("mkfifo -- \"$run/out.pipe\" \"$run/err.pipe\" || exit\n");
                // Redact before tee: neither the durable logs nor the terminal may
                // contain the bearer token. index/substr treat it as literal text.
                let redact = r#"if [ -n "${TOODO_MCP_TOKEN:-}" ]; then awk '{ s = ENVIRON["TOODO_MCP_TOKEN"]; line = $0; out = ""; while (s != "" && (i = index(line, s)) > 0) { out = out substr(line, 1, i - 1) "[redacted]"; line = substr(line, i + length(s)); } print out line; fflush(); }'; else cat; fi"#;
                script.push_str(&format!("{redact} < \"$run/out.pipe\" | tee \"$run/stdout.log\" &\nout=$!\n{redact} < \"$run/err.pipe\" | tee \"$run/stderr.log\" >&2 &\nerr=$!\n"));
            }
            script.push_str(
                &argv
                    .iter()
                    .map(|arg| match arg.strip_prefix(RUN_FILE_PREFIX) {
                        Some(file) => format!("\"$run\"/{}", shell_quote(file)),
                        None => shell_quote(arg),
                    })
                    .collect::<Vec<_>>()
                    .join(" "),
            );
            script.push_str(" < \"$run/brief.md\"");
            if tmux {
                script.push_str(" > \"$run/out.pipe\" 2> \"$run/err.pipe\"");
            }
            script.push_str("\ncode=$?\n");
            if tmux {
                script.push_str(
                    "wait \"$out\"\nwait \"$err\"\nrm -- \"$run/out.pipe\" \"$run/err.pipe\"\n",
                );
            }
            script.push_str("printf '%s\\n' \"$code\" > \"$run/exit\"\n");
            if tmux {
                script.push_str(&format!(
                    "tmux wait-for -S {}\n",
                    shell_quote(&session(run))
                ));
            }
            script.push_str("exit \"$code\"\n");
            script
        }
        HostOs::Windows => {
            let mut script = windows_directory(run);
            script.push_str("$info = New-Object System.Diagnostics.ProcessStartInfo\n");
            let arguments = if argv[1..].iter().any(|arg| arg.starts_with(RUN_FILE_PREFIX)) {
                format!(
                    "(@({}) -join ' ')",
                    argv[1..]
                        .iter()
                        .map(|arg| match arg.strip_prefix(RUN_FILE_PREFIX) {
                            Some(file) => format!(
                                "('\"' + (Join-Path $run {}) + '\"')",
                                powershell_quote(file)
                            ),
                            None => powershell_quote(&windows_quote(arg)),
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            } else {
                powershell_quote(
                    &argv[1..]
                        .iter()
                        .map(|arg| windows_quote(arg))
                        .collect::<Vec<_>>()
                        .join(" "),
                )
            };
            script.push_str(&format!(
                "$info.FileName = (Get-Command -Name {} -CommandType Application -TotalCount 1).Path\n$info.Arguments = {}\n$info.WorkingDirectory = {}\n",
                powershell_quote(program),
                arguments,
                powershell_quote(cwd)
            ));
            for (name, file) in secret_env {
                script.push_str(&format!("$info.EnvironmentVariables[{}] = [System.IO.File]::ReadAllText((Join-Path $run {}))\n", powershell_quote(name), powershell_quote(file)));
            }
            for (name, value) in env {
                script.push_str(&format!(
                    "$info.EnvironmentVariables[{}] = {}\n",
                    powershell_quote(name),
                    powershell_quote(value)
                ));
            }
            script.push_str(
                "$info.UseShellExecute = $false
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
if (Test-Path -LiteralPath (Join-Path $run 'stop')) { [System.IO.File]::WriteAllText((Join-Path $run 'exit'), '143'); exit 143 }
$process = [System.Diagnostics.Process]::Start($info)
[System.IO.File]::WriteAllText((Join-Path $run 'pid'), ($process.Id.ToString() + ' ' + $process.StartTime.ToFileTimeUtc().ToString()))
if (Test-Path -LiteralPath (Join-Path $run 'stop')) { & taskkill /PID $process.Id /T /F | Out-Null }
$out = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
$err = $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
$brief = [System.IO.File]::OpenRead((Join-Path $run 'brief.md'))
try { $brief.CopyTo($process.StandardInput.BaseStream) } finally { $brief.Dispose(); $process.StandardInput.Close() }
$process.WaitForExit()
$out.Wait()
$err.Wait()
$code = $process.ExitCode
[System.IO.File]::WriteAllText((Join-Path $run 'exit'), $code.ToString())
exit $code
",
            );
            script
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::git::fake::decode_powershell;
    use std::io::Write;
    use std::process::{Command, Output, Stdio};

    fn ssh(os: HostOs) -> Host {
        Host::Ssh {
            target: MachineLabel::parse("devbox").unwrap(),
            os,
        }
    }

    fn execute(invocation: &Invocation, home: &std::path::Path, input: &[u8]) -> Output {
        let mut child = Command::new(invocation.program)
            .args(&invocation.args)
            .env("HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        child.wait_with_output().unwrap()
    }

    #[test]
    fn probe_parser_accepts_only_one_complete_response() {
        for (line, expected) in [
            ("missing", Probe::Missing),
            ("gone\n", Probe::Gone),
            ("running\r\n", Probe::Running),
            ("exited 0\n", Probe::Exited(0)),
            ("exited 137", Probe::Exited(137)),
            ("exited -1", Probe::Exited(-1)),
        ] {
            assert_eq!(parse_probe(line), Ok(expected));
        }
        for line in [
            "",
            " running",
            "running ",
            "running\n\n",
            "running\ngone",
            "exited",
            "exited ",
            "exited +1",
            "exited 1 2",
            "exited 2147483648",
            "exited -",
            "exited 0\njunk",
            "nope",
        ] {
            assert!(parse_probe(line).is_err(), "{line:?}");
        }
    }

    #[test]
    fn posix_stage_and_wrapper_preserve_arguments_cwd_and_stdin_without_exposing_token() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let cwd = home
            .path()
            .join("cwd ' \" $(touch injected) `touch injected`\nnext");
        std::fs::create_dir(&cwd).unwrap();
        let run = RunId(41);
        let token = "secret-token-not-in-command";
        for (name, data) in [
            ("token", token.as_bytes()),
            ("brief.md", b"brief\nwith bytes\0"),
        ] {
            let stage = Host::Local.stage(run, name);
            assert!(!format!("{stage:?}").contains(token));
            let output = execute(&stage, home.path(), data);
            assert!(output.status.success(), "{output:?}");
        }
        let dir = home.path().join(".toodo/runs/41");
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(dir.join("token"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let args = [
            "",
            "space here",
            "a'b\"c",
            "$(touch injected)",
            "`touch injected`",
            "line\nbreak",
            r"back\slash\",
        ];
        let mut argv: Vec<String> = ["sh", "-c",
            "printf '%s\\000' \"$PWD\" \"$TOODO_MCP_TOKEN\" \"$TOODO_MCP_URL\" \"$@\"; cat; printf 'stderr' >&2; exit 7",
            "agent"].map(str::to_owned).to_vec();
        argv.extend(args.map(str::to_owned));
        let launch = Host::Local
            .launch(
                run,
                &argv,
                cwd.to_str().unwrap(),
                &[("TOODO_MCP_TOKEN", "token")],
                &[("TOODO_MCP_URL", "http://127.0.0.1:123/mcp")],
            )
            .unwrap();
        assert!(!format!("{launch:?}").contains(token));
        let output = execute(&launch, home.path(), b"");
        assert_eq!(output.status.code(), Some(7), "{output:?}");
        let mut expected = Vec::new();
        for value in [cwd.to_str().unwrap(), token, "http://127.0.0.1:123/mcp"]
            .into_iter()
            .chain(args)
        {
            expected.extend_from_slice(value.as_bytes());
            expected.push(0);
        }
        expected.extend_from_slice(b"brief\nwith bytes\0");
        assert_eq!(output.stdout, expected);
        assert_eq!(output.stderr, b"stderr");
        assert_eq!(std::fs::read_to_string(dir.join("exit")).unwrap(), "7\n");
        let pid = std::fs::read_to_string(dir.join("pid")).unwrap();
        assert!(pid.trim().split_once(' ').is_some());
        assert!(!cwd.join("injected").exists());
        assert_eq!(
            parse_probe(
                std::str::from_utf8(&execute(&Host::Local.probe(run), home.path(), b"").stdout)
                    .unwrap()
            ),
            Ok(Probe::Exited(7))
        );
    }

    #[test]
    fn tmux_wrapper_tees_streams_and_signals_after_recording_exit() {
        let home = tempfile::tempdir().unwrap();
        let run = RunId(45);
        let output = execute(&Host::Local.stage(run, "brief.md"), home.path(), b"brief");
        assert!(output.status.success());
        let file = "file ' \" $() `x`\nnext";
        let output = execute(&Host::Local.stage(run, file), home.path(), b"exact bytes");
        assert!(output.status.success());
        assert_eq!(
            std::fs::read(home.path().join(".toodo/runs/45").join(file)).unwrap(),
            b"exact bytes"
        );
        // Replace only the external tmux notification, not the stream or status logic.
        let script = format!(
            "tmux() {{ test -f \"$HOME/.toodo/runs/45/exit\" || return 1; printf '%s\\n' \"$*\" > \"$HOME/signal\"; }}\n{}",
            wrapper_script(
                HostOs::Posix,
                run,
                &[
                    "sh".into(),
                    "-c".into(),
                    "cat; printf 'error' >&2; exit 9".into()
                ],
                home.path().to_str().unwrap(),
                &[],
                &[],
                true
            )
            .unwrap()
        );
        let output = execute(&Host::Local.script(script), home.path(), b"");
        assert_eq!(output.status.code(), Some(9));
        assert_eq!(output.stdout, b"brief");
        assert_eq!(output.stderr, b"error");
        let dir = home.path().join(".toodo/runs/45");
        assert_eq!(std::fs::read(dir.join("stdout.log")).unwrap(), b"brief");
        assert_eq!(std::fs::read(dir.join("stderr.log")).unwrap(), b"error");
        assert_eq!(std::fs::read(dir.join("exit")).unwrap(), b"9\n");
        assert_eq!(
            std::fs::read(home.path().join("signal")).unwrap(),
            b"wait-for -S toodo-run-45\n"
        );
        assert!(!dir.join("out.pipe").exists());
        assert!(!dir.join("err.pipe").exists());
    }

    #[test]
    fn posix_probe_checks_start_identity_and_stop_refuses_a_mismatch() {
        let home = tempfile::tempdir().unwrap();
        let run = RunId(42);
        let output = execute(&Host::Local.probe(run), home.path(), b"");
        assert_eq!(
            parse_probe(std::str::from_utf8(&output.stdout).unwrap()),
            Ok(Probe::Missing)
        );
        let record = format!("{} wrong identity\n", std::process::id());
        assert!(
            execute(
                &Host::Local.stage(run, "pid"),
                home.path(),
                record.as_bytes()
            )
            .status
            .success()
        );
        let output = execute(&Host::Local.probe(run), home.path(), b"");
        assert_eq!(
            parse_probe(std::str::from_utf8(&output.stdout).unwrap()),
            Ok(Probe::Gone)
        );
        let output = execute(&Host::Local.stop(run), home.path(), b"");
        assert_eq!(output.stdout, b"mismatch\n");
        let identity = Command::new("ps")
            .args(["-o", "lstart=", "-p", &std::process::id().to_string()])
            .env("LC_ALL", "C")
            .output()
            .unwrap();
        let record = format!(
            "{} {}",
            std::process::id(),
            std::str::from_utf8(&identity.stdout).unwrap()
        );
        assert!(
            execute(
                &Host::Local.stage(run, "pid"),
                home.path(),
                record.as_bytes()
            )
            .status
            .success()
        );
        let output = execute(&Host::Local.probe(run), home.path(), b"");
        assert_eq!(
            parse_probe(std::str::from_utf8(&output.stdout).unwrap()),
            Ok(Probe::Running)
        );
    }

    #[test]
    fn windows_encodes_native_paths_argv_streams_and_identity_without_a_secret_value() {
        let host = ssh(HostOs::Windows);
        let run = RunId(43);
        let cwd = "C:\\repo ' \" $() `backtick`\nnext";
        let argv = [
            "agent.exe",
            "a'b\" c",
            "$(not-code)",
            "`x`",
            "line\nnext",
            r"tail \",
        ]
        .map(str::to_owned);
        let launch = host
            .launch(
                run,
                &argv,
                cwd,
                &[("TOODO_MCP_TOKEN", "token")],
                &[("TOODO_MCP_URL", "http://127.0.0.1:123/mcp")],
            )
            .unwrap();
        assert_eq!(&launch.args[..4], ["-o", "BatchMode=yes", "--", "devbox"]);
        let script = decode_powershell(&launch.args[4]);
        assert!(script.contains(&format!(
            "$info.WorkingDirectory = {}",
            powershell_quote(cwd)
        )));
        assert!(script.contains(&format!(
                "$info.Arguments = {}",
                powershell_quote(
                    &argv[1..]
                        .iter()
                        .map(|s| windows_quote(s))
                        .collect::<Vec<_>>()
                        .join(" ")
                )
            )));
        for part in [
            "$env:USERPROFILE",
            r".toodo\runs\43",
            "ProcessStartInfo",
            "StartTime.ToFileTimeUtc()",
            "$process.Id",
            "'brief.md'",
            "CopyToAsync",
            "$brief.CopyTo($process.StandardInput.BaseStream)",
            "'exit'",
            "$info.EnvironmentVariables['TOODO_MCP_TOKEN'] = [System.IO.File]::ReadAllText",
        ] {
            assert!(script.contains(part), "{part}: {script}");
        }
        for invocation in [
            host.stage(run, "token"),
            launch,
            host.stop(run),
            host.probe(run),
        ] {
            let decoded = decode_powershell(&invocation.args[4]);
            assert!(!decoded.contains("secret-token-not-in-command"));
            assert!(!decoded.contains("sh -c"));
        }
        let stage = decode_powershell(&host.stage(run, "a'b`$()\n").args[4]);
        assert!(stage.contains(&powershell_quote("a'b`$()\n")));
        assert!(stage.contains("[Console]::OpenStandardInput().CopyTo($file)"));
        let stop = decode_powershell(&host.stop(run).args[4]);
        assert!(stop.contains("taskkill /PID $process.Id /T /F"));
        assert!(stop.contains("StartTime.ToFileTimeUtc()"));
        assert!(host.tmux_wait_for(run).is_err());
    }

    #[test]
    fn tmux_builders_encode_local_argv_and_posix_ssh_commands() {
        let host = ssh(HostOs::Posix);
        let run = RunId(44);
        let cwd = "/repo ' \" $() `x`\nnext";
        let wrapper = wrapper_script(
            HostOs::Posix,
            run,
            &["agent".into(), "a'b $()\n".into()],
            cwd,
            &[("TOODO_MCP_TOKEN", "token")],
            &[],
            true,
        )
        .unwrap();
        for part in [
            "$$",
            "ps -o lstart=",
            "tee \"$run/stdout.log\"",
            "tee \"$run/stderr.log\"",
            "wait \"$out\"",
            "wait \"$err\"",
            "tmux wait-for -S 'toodo-run-44'",
        ] {
            assert!(wrapper.contains(part), "{part}");
        }
        let local = Host::Local.tmux_new_session(run, cwd, &wrapper).unwrap();
        assert_eq!(local.program, "tmux");
        assert_eq!(
            &local.args[..6],
            ["new-session", "-d", "-s", "toodo-run-44", "-c", cwd]
        );
        let remote = host.tmux_new_session(run, cwd, &wrapper).unwrap();
        assert_eq!(
            remote.args[4],
            format!(
                "tmux {}",
                local
                    .args
                    .iter()
                    .map(|s| shell_quote(s))
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        );
        for (local, remote) in [
            (
                Host::Local.tmux_has_session(run).unwrap(),
                host.tmux_has_session(run).unwrap(),
            ),
            (
                Host::Local.tmux_kill_session(run).unwrap(),
                host.tmux_kill_session(run).unwrap(),
            ),
            (
                Host::Local.tmux_wait_for(run).unwrap(),
                host.tmux_wait_for(run).unwrap(),
            ),
        ] {
            assert_eq!(
                remote.args[4],
                format!(
                    "tmux {}",
                    local
                        .args
                        .iter()
                        .map(|s| shell_quote(s))
                        .collect::<Vec<_>>()
                        .join(" ")
                )
            );
        }
        let tail = host.tail(run, "stdout.log' $()\n", 4096).unwrap();
        assert!(tail.args[4].contains(&shell_quote(&format!(
            "{}tail -c '4096' -- \"$run\"/{}\n",
            posix_directory(run),
            shell_quote("stdout.log' $()\n")
        ))));
        let launch = host
            .launch(
                run,
                &["agent".into()],
                cwd,
                &[("TOODO_MCP_TOKEN", "token")],
                &[],
            )
            .unwrap();
        assert_eq!(&launch.args[..4], ["-o", "BatchMode=yes", "--", "devbox"]);
        assert!(launch.args[4].starts_with("exec setsid --wait sh -c '"));
    }
}
