//! `toodo review`: prints the review report of a period, rendered by the running server
//! through its `review_report` command, as the web app exports it.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};

use super::Var;
use super::settings::{self, DataDir};

const REPORT_PATH: &str = "/api/rpc/review_report";

/// The largest response read, far above any report of a year.
const MAX_RESPONSE: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ReviewArgs {
    pub period: String,
    pub date: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub format: String,
    pub time_zone: Option<String>,
    pub workspace: Option<i64>,
    pub label: Option<String>,
    pub data_dir: Option<PathBuf>,
}

pub(super) const USAGE: &str = "toodo review [--period week|month|quarter|year|custom] [--date DAY]
       [--from DAY] [--to DAY] [--format markdown|csv] [--workspace ID] [--label LABEL]
       [--time-zone ZONE] [--data-dir DIR]";

pub(super) const ABOUT: &str =
    "Prints the review of a period, rendered by the running server as the web app's
Review exports it: Markdown by default, or CSV. Days are YYYY-MM-DD; redirect the
output to save it, e.g. toodo review --period year --format csv > review.csv.";

pub(super) const OPTIONS: &str =
    "  --period KIND       week (default; from its Monday, or from --from), month, quarter,
                      year, or custom (--from to --to, both included)
  --date DAY          a day inside the period (default today)
  --from DAY          the first day: of a custom period, or any first day of a week
  --to DAY            the last day of a custom period
  --format FORMAT     markdown (default) or csv
  --workspace ID      only tasks of this workspace
  --label LABEL       only tasks with this label
  --time-zone ZONE    IANA time zone of the days and times, e.g. Europe/Berlin
                      (default the server's review time zone)";

/// Parses the options after `review`.
pub(super) fn parse(options: &[String]) -> Result<ReviewArgs, String> {
    let mut args = ReviewArgs {
        period: "week".to_owned(),
        date: None,
        from: None,
        to: None,
        format: "markdown".to_owned(),
        time_zone: None,
        workspace: None,
        label: None,
        data_dir: None,
    };
    let mut options = options.iter();
    while let Some(option) = options.next() {
        let (name, inline) = match option.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value.to_owned())),
            _ => (option.as_str(), None),
        };
        let value = match inline.or_else(|| options.next().cloned()) {
            Some(value) if !value.is_empty() => value,
            _ if name.starts_with("--") => return Err(format!("{name} needs a value")),
            _ => return Err(format!("unknown option {option:?}")),
        };
        match name {
            "--period" => {
                if !["week", "month", "quarter", "year", "custom"].contains(&value.as_str()) {
                    return Err(format!(
                        "--period takes week, month, quarter, year, or custom, got {value:?}"
                    ));
                }
                args.period = value;
            }
            "--format" => {
                if !["markdown", "csv"].contains(&value.as_str()) {
                    return Err(format!("--format takes markdown or csv, got {value:?}"));
                }
                args.format = value;
            }
            "--workspace" => match value.parse::<i64>() {
                Ok(id) if id > 0 => args.workspace = Some(id),
                _ => {
                    return Err(format!(
                        "--workspace takes a workspace ID, e.g. 1, got {value:?}"
                    ));
                }
            },
            "--date" => args.date = Some(value),
            "--from" => args.from = Some(value),
            "--to" => args.to = Some(value),
            "--time-zone" => args.time_zone = Some(value),
            "--label" => args.label = Some(value),
            "--data-dir" => args.data_dir = Some(PathBuf::from(value)),
            _ => return Err(format!("unknown option {option:?}")),
        }
    }
    Ok(args)
}

/// Asks the server of `data` for the report and writes it to stdout.
pub(super) fn review(args: &ReviewArgs, data: &DataDir, var: Var) -> Result<(), String> {
    let token_path = data.web_token();
    let flag = settings::data_dir_flag(data, var);
    let token = std::fs::read_to_string(&token_path).map_err(|error| {
        format!(
            "cannot read the web access token {}: {error}; set up the server with toodo \
             init{flag} first",
            token_path.display()
        )
    })?;
    let time_zone = args.time_zone.clone();
    let request = json!({
        "request": {
            "period": args.period,
            "date": args.date,
            "from": args.from,
            "to": args.to,
            "format": args.format,
            "timeZone": time_zone,
            "workspaceId": args.workspace,
            "label": args.label,
        }
    });
    let address = settings::local_address(settings::listen(data)?);
    let not_running = |error: std::io::Error| {
        format!("cannot reach toodo-server on {address}: {error}; start it with toodo start{flag}")
    };
    let mut stream =
        TcpStream::connect_timeout(&address, Duration::from_secs(5)).map_err(not_running)?;
    let timeout = Some(Duration::from_secs(120));
    drop(stream.set_read_timeout(timeout));
    drop(stream.set_write_timeout(timeout));
    let body = request.to_string();
    let head = format!(
        "POST {REPORT_PATH} HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        token.trim(),
        body.len()
    );
    stream
        .write_all(head.as_bytes())
        .and_then(|()| stream.write_all(body.as_bytes()))
        .map_err(not_running)?;
    let mut response = Vec::new();
    stream
        .take(MAX_RESPONSE)
        .read_to_end(&mut response)
        .map_err(not_running)?;
    let (status, reply) = parse_response(&response)
        .ok_or_else(|| format!("POST http://{address}{REPORT_PATH} got no valid HTTP response"))?;
    if status == 200
        && let Some(contents) = reply["contents"].as_str()
    {
        return std::io::stdout()
            .write_all(contents.as_bytes())
            .map_err(|error| format!("cannot write the report: {error}"));
    }
    if status == 401 {
        return Err(format!(
            "toodo-server on {address} rejected the web access token in {}; that server runs \
             with another data directory, so pass the --data-dir it uses, or check it with \
             toodo status{flag}",
            token_path.display()
        ));
    }
    match reply["message"].as_str() {
        Some(message) if status == 404 && reply["code"] == "unknown_command" => Err(format!(
            "the running toodo-server is too old to render reports ({message}); update it \
             with toodo update{flag}"
        )),
        Some(message) => Err(message.to_owned()),
        None => Err(format!(
            "POST http://{address}{REPORT_PATH} answered {status}; check the server log \
             shown by toodo status{flag}"
        )),
    }
}

/// The status code and JSON body of an HTTP/1.1 response, with a chunked body decoded.
pub(super) fn parse_response(response: &[u8]) -> Option<(u16, Value)> {
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&response[..split]).ok()?;
    let mut body = response[split + 4..].to_vec();
    let mut lines = head.split("\r\n");
    let mut status = lines.next()?.split(' ');
    status.next()?.starts_with("HTTP/").then_some(())?;
    let code = status.next()?.parse().ok()?;
    let chunked = lines.any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.trim().eq_ignore_ascii_case("transfer-encoding")
                && value.trim().eq_ignore_ascii_case("chunked")
        })
    });
    if chunked {
        body = dechunk(&body)?;
    }
    Some((code, serde_json::from_slice(&body).unwrap_or(Value::Null)))
}

fn dechunk(mut body: &[u8]) -> Option<Vec<u8>> {
    let mut decoded = Vec::new();
    loop {
        let line_end = body.windows(2).position(|window| window == b"\r\n")?;
        let size = std::str::from_utf8(&body[..line_end]).ok()?;
        let size = usize::from_str_radix(size.split(';').next()?.trim(), 16).ok()?;
        body = &body[line_end + 2..];
        if size == 0 {
            return Some(decoded);
        }
        decoded.extend_from_slice(body.get(..size)?);
        body = body.get(size + 2..)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(args: &[&str]) -> Result<ReviewArgs, String> {
        parse(&args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn takes_a_period_and_a_format_in_both_forms() {
        let args = parsed(&["--period", "year", "--date=2026-01-01", "--format", "csv"]).unwrap();
        assert_eq!(
            (
                args.period.as_str(),
                args.date.as_deref(),
                args.format.as_str()
            ),
            ("year", Some("2026-01-01"), "csv")
        );
        let args = parsed(&[]).unwrap();
        assert_eq!(
            (args.period.as_str(), args.format.as_str()),
            ("week", "markdown")
        );
        assert_eq!(parsed(&["--workspace", "3"]).unwrap().workspace, Some(3));
    }

    #[test]
    fn rejects_unknown_values_and_options() {
        assert!(
            parsed(&["--period", "day"])
                .unwrap_err()
                .contains("week, month")
        );
        assert!(
            parsed(&["--format", "pdf"])
                .unwrap_err()
                .contains("markdown or csv")
        );
        assert!(parsed(&["--workspace", "x"]).is_err());
        assert!(parsed(&["--date"]).unwrap_err().contains("needs a value"));
        assert!(
            parsed(&["--verbose", "x"])
                .unwrap_err()
                .contains("unknown option")
        );
    }

    #[test]
    fn reads_a_plain_and_a_chunked_json_response() {
        let plain = b"HTTP/1.1 200 OK\r\ncontent-length: 16\r\n\r\n{\"contents\":\"a\"}";
        assert_eq!(parse_response(plain), Some((200, json!({"contents": "a"}))));
        let chunked = b"HTTP/1.1 422 Unprocessable Entity\r\nTransfer-Encoding: chunked\r\n\r\n\
                        5\r\n{\"mes\r\nc\r\nsage\":\"bad\"}\r\n0\r\n\r\n";
        assert_eq!(
            parse_response(chunked),
            Some((422, json!({"message": "bad"})))
        );
        assert_eq!(parse_response(b"garbage"), None);
    }
}
