//! herdr as a [`RunLauncher`]: a run is launched in a new tab of its runtime workspace's
//! herdr workspace, labelled after the run's request key, and its command is typed into
//! the tab's pane. Finding that tab again adopts the launch, so a retry never opens a
//! second tab for the same request. A run in an existing pane has its line typed into that
//! pane instead.

use super::{LaunchReceipt, LaunchSpec, RunCommand, RunLauncher, RunnerError};
use crate::adapters::git::shell_quote;
use crate::adapters::herdr::{Herdr, HerdrError};
use crate::domain::model::{Machine, MachineLabel};
use crate::domain::runtime::{HostRef, RunnerKind};

fn tab_label(request_key: &str) -> String {
    format!("toodo-run-{request_key}")
}

fn machine(host: &HostRef) -> Result<Machine, RunnerError> {
    match host {
        HostRef::Local => Ok(Machine::Local),
        HostRef::Ssh(target) => MachineLabel::parse(target).map(Machine::Ssh).map_err(|_| {
            RunnerError(format!(
                "host {host} names no SSH machine; start the run on the host of its runtime \
                 workspace"
            ))
        }),
    }
}

fn runner_error(error: HerdrError) -> RunnerError {
    RunnerError(error.to_string())
}

impl RunLauncher for Herdr {
    fn kind(&self) -> RunnerKind {
        RunnerKind::Herdr
    }

    fn find_launch(&self, spec: &LaunchSpec) -> Result<Option<LaunchReceipt>, RunnerError> {
        let (Some(workspace), RunCommand::NewTab(_)) = (&spec.workspace_ref, &spec.command) else {
            return Ok(None);
        };
        let pane = self
            .find_tab_pane(
                &machine(&spec.host)?,
                workspace,
                &tab_label(&spec.request_key),
            )
            .map_err(runner_error)?;
        Ok(pane.map(|provider_run_ref| LaunchReceipt { provider_run_ref }))
    }

    /// Opens the run's tab and types its command, quoted for a POSIX shell, into the
    /// tab's pane, or types the line of a run in an existing pane into that pane. The
    /// receipt is the pane ID.
    fn launch(&self, spec: &LaunchSpec) -> Result<LaunchReceipt, RunnerError> {
        let argv = match &spec.command {
            RunCommand::NewTab(argv) => argv,
            RunCommand::InPane { pane, line } => {
                self.run_in_machine_pane(&machine(&spec.host)?, pane, line)
                    .map_err(runner_error)?;
                return Ok(LaunchReceipt {
                    provider_run_ref: pane.clone(),
                });
            }
            RunCommand::ByHand => {
                return Err(RunnerError(format!(
                    "run {} of task {} has nothing for herdr to run; start the run with the \
                     agent's command as its argument vector or as a line for a pane",
                    spec.run, spec.task
                )));
            }
        };
        let workspace = spec.workspace_ref.as_deref().ok_or_else(|| {
            RunnerError(format!(
                "run {} of task {} has no herdr workspace to launch in; start the task so it \
                 has one, then start the run in its runtime workspace",
                spec.run, spec.task
            ))
        })?;
        if argv.is_empty() {
            return Err(RunnerError(format!(
                "run {} of task {} has no command; start the run with the agent's command as \
                 its argument vector",
                spec.run, spec.task
            )));
        }
        let machine = machine(&spec.host)?;
        let command = argv
            .iter()
            .map(|word| shell_quote(word))
            .collect::<Vec<_>>()
            .join(" ");
        let pane = self
            .create_tab(
                &machine,
                workspace,
                spec.cwd.as_deref(),
                &tab_label(&spec.request_key),
            )
            .map_err(runner_error)?;
        self.run_in_machine_pane(&machine, &pane, &command)
            .map_err(runner_error)?;
        Ok(LaunchReceipt {
            provider_run_ref: pane,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::adapters::git::fake::FakeRunner;
    use crate::adapters::git::{GitError, Invocation};
    use crate::domain::model::TaskId;
    use crate::domain::runtime::RunId;

    fn herdr(results: Vec<Result<String, GitError>>) -> (Herdr, Arc<FakeRunner>) {
        let runner = Arc::new(FakeRunner::new(results));
        (Herdr::new(Box::new(runner.clone())), runner)
    }

    fn args(runner: &FakeRunner) -> Vec<Vec<String>> {
        runner
            .invocations
            .lock()
            .unwrap()
            .iter()
            .map(|invocation: &Invocation| invocation.args.clone())
            .collect()
    }

    fn spec(host: HostRef, workspace: Option<&str>) -> LaunchSpec {
        LaunchSpec {
            run: RunId(4),
            request_key: "k1".to_owned(),
            generation: 1,
            task: TaskId(7),
            host,
            cwd: Some("/wt/add-login".to_owned()),
            workspace_ref: workspace.map(str::to_owned),
            command: RunCommand::NewTab(vec!["claude".to_owned(), "fix it's login".to_owned()]),
        }
    }

    #[test]
    fn a_run_in_an_existing_pane_gets_its_line_typed_as_is_and_is_never_found_again() {
        let (herdr, runner) = herdr(vec![Ok(String::new())]);
        let in_pane = LaunchSpec {
            command: RunCommand::InPane {
                pane: "w27:p1".to_owned(),
                line: "export A=1; claude".to_owned(),
            },
            ..spec(HostRef::Local, Some("w27"))
        };

        assert_eq!(herdr.find_launch(&in_pane).unwrap(), None);
        let receipt = herdr.launch(&in_pane).unwrap();

        assert_eq!(receipt.provider_run_ref, "w27:p1");
        assert_eq!(
            args(&runner),
            [["pane", "run", "w27:p1", "export A=1; claude"].map(str::to_owned)]
        );
    }

    const TAB_CREATED: &str = r#"{"id":"cli:tab:create","result":{"type":"tab_created",
        "root_pane":{"pane_id":"w27:p3","tab_id":"w27:t2","workspace_id":"w27"},
        "tab":{"label":"toodo-run-k1","tab_id":"w27:t2","workspace_id":"w27"}}}"#;

    #[test]
    fn a_run_launches_in_a_new_tab_of_its_herdr_workspace() {
        let (herdr, runner) = herdr(vec![Ok(TAB_CREATED.to_owned()), Ok(String::new())]);

        let receipt = herdr.launch(&spec(HostRef::Local, Some("w27"))).unwrap();

        assert_eq!(receipt.provider_run_ref, "w27:p3");
        assert_eq!(
            args(&runner),
            [
                vec![
                    "tab",
                    "create",
                    "--workspace",
                    "w27",
                    "--cwd",
                    "/wt/add-login",
                    "--label",
                    "toodo-run-k1",
                    "--no-focus",
                ],
                vec!["pane", "run", "w27:p3", r"'claude' 'fix it'\''s login'"],
            ]
            .map(|args| args.into_iter().map(str::to_owned).collect::<Vec<_>>())
        );
    }

    #[test]
    fn a_launch_is_found_again_by_the_label_of_its_tab() {
        let tabs = r#"{"id":"cli:tab:list","result":{"type":"tab_list","tabs":[
            {"label":"1","tab_id":"w27:t1"},{"label":"toodo-run-k1","tab_id":"w27:t2"}]}}"#;
        let panes = r#"{"id":"cli:pane:list","result":{"type":"pane_list","panes":[
            {"pane_id":"w27:p1","tab_id":"w27:t1"},{"pane_id":"w27:p3","tab_id":"w27:t2"}]}}"#;
        let (herdr, runner) = herdr(vec![
            Ok(tabs.to_owned()),
            Ok(panes.to_owned()),
            Ok(
                r#"{"id":"cli:tab:list","result":{"tabs":[{"label":"1","tab_id":"w27:t1"}]}}"#
                    .to_owned(),
            ),
        ]);
        let launched = spec(HostRef::Local, Some("w27"));

        let found = herdr.find_launch(&launched).unwrap();
        let other = herdr.find_launch(&launched).unwrap();

        assert_eq!(
            found,
            Some(LaunchReceipt {
                provider_run_ref: "w27:p3".to_owned()
            })
        );
        assert_eq!(other, None);
        assert_eq!(
            args(&runner)[..2],
            [
                ["tab", "list", "--workspace", "w27"],
                ["pane", "list", "--workspace", "w27"],
            ]
            .map(|args| args.map(str::to_owned).to_vec())
        );
    }

    #[test]
    fn a_run_on_an_ssh_host_launches_on_its_saved_herdr_machine() {
        let machines = r#"[{"id":"m1","label":"devbox","target":"devbox","session":"default",
            "enabled":true}]"#;
        let (herdr, runner) = herdr(vec![
            Ok(machines.to_owned()),
            Ok(TAB_CREATED.to_owned()),
            Ok(machines.to_owned()),
            Ok(String::new()),
        ]);

        herdr
            .launch(&spec(HostRef::Ssh("devbox".to_owned()), Some("w27")))
            .unwrap();

        let args = args(&runner);
        assert_eq!(args[1][..4], ["--machine", "m1", "tab", "create"]);
        assert_eq!(args[3][..4], ["--machine", "m1", "pane", "run"]);
    }

    #[test]
    fn a_run_without_a_herdr_workspace_or_command_is_not_launched() {
        let (herdr, runner) = herdr(Vec::new());

        assert_eq!(
            herdr.find_launch(&spec(HostRef::Local, None)).unwrap(),
            None
        );
        let error = herdr.launch(&spec(HostRef::Local, None)).unwrap_err();
        assert!(error.0.contains("start the task"), "{error}");
        let without_command = LaunchSpec {
            command: RunCommand::NewTab(Vec::new()),
            ..spec(HostRef::Local, Some("w27"))
        };
        let error = herdr.launch(&without_command).unwrap_err();
        assert!(error.0.contains("argument vector"), "{error}");
        assert!(args(&runner).is_empty());
    }
}
