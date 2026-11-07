//! `toodo doctor`: the versions of the CLI and the running server, whether the server
//! runs and answers, and the files of its data directory.

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use super::settings::{self, DataDir};
use super::{Var, review, server_state, update};

/// Prints the report; the exit status is 0 without problems, else 1.
pub(super) fn doctor(data: &DataDir, var: Var) -> Result<i32, String> {
    let flag = settings::data_dir_flag(data, var);
    let listen = settings::listen(data)?;
    let manager = super::manager(data, var)?;
    let state = server_state(&manager, data, var)?;
    let mut problems = Vec::new();

    let cli = update::version();
    println!("Versions:");
    println!("  toodo   {cli}");
    if state.running {
        match server_version(data, listen) {
            Ok(server) => {
                println!("  server  {server}");
                if server != cli {
                    problems.push(format!(
                        "the server runs {server}, but the CLI is {cli}; run the new version \
                         with: toodo restart{flag}"
                    ));
                }
            }
            Err(cause) => println!("  server  unknown: {cause}"),
        }
    } else {
        println!("  server  unknown (not running)");
    }

    println!("\nServer:");
    println!(
        "  state     {} ({})",
        if state.running { "running" } else { "stopped" },
        state.description
    );
    if state.running {
        match update::healthy(listen) {
            Ok(()) => println!("  answers   yes, on {}", settings::web_url(listen)),
            Err(cause) => {
                println!("  answers   no: {cause}");
                problems.push(format!(
                    "the server runs but does not answer on {listen}; find the cause with: \
                     toodo logs{flag}, then run: toodo restart{flag}"
                ));
            }
        }
    } else {
        problems.push(format!(
            "the server is stopped; start it with: toodo start{flag}"
        ));
    }
    println!("  log       {} (show it with: toodo logs{flag})", state.log);
    println!("  data      {}", data.path().display());
    for (name, path) in [
        ("database", data.database()),
        ("web token", data.web_token()),
        ("MCP token", data.mcp_token()),
    ] {
        if path.is_file() {
            println!("  {name:<10}{}", path.display());
        } else {
            println!("  {name:<10}missing: {}", path.display());
            problems.push(format!(
                "the {name} {} is missing; create it with: toodo init{flag}",
                path.display()
            ));
        }
    }

    if problems.is_empty() {
        println!("\nNo problems found.");
        Ok(0)
    } else {
        println!("\nProblems:");
        for problem in &problems {
            println!("  - {problem}");
        }
        Ok(1)
    }
}

/// The version the running server reports through its `app_info` command.
fn server_version(data: &DataDir, listen: SocketAddr) -> Result<String, String> {
    let token = fs::read_to_string(data.web_token())
        .map_err(|error| format!("cannot read {}: {error}", data.web_token().display()))?;
    let address = settings::local_address(listen);
    let failed = |error: std::io::Error| format!("cannot ask {address}: {error}");
    let mut stream =
        TcpStream::connect_timeout(&address, Duration::from_secs(5)).map_err(failed)?;
    let timeout = Some(Duration::from_secs(10));
    drop(stream.set_read_timeout(timeout));
    drop(stream.set_write_timeout(timeout));
    let request = format!(
        "POST /api/rpc/app_info HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {}\r\n\
         Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}",
        token.trim()
    );
    stream.write_all(request.as_bytes()).map_err(failed)?;
    let mut response = Vec::new();
    stream
        .take(64 * 1024)
        .read_to_end(&mut response)
        .map_err(failed)?;
    match review::parse_response(&response) {
        Some((200, reply)) => reply["version"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "app_info named no version".to_owned()),
        Some((status, _)) => Err(format!(
            "app_info answered {status}; the server on {address} may use another data directory"
        )),
        None => Err(format!("app_info on {address} got no HTTP response")),
    }
}
