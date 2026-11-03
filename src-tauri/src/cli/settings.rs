//! Where the CLI finds things: the data directory and the files in it, the saved listen
//! address, the binaries it was installed with, and the URLs the server is reached at.

use std::fs;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};

use super::Var;
use crate::mcp;
use crate::server::{self, Config, DEFAULT_PORT};

/// The CLI's own settings in the data directory: `{"listen": "HOST:PORT"}`.
const SETTINGS_FILE: &str = "cli.json";
const PID_FILE: &str = "server.pid";
const LOG_FILE: &str = "server.log";
/// Where `toodo init` records its data directory, relative to the config home.
const RECORD_FILE: &str = "toodo/data-dir";

/// The data directory of one server, and the files the CLI and the server keep in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DataDir(pub PathBuf);

impl DataDir {
    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn database(&self) -> PathBuf {
        self.0.join(server::DATABASE_FILE)
    }

    pub fn mcp_token(&self) -> PathBuf {
        self.0.join(mcp::TOKEN_FILE)
    }

    pub fn web_token(&self) -> PathBuf {
        self.0.join(server::WEB_TOKEN_FILE)
    }

    pub fn settings(&self) -> PathBuf {
        self.0.join(SETTINGS_FILE)
    }

    pub fn pid(&self) -> PathBuf {
        self.0.join(PID_FILE)
    }

    pub fn log(&self) -> PathBuf {
        self.0.join(LOG_FILE)
    }
}

/// How `toodo init` changes the listen address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ListenFlag {
    /// `--port N`: the saved host with port `N`.
    Port(u16),
    /// `--listen HOST:PORT`.
    Address(SocketAddr),
}

pub(super) fn default_listen() -> SocketAddr {
    SocketAddr::from((Ipv4Addr::LOCALHOST, DEFAULT_PORT))
}

/// The data directory: `--data-dir`, else `TOODO_DATA_DIR`, else the one `toodo init`
/// recorded in `$XDG_CONFIG_HOME/toodo/data-dir`, else the one the server picks itself
/// (`$XDG_DATA_HOME/toodo-server` or `~/.local/share/toodo-server`).
pub(super) fn data_dir(flag: Option<&Path>, var: Var) -> Result<DataDir, String> {
    let dir = match flag {
        Some(dir) => dir.to_path_buf(),
        None => match non_empty(var, "TOODO_DATA_DIR") {
            Some(dir) => PathBuf::from(dir),
            None => match recorded_data_dir(var)? {
                Some(dir) => dir,
                None => server_default(var)?,
            },
        },
    };
    std::path::absolute(&dir).map(DataDir).map_err(|error| {
        format!(
            "cannot resolve the data directory {}: {error}; pass an absolute --data-dir DIR",
            dir.display()
        )
    })
}

fn server_default(var: Var) -> Result<PathBuf, String> {
    let config = Config::from_env(|name| match name {
        "XDG_DATA_HOME" | "HOME" => non_empty(var, name),
        _ => None,
    })
    .map_err(|_| {
        "cannot tell where the data directory is because HOME is not set; \
         pass --data-dir DIR or set TOODO_DATA_DIR"
            .to_owned()
    })?;
    Ok(config.data_dir)
}

fn record_path(var: Var) -> Option<PathBuf> {
    config_home(var).ok().map(|dir| dir.join(RECORD_FILE))
}

/// The data directory `toodo init` recorded, if the record exists and is not empty.
fn recorded_data_dir(var: Var) -> Result<Option<PathBuf>, String> {
    let Some(path) = record_path(var) else {
        return Ok(None);
    };
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text.trim())
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "cannot read {}: {error}; fix its permissions, or delete it and pass --data-dir DIR",
            path.display()
        )),
    }
}

/// Records `data` as the data directory of the other commands, atomically.
pub(super) fn record_data_dir(data: &DataDir, var: Var) -> Result<(), String> {
    let path = record_path(var).ok_or_else(|| {
        "HOME is not set, so the data directory cannot be recorded; set HOME or XDG_CONFIG_HOME \
         and rerun toodo init"
            .to_owned()
    })?;
    let text = format!("{}\n", data.path().display());
    super::service::write_atomically(&path, text.as_bytes(), 0o644)
}

/// ` --data-dir DIR` for a command suggested to the user, or nothing when the command
/// finds `data` without it.
pub(super) fn data_dir_flag(data: &DataDir, var: Var) -> String {
    if data_dir(None, var).as_ref().ok() == Some(data) {
        return String::new();
    }
    let dir = data.path().display().to_string();
    let plain = dir
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-+=:@,~".contains(c));
    if plain {
        format!(" --data-dir {dir}")
    } else {
        format!(" --data-dir '{}'", dir.replace('\'', "'\\''"))
    }
}

/// The listen address saved by `toodo init`, if there is one.
pub(super) fn saved_listen(data: &DataDir) -> Result<Option<SocketAddr>, String> {
    let path = data.settings();
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "cannot read {}: {error}; fix its permissions, or delete it and run toodo init",
                path.display()
            ));
        }
    };
    let invalid = || {
        format!(
            "{} is not {{\"listen\": \"HOST:PORT\"}}; delete it and run toodo init \
             (with --listen HOST:PORT to choose the address)",
            path.display()
        )
    };
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| invalid())?;
    match value.get("listen") {
        None => Ok(None),
        Some(listen) => listen
            .as_str()
            .and_then(|listen| listen.parse().ok())
            .map(Some)
            .ok_or_else(invalid),
    }
}

/// The address the server listens on: the saved one, else the default.
pub(super) fn listen(data: &DataDir) -> Result<SocketAddr, String> {
    Ok(saved_listen(data)?.unwrap_or_else(default_listen))
}

pub(super) fn save_listen(data: &DataDir, listen: SocketAddr) -> Result<(), String> {
    let path = data.settings();
    let text = serde_json::json!({ "listen": listen.to_string() }).to_string() + "\n";
    fs::write(&path, text).map_err(|error| {
        format!(
            "cannot write {}: {error}; check the permissions of {} or pass another --data-dir",
            path.display(),
            data.path().display()
        )
    })
}

/// The listen address after `toodo init` with `flag`, given the saved one.
pub(super) fn resolve_listen(flag: Option<ListenFlag>, saved: Option<SocketAddr>) -> SocketAddr {
    match flag {
        Some(ListenFlag::Address(address)) => address,
        Some(ListenFlag::Port(port)) => {
            SocketAddr::new(saved.unwrap_or_else(default_listen).ip(), port)
        }
        None => saved.unwrap_or_else(default_listen),
    }
}

/// The address a client on this machine connects to: loopback for a wildcard address.
pub(super) fn local_address(listen: SocketAddr) -> SocketAddr {
    if listen.ip().is_unspecified() {
        SocketAddr::from((Ipv4Addr::LOCALHOST, listen.port()))
    } else {
        listen
    }
}

pub(super) fn web_url(listen: SocketAddr) -> String {
    format!("http://{}/", local_address(listen))
}

pub(super) fn mcp_url(listen: SocketAddr) -> String {
    format!("http://{}/mcp", local_address(listen))
}

pub(super) fn home(var: Var) -> Result<PathBuf, String> {
    non_empty(var, "HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set; set HOME to your home directory and rerun".to_owned())
}

/// `$XDG_DATA_HOME`, else `~/.local/share`.
pub(super) fn data_home(var: Var) -> Result<PathBuf, String> {
    match non_empty(var, "XDG_DATA_HOME") {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => Ok(home(var)?.join(".local/share")),
    }
}

/// `$XDG_CONFIG_HOME`, else `~/.config`.
pub(super) fn config_home(var: Var) -> Result<PathBuf, String> {
    match non_empty(var, "XDG_CONFIG_HOME") {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => Ok(home(var)?.join(".config")),
    }
}

fn non_empty(var: Var, name: &str) -> Option<String> {
    var(name).filter(|value| !value.is_empty())
}

/// What the CLI was installed with: `toodo-server` beside it and, when the package
/// carries one, the web app in `../web`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Bundle {
    pub server: PathBuf,
    pub web: Option<PathBuf>,
}

impl Bundle {
    pub fn find() -> Result<Self, String> {
        let exe = std::env::current_exe().map_err(|error| {
            format!(
                "cannot tell where toodo is installed: {error}; reinstall it with: \
                 npm install -g @dubusoft/toodo"
            )
        })?;
        Self::beside(&exe)
    }

    pub fn beside(exe: &Path) -> Result<Self, String> {
        let dir = exe.parent().unwrap_or(Path::new("/"));
        let server = dir.join("toodo-server");
        if !server.is_file() {
            return Err(format!(
                "toodo-server is missing next to {}; reinstall the CLI with: \
                 npm install -g @dubusoft/toodo",
                exe.display()
            ));
        }
        let web = dir
            .parent()
            .map(|parent| parent.join("web"))
            .filter(|web| web.join("index.html").is_file());
        Ok(Self { server, web })
    }

    /// Where the web app would be: for the message that it was not found.
    pub fn web_location(&self) -> PathBuf {
        let dir = self.server.parent().unwrap_or(Path::new("/"));
        dir.parent().unwrap_or(dir).join("web")
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::net::Ipv6Addr;

    use super::*;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn the_data_dir_flag_wins_over_the_environment() {
        let var = env(&[("TOODO_DATA_DIR", "/env/data"), ("HOME", "/home/a")]);
        let data = data_dir(Some(Path::new("/flag/data")), &var).unwrap();
        assert_eq!(data.path(), Path::new("/flag/data"));
    }

    #[test]
    fn the_data_dir_falls_back_like_the_server() {
        let var = env(&[("TOODO_DATA_DIR", "/env/data"), ("HOME", "/home/a")]);
        assert_eq!(data_dir(None, &var).unwrap().path(), Path::new("/env/data"));
        let var = env(&[("XDG_DATA_HOME", "/xdg"), ("HOME", "/home/a")]);
        assert_eq!(
            data_dir(None, &var).unwrap().path(),
            Path::new("/xdg/toodo-server")
        );
        let var = env(&[("HOME", "/home/a"), ("TOODO_LISTEN", "not an address")]);
        assert_eq!(
            data_dir(None, &var).unwrap().path(),
            Path::new("/home/a/.local/share/toodo-server")
        );
        let error = data_dir(None, &env(&[])).unwrap_err();
        assert!(error.contains("--data-dir"), "{error}");
    }

    fn with_record(config: &Path, text: Option<&str>) {
        if let Some(text) = text {
            fs::create_dir_all(config.join("toodo")).unwrap();
            fs::write(config.join(RECORD_FILE), text).unwrap();
        }
    }

    #[test]
    fn the_recorded_data_dir_sits_between_the_environment_and_the_default() {
        let config = tempfile::tempdir().unwrap();
        let cfg = config.path().to_str().unwrap();
        let pairs = [("XDG_CONFIG_HOME", cfg), ("HOME", "/home/a")];
        let default = Path::new("/home/a/.local/share/toodo-server");
        // No record file, then an empty one: the server default.
        assert_eq!(data_dir(None, &env(&pairs)).unwrap().path(), default);
        with_record(config.path(), Some("\n"));
        assert_eq!(data_dir(None, &env(&pairs)).unwrap().path(), default);
        // A record beats the default.
        with_record(config.path(), Some("/rec/data\n"));
        assert_eq!(
            data_dir(None, &env(&pairs)).unwrap().path(),
            Path::new("/rec/data")
        );
        // TOODO_DATA_DIR beats the record, the flag beats both.
        let with_env = [pairs[0], pairs[1], ("TOODO_DATA_DIR", "/env/data")];
        assert_eq!(
            data_dir(None, &env(&with_env)).unwrap().path(),
            Path::new("/env/data")
        );
        assert_eq!(
            data_dir(Some(Path::new("/flag/data")), &env(&with_env))
                .unwrap()
                .path(),
            Path::new("/flag/data")
        );
    }

    #[test]
    fn the_recorded_data_dir_round_trips() {
        let config = tempfile::tempdir().unwrap();
        let cfg = config.path().join("nested/cfg");
        let var = env(&[
            ("XDG_CONFIG_HOME", cfg.to_str().unwrap()),
            ("HOME", "/home/a"),
        ]);
        let data = DataDir(PathBuf::from("/rec/data"));
        record_data_dir(&data, &var).unwrap();
        assert_eq!(
            fs::read_to_string(cfg.join("toodo/data-dir")).unwrap(),
            "/rec/data\n"
        );
        assert_eq!(data_dir(None, &var).unwrap(), data);
        let names: Vec<_> = fs::read_dir(cfg.join("toodo"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["data-dir"]);
    }

    #[test]
    fn hints_name_the_data_dir_only_when_it_is_needed() {
        let config = tempfile::tempdir().unwrap();
        let cfg = config.path().to_str().unwrap();
        let var = env(&[("XDG_CONFIG_HOME", cfg), ("HOME", "/home/a")]);
        let default = DataDir(PathBuf::from("/home/a/.local/share/toodo-server"));
        let other = DataDir(PathBuf::from("/d/other"));
        assert_eq!(data_dir_flag(&default, &var), "");
        assert_eq!(data_dir_flag(&other, &var), " --data-dir /d/other");
        record_data_dir(&other, &var).unwrap();
        assert_eq!(data_dir_flag(&other, &var), "");
        assert_eq!(
            data_dir_flag(&default, &var),
            " --data-dir /home/a/.local/share/toodo-server"
        );
        let spaced = DataDir(PathBuf::from("/d/a b"));
        assert_eq!(data_dir_flag(&spaced, &var), " --data-dir '/d/a b'");
    }

    #[test]
    fn a_relative_data_dir_is_made_absolute() {
        let data = data_dir(Some(Path::new("relative/data")), &env(&[])).unwrap();
        assert!(data.path().is_absolute());
        assert!(data.path().ends_with("relative/data"));
    }

    #[test]
    fn the_listen_address_round_trips_through_cli_json() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir(dir.path().to_path_buf());
        assert_eq!(saved_listen(&data).unwrap(), None);
        assert_eq!(listen(&data).unwrap(), default_listen());
        let address: SocketAddr = "0.0.0.0:47990".parse().unwrap();
        save_listen(&data, address).unwrap();
        assert_eq!(saved_listen(&data).unwrap(), Some(address));
        let text = fs::read_to_string(data.settings()).unwrap();
        assert_eq!(text, "{\"listen\":\"0.0.0.0:47990\"}\n");
    }

    #[test]
    fn a_broken_cli_json_names_the_fix() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir(dir.path().to_path_buf());
        fs::write(data.settings(), "{\"listen\": 5}").unwrap();
        let error = saved_listen(&data).unwrap_err();
        assert!(error.contains("toodo init"), "{error}");
    }

    #[test]
    fn listen_flags_override_the_saved_address() {
        let saved: SocketAddr = "0.0.0.0:47000".parse().unwrap();
        assert_eq!(resolve_listen(None, None), default_listen());
        assert_eq!(resolve_listen(None, Some(saved)), saved);
        assert_eq!(
            resolve_listen(Some(ListenFlag::Port(47990)), Some(saved)),
            "0.0.0.0:47990".parse().unwrap()
        );
        assert_eq!(
            resolve_listen(Some(ListenFlag::Port(47990)), None),
            "127.0.0.1:47990".parse().unwrap()
        );
        let address: SocketAddr = "192.168.1.2:80".parse().unwrap();
        assert_eq!(
            resolve_listen(Some(ListenFlag::Address(address)), Some(saved)),
            address
        );
    }

    #[test]
    fn urls_use_loopback_for_a_wildcard_listen_address() {
        assert_eq!(
            mcp_url("0.0.0.0:47616".parse().unwrap()),
            "http://127.0.0.1:47616/mcp"
        );
        assert_eq!(
            mcp_url(SocketAddr::from((Ipv6Addr::UNSPECIFIED, 47616))),
            "http://127.0.0.1:47616/mcp"
        );
        assert_eq!(
            web_url("192.168.1.2:8080".parse().unwrap()),
            "http://192.168.1.2:8080/"
        );
        assert_eq!(
            web_url(SocketAddr::from((Ipv6Addr::LOCALHOST, 1))),
            "http://[::1]:1/"
        );
    }

    #[test]
    fn xdg_directories_fall_back_to_home() {
        let var = env(&[("HOME", "/home/a"), ("XDG_CONFIG_HOME", "")]);
        assert_eq!(config_home(&var).unwrap(), Path::new("/home/a/.config"));
        assert_eq!(data_home(&var).unwrap(), Path::new("/home/a/.local/share"));
        let var = env(&[("HOME", "/home/a"), ("XDG_CONFIG_HOME", "/cfg")]);
        assert_eq!(config_home(&var).unwrap(), Path::new("/cfg"));
    }

    #[test]
    fn the_bundle_is_found_beside_the_cli() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        fs::create_dir(&bin).unwrap();
        let exe = bin.join("toodo");
        assert!(Bundle::beside(&exe).unwrap_err().contains("npm install"));
        fs::write(bin.join("toodo-server"), "").unwrap();
        let bundle = Bundle::beside(&exe).unwrap();
        assert_eq!(bundle.server, bin.join("toodo-server"));
        assert_eq!(bundle.web, None);
        assert_eq!(bundle.web_location(), dir.path().join("web"));
        fs::create_dir(dir.path().join("web")).unwrap();
        fs::write(dir.path().join("web/index.html"), "").unwrap();
        assert_eq!(
            Bundle::beside(&exe).unwrap().web,
            Some(dir.path().join("web"))
        );
    }
}
