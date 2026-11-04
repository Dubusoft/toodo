//! `toodo uninstall`: stops the server of a data directory and removes what the CLI set up
//! for it: the systemd service or launchd agent with the server and web app copies it
//! runs, the MCP registrations with coding agents, and the record of the data directory.
//! The data directory itself goes only with `--delete-data`.

use std::fs;
use std::io;
use std::path::Path;

use super::settings::{self, DataDir};
use super::update::Package;
use super::{Manager, Var, agents, launchd, process, service};
use crate::commands::updates::PACKAGE;

pub(super) fn uninstall(data: &DataDir, delete_data: bool, var: Var) -> Result<(), String> {
    // A data directory --delete-data would refuse stops the uninstall before it changes anything.
    if delete_data {
        check_deletable(data, var)?;
    }
    let flag = settings::data_dir_flag(data, var);
    let listen = settings::listen(data)?;
    let manager = super::manager(data, var)?;
    super::stop(data, var)?;
    match manager {
        Manager::Service => {
            if let Err(error) = process::run(
                "systemctl",
                &["--user", "disable", service::UNIT_NAME],
                "it is removed anyway",
            ) {
                println!("note: {error}");
            }
            remove_file(&service::unit_path(var)?)?;
            process::run(
                "systemctl",
                &["--user", "daemon-reload"],
                "run it yourself: systemctl --user daemon-reload",
            )?;
            remove_copies(var)?;
        }
        Manager::Launchd => {
            remove_file(&launchd::plist_path(var)?)?;
            remove_copies(var)?;
        }
        Manager::PidFile => {}
    }
    agents::unregister(&settings::mcp_url(listen), var);
    if let Some(record) = settings::forget_data_dir(data, var)? {
        println!("Removed {}", record.display());
    }
    if delete_data {
        delete_data_dir(data, var)?;
        println!("Deleted the data directory {}", data.path().display());
    } else {
        println!(
            "Kept the data directory {} with the database, tokens, and backups; delete it \
             too with: toodo uninstall --delete-data{flag}",
            data.path().display()
        );
    }
    let exe = std::env::current_exe().ok();
    match exe.as_deref().and_then(Package::of) {
        Some(_) => println!("To remove the toodo command too, run: npm rm -g {PACKAGE}"),
        None => println!(
            "To remove the toodo command too, delete {} and the toodo-server beside it",
            exe.map_or_else(|| "toodo".to_owned(), |exe| exe.display().to_string())
        ),
    }
    Ok(())
}

/// Removes the copies of the server and the web app that the service ran, see
/// [`service::install_bundle`].
fn remove_copies(var: Var) -> Result<(), String> {
    remove_file(&settings::home(var)?.join(".local/bin/toodo-server"))?;
    let web = settings::data_home(var)?.join("toodo-server-web");
    match fs::remove_dir_all(&web) {
        Ok(()) => {
            println!("Removed {}", web.display());
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "cannot remove {}: {error}; delete it yourself and rerun toodo uninstall",
            web.display()
        )),
    }
}

fn remove_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => {
            println!("Removed {}", path.display());
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "cannot remove {}: {error}; delete it yourself and rerun toodo uninstall",
            path.display()
        )),
    }
}

/// Deletes the data directory, but only one that holds a Toodo database and is neither
/// the root nor the home directory, so a wrong `--data-dir` cannot delete other files.
fn delete_data_dir(data: &DataDir, var: Var) -> Result<(), String> {
    check_deletable(data, var)?;
    fs::remove_dir_all(data.path()).map_err(|error| {
        format!(
            "cannot delete {}: {error}; delete it yourself",
            data.path().display()
        )
    })
}

fn check_deletable(data: &DataDir, var: Var) -> Result<(), String> {
    let dir = data.path();
    let home = settings::home(var).ok();
    if dir.parent().is_none() || home.as_deref() == Some(dir) || !data.database().is_file() {
        return Err(format!(
            "{} holds no Toodo database ({}), so toodo uninstall does not delete it; pass the \
             --data-dir that toodo status shows, or delete the directory yourself",
            dir.display(),
            data.database().display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn only_a_data_directory_with_a_database_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().display().to_string();
        let var = |name: &str| (name == "HOME").then(|| home.clone());
        let data = DataDir(dir.path().join("data"));
        fs::create_dir_all(data.path()).unwrap();
        fs::write(data.path().join("notes.txt"), "keep").unwrap();
        assert!(
            delete_data_dir(&data, &var)
                .unwrap_err()
                .contains("holds no Toodo database")
        );
        assert!(data.path().join("notes.txt").exists());

        fs::write(data.database(), "").unwrap();
        delete_data_dir(&data, &var).unwrap();
        assert!(!data.path().exists());

        let home_data = DataDir(dir.path().to_path_buf());
        fs::write(home_data.database(), "").unwrap();
        assert!(delete_data_dir(&home_data, &var).is_err());
        assert!(delete_data_dir(&DataDir(PathBuf::from("/")), &var).is_err());
        assert!(home_data.database().exists());
    }
}
