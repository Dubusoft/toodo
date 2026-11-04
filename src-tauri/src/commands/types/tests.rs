use super::*;
use crate::commands::CommandErrorKind;
use crate::domain::model;

/// A local path as entered, its normalized form, and a path of the other kind: local
/// paths are POSIX paths on the server.
const LOCAL: (&str, &str, &str) = ("/home/me/toodo/", "/home/me/toodo", r"C:\dev\toodo");

#[test]
fn local_location_is_normalized() {
    let (entered, normalized, _) = LOCAL;
    let location = model::WorkspaceLocation::try_from(WorkspaceLocation::Local {
        path: entered.to_owned(),
    })
    .unwrap();
    assert_eq!(
        WorkspaceLocation::from(&location),
        WorkspaceLocation::Local {
            path: normalized.to_owned()
        }
    );
}

#[test]
fn location_paths_must_match_the_machine() {
    let cases = [
        WorkspaceLocation::Local {
            path: LOCAL.2.to_owned(),
        },
        WorkspaceLocation::Ssh {
            machine: "devbox".to_owned(),
            path: r"dev\toodo".to_owned(),
        },
        WorkspaceLocation::Ssh {
            machine: "devbox".to_owned(),
            path: "~/toodo".to_owned(),
        },
        WorkspaceLocation::Ssh {
            machine: " ".to_owned(),
            path: "/home/me/toodo".to_owned(),
        },
    ];
    for location in cases {
        let error = model::WorkspaceLocation::try_from(location).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    }
}

#[test]
fn ssh_locations_take_windows_paths_of_windows_hosts() {
    for (raw, normalized) in [
        (r" D:/dev/toodo/ ", r"D:\dev\toodo"),
        (r"\\nas\src\toodo", r"\\nas\src\toodo"),
        ("/home/me/toodo/", "/home/me/toodo"),
    ] {
        let location = model::WorkspaceLocation::try_from(WorkspaceLocation::Ssh {
            machine: "winpc".to_owned(),
            path: raw.to_owned(),
        })
        .unwrap();
        assert_eq!(
            WorkspaceLocation::from(&location),
            WorkspaceLocation::Ssh {
                machine: "winpc".to_owned(),
                path: normalized.to_owned(),
            }
        );
        assert_eq!(PathProblem::of(&location), None);
    }
    let settings = model::MachineSettings::try_from(MachineSettings {
        machine: Machine::Ssh {
            label: "winpc".to_owned(),
        },
        worktree_root: Some(r"D:\wt\".to_owned()),
    })
    .unwrap();
    assert_eq!(
        MachineSettings::from(&settings).worktree_root.as_deref(),
        Some(r"D:\wt")
    );
}

fn new_workspace(
    name: &str,
    repository: Option<RepositorySetup>,
    branch: Option<&str>,
) -> NewWorkspace {
    NewWorkspace {
        name: name.to_owned(),
        location: WorkspaceLocation::Local {
            path: LOCAL.1.to_owned(),
        },
        repository,
        source: None,
        completion: None,
        runner: None,
        default_base_branch: branch.map(str::to_owned),
    }
}

#[test]
fn new_workspace_requires_a_name_and_a_clone_url() {
    let new = |name: &str, repository: RepositorySetup, branch: Option<&str>| {
        new_workspace(name, Some(repository), branch)
    };
    let clone = |url: &str| RepositorySetup::Clone {
        url: url.to_owned(),
    };
    let parsed =
        WorkspaceSetup::try_from(new(" toodo ", clone(" git@h:a.git "), Some(" main "))).unwrap();
    assert_eq!(parsed.name, "toodo");
    assert_eq!(parsed.repository, Some(clone("git@h:a.git")));
    assert_eq!(parsed.source, None);
    assert_eq!(parsed.default_base_branch.as_deref(), Some("main"));
    let blank_branch =
        WorkspaceSetup::try_from(new("toodo", RepositorySetup::Open, Some(" "))).unwrap();
    assert_eq!(blank_branch.default_base_branch, None);
    for invalid in [
        new("  ", RepositorySetup::Open, None),
        new("toodo", clone(" "), None),
    ] {
        let error = WorkspaceSetup::try_from(invalid).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    }
}

#[test]
fn new_workspace_matches_its_repository_to_its_source() {
    let without_repository = WorkspaceSetup::try_from(new_workspace("notes", None, None)).unwrap();
    assert_eq!(without_repository.source, Some(model::Source::None));
    let with = |repository: Option<RepositorySetup>, source: Source| NewWorkspace {
        source: Some(source),
        ..new_workspace("toodo", repository, None)
    };
    let local =
        WorkspaceSetup::try_from(with(Some(RepositorySetup::Init), Source::LocalGit)).unwrap();
    assert_eq!(local.source, Some(model::Source::LocalGit));
    for (invalid, message) in [
        (
            with(Some(RepositorySetup::Open), Source::None),
            "source none has no repository; omit repository, or choose source local_git \
             or github to open, clone, or init one",
        ),
        (
            with(None, Source::GitHub),
            "source github needs a repository; set repository to open, clone, or init \
             one, or choose source none for a plain directory",
        ),
        (
            with(Some(RepositorySetup::Init), Source::GitHub),
            "a new repository has no origin remote for source github; choose source \
             local_git for a new repository, or clone the GitHub repository instead",
        ),
    ] {
        let error = WorkspaceSetup::try_from(invalid).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        assert_eq!(error.message, message);
    }
}

#[test]
fn machine_settings_parse_the_root_for_their_machine() {
    let settings = model::MachineSettings::try_from(MachineSettings {
        machine: Machine::Ssh {
            label: "devbox".to_owned(),
        },
        worktree_root: Some("/srv/worktrees/".to_owned()),
    })
    .unwrap();
    assert_eq!(
        MachineSettings::from(&settings),
        MachineSettings {
            machine: Machine::Ssh {
                label: "devbox".to_owned()
            },
            worktree_root: Some("/srv/worktrees".to_owned()),
        }
    );
    let error = model::MachineSettings::try_from(MachineSettings {
        machine: Machine::Local,
        worktree_root: Some(LOCAL.2.to_owned()),
    })
    .unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::InvalidInput);
}

#[test]
fn serialized_shapes_use_the_frontend_names() {
    let location = serde_json::to_value(WorkspaceLocation::Ssh {
        machine: "devbox".to_owned(),
        path: "/srv/toodo".to_owned(),
    })
    .unwrap();
    assert_eq!(
        location,
        serde_json::json!({ "kind": "ssh", "machine": "devbox", "path": "/srv/toodo" })
    );
    assert_eq!(
        serde_json::to_value(TaskStatus::InProgress).unwrap(),
        "in_progress"
    );
    let edit: TaskEdit = serde_json::from_value(serde_json::json!({
        "id": 7, "taskType": "refactor", "title": "Split storage", "description": ""
    }))
    .unwrap();
    assert_eq!(edit.id, TaskId(7));
    assert_eq!(edit.task_type, TaskType::Refactor);
    let new: NewWorkspace = serde_json::from_value(serde_json::json!({
        "name": "toodo",
        "location": { "kind": "local", "path": r"C:\dev\toodo" },
        "repository": { "kind": "clone", "url": "git@h:a.git" },
        "source": "github",
        "completion": "pr_merge",
        "runner": "herdr",
        "defaultBaseBranch": null
    }))
    .unwrap();
    assert_eq!(
        new.repository,
        Some(RepositorySetup::Clone {
            url: "git@h:a.git".to_owned()
        })
    );
    assert_eq!(
        (new.source, new.completion, new.runner),
        (
            Some(Source::GitHub),
            Some(CompletionMode::PullRequestMerge),
            Some(Runner::Herdr)
        )
    );
    assert_eq!(
        serde_json::to_value([Source::None, Source::LocalGit, Source::GitHub]).unwrap(),
        serde_json::json!(["none", "local_git", "github"])
    );
    assert_eq!(
        serde_json::to_value([
            CompletionMode::Manual,
            CompletionMode::LocalMerge,
            CompletionMode::PullRequestMerge
        ])
        .unwrap(),
        serde_json::json!(["manual", "local_merge", "pr_merge"])
    );
    assert_eq!(
        serde_json::to_value([Runner::None, Runner::Herdr, Runner::Plain, Runner::Tmux]).unwrap(),
        serde_json::json!(["none", "herdr", "plain", "tmux"])
    );
}
