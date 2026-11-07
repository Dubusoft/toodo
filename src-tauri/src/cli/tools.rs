//! What `toodo init` prints about the tools the server runs: the checks of the
//! `runner_health` command, each with its next step when the tool is not ready.

use crate::commands::types::{RunnerHealth, Tool};

/// One line per tool: its name, whether it is ready, and its version or where it was
/// found, else what to do next.
pub(super) fn report(health: &RunnerHealth) -> Vec<String> {
    let mut rows: Vec<(&str, bool, Option<String>)> = health
        .tools
        .iter()
        .map(|tool| {
            let name = match tool.tool {
                Tool::Git => "git",
                Tool::Gh => "gh",
                Tool::Ssh => "ssh",
            };
            (
                name,
                tool.ready,
                detail(tool.ready, &tool.version, &tool.message),
            )
        })
        .collect();
    let herdr = &health.herdr;
    rows.push((
        "herdr",
        herdr.running,
        detail(
            herdr.running,
            &herdr.version.as_ref().map(|version| format!("v{version}")),
            &herdr.message,
        ),
    ));
    let tmux = &health.tmux;
    rows.push((
        "tmux",
        tmux.installed,
        detail(tmux.installed, &tmux.version, &tmux.message),
    ));
    for agent in &health.agents {
        let name = crate::runtime::plain::adapter::AgentAdapter::from(agent.adapter).as_wire();
        rows.push((
            name,
            agent.installed,
            detail(agent.installed, &agent.path, &agent.message),
        ));
    }
    rows.into_iter()
        .map(|(name, ready, detail)| {
            let state = if ready { "ready" } else { "not ready" };
            match detail {
                Some(detail) => format!("  {name:<10}{state:<11}{detail}"),
                None => format!("  {name:<10}{state}"),
            }
        })
        .collect()
}

fn detail(ready: bool, found: &Option<String>, message: &Option<String>) -> Option<String> {
    if ready { found } else { message }.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::types::{AgentAdapter, AgentHealth, HerdrHealth, TmuxHealth, ToolHealth};

    #[test]
    fn each_tool_gets_a_line_with_its_version_or_next_step() {
        let health = RunnerHealth {
            herdr: HerdrHealth {
                installed: true,
                running: true,
                version: Some("0.9.5".to_owned()),
                message: None,
            },
            tmux: TmuxHealth {
                installed: false,
                version: None,
                message: Some("install tmux".to_owned()),
            },
            agents: vec![AgentHealth {
                adapter: AgentAdapter::Codex,
                installed: true,
                path: Some("/usr/bin/codex".to_owned()),
                message: None,
                capabilities: crate::runtime::plain::adapter::AgentAdapter::Codex
                    .capabilities()
                    .into(),
            }],
            tools: vec![
                ToolHealth {
                    tool: Tool::Git,
                    installed: true,
                    ready: true,
                    version: Some("git version 2.43.0".to_owned()),
                    message: None,
                },
                ToolHealth {
                    tool: Tool::Gh,
                    installed: true,
                    ready: false,
                    version: Some("gh version 2.83.0".to_owned()),
                    message: Some("run `gh auth login`".to_owned()),
                },
            ],
        };
        assert_eq!(
            report(&health),
            vec![
                "  git       ready      git version 2.43.0",
                "  gh        not ready  run `gh auth login`",
                "  herdr     ready      v0.9.5",
                "  tmux      not ready  install tmux",
                "  codex     ready      /usr/bin/codex",
            ]
        );
    }
}
