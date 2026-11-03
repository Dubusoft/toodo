//! Requests to a herdr server's socket API for a pane view: reading a pane's screen and
//! sending it input. herdr answers one request per connection and closes it, so every
//! request opens its own connection through a [`Connector`] (the local socket, or
//! `ssh -W` sharing one SSH connection, see [`SshSocket::multiplexed`]).
//!
//! [`SshSocket::multiplexed`]: super::herdr_events::SshSocket::multiplexed

use std::fmt;
use std::io::{self, BufRead, BufReader, Write};

use serde_json::{Value, json};

use super::herdr_events::Connector;

/// herdr's error code for a pane that does not exist (any more).
pub const PANE_NOT_FOUND: &str = "pane_not_found";

#[derive(Debug)]
pub enum PaneError {
    /// The connection to herdr failed or broke.
    Io(io::Error),
    /// herdr answered with an error, e.g. [`PANE_NOT_FOUND`].
    Api { code: String, message: String },
    /// herdr answered something this version of Toodo does not understand.
    Unexpected(String),
}

impl PaneError {
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Api { code, .. } => Some(code),
            _ => None,
        }
    }
}

impl fmt::Display for PaneError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "cannot reach herdr: {error}"),
            Self::Api { code, message } => write!(f, "herdr: {message} ({code})"),
            Self::Unexpected(output) => write!(f, "unexpected herdr response: {output}"),
        }
    }
}

impl std::error::Error for PaneError {}

impl From<io::Error> for PaneError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// What a pane shows: its visible screen as text with ANSI styles, rows separated by
/// `\r\n`, and the size of the pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Screen {
    pub ansi: String,
    pub cols: u16,
    pub rows: u16,
}

/// The visible screen of `pane` with its ANSI styles.
pub fn read_screen(connector: &dyn Connector, pane: &str) -> Result<String, PaneError> {
    let result = request(
        connector,
        "pane.read",
        json!({ "pane_id": pane, "source": "visible", "format": "ansi", "strip_ansi": false }),
    )?;
    result
        .pointer("/read/text")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| PaneError::Unexpected(result.to_string()))
}

/// The size of `pane` in its tab's layout, in columns and rows.
pub fn pane_size(connector: &dyn Connector, pane: &str) -> Result<(u16, u16), PaneError> {
    let result = request(connector, "pane.layout", json!({ "pane_id": pane }))?;
    let size = result
        .pointer("/layout/panes")
        .and_then(Value::as_array)
        .and_then(|panes| {
            panes
                .iter()
                .find(|entry| entry.get("pane_id").and_then(Value::as_str) == Some(pane))
        })
        .and_then(|entry| {
            let dimension = |key: &str| {
                let value = entry.pointer(&format!("/rect/{key}"))?.as_u64()?;
                u16::try_from(value).ok()
            };
            Some((dimension("width")?, dimension("height")?))
        });
    size.ok_or_else(|| PaneError::Unexpected(result.to_string()))
}

/// The screen of `pane` together with its size.
pub fn read_pane(connector: &dyn Connector, pane: &str) -> Result<Screen, PaneError> {
    let ansi = read_screen(connector, pane)?;
    let (cols, rows) = pane_size(connector, pane)?;
    Ok(Screen { ansi, cols, rows })
}

/// Types `text` into `pane` as if it was pasted into the terminal.
pub fn send_text(connector: &dyn Connector, pane: &str, text: &str) -> Result<(), PaneError> {
    request(
        connector,
        "pane.send_text",
        json!({ "pane_id": pane, "text": text }),
    )
    .map(drop)
}

/// Presses `keys` (herdr key names such as `enter`, `esc`, or `ctrl+c`) in `pane`.
pub fn send_keys(connector: &dyn Connector, pane: &str, keys: &[String]) -> Result<(), PaneError> {
    request(
        connector,
        "pane.send_keys",
        json!({ "pane_id": pane, "keys": keys }),
    )
    .map(drop)
}

/// Sends one request on a new connection and returns the `result` of the response.
fn request(connector: &dyn Connector, method: &str, params: Value) -> Result<Value, PaneError> {
    let mut connection = connector.connect()?;
    let request = json!({ "id": "toodo:pane", "method": method, "params": params });
    connection.write_all(format!("{request}\n").as_bytes())?;
    connection.flush()?;
    let mut line = String::new();
    BufReader::new(connection).read_line(&mut line)?;
    let line = line.trim();
    if line.is_empty() {
        return Err(PaneError::Io(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "herdr closed the connection without an answer",
        )));
    }
    let mut response: Value =
        serde_json::from_str(line).map_err(|_| PaneError::Unexpected(line.to_owned()))?;
    if let Some(error) = response.get("error") {
        let text = |key: &str| {
            error
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        return Err(PaneError::Api {
            code: text("code"),
            message: text("message"),
        });
    }
    response
        .get_mut("result")
        .map(Value::take)
        .ok_or_else(|| PaneError::Unexpected(line.to_owned()))
}

#[cfg(test)]
pub mod fake {
    //! A herdr server with panes that answer pane requests like herdr does, one request
    //! per connection.

    use std::collections::BTreeMap;
    use std::io::{self, Cursor, Read, Write};
    use std::sync::{Arc, Mutex};

    use serde_json::{Value, json};

    use crate::adapters::herdr_events::{Connection, Connector};

    #[derive(Debug, Default)]
    pub struct FakePane {
        pub screen: String,
        /// Text and keys sent to the pane, in order; keys as `<key>`.
        pub input: Vec<String>,
    }

    #[derive(Debug, Default, Clone)]
    pub struct FakeHerdr {
        pub panes: Arc<Mutex<BTreeMap<String, FakePane>>>,
        /// Every request method, in order.
        pub methods: Arc<Mutex<Vec<String>>>,
    }

    impl FakeHerdr {
        pub fn with_pane(pane: &str, screen: &str) -> Self {
            let herdr = Self::default();
            herdr.set_screen(pane, screen);
            herdr
        }

        pub fn set_screen(&self, pane: &str, screen: &str) {
            self.panes
                .lock()
                .unwrap()
                .entry(pane.to_owned())
                .or_default()
                .screen = screen.to_owned();
        }

        pub fn close(&self, pane: &str) {
            self.panes.lock().unwrap().remove(pane);
        }

        pub fn input(&self, pane: &str) -> Vec<String> {
            self.panes
                .lock()
                .unwrap()
                .get(pane)
                .map(|pane| pane.input.clone())
                .unwrap_or_default()
        }

        fn answer(&self, request: &str) -> String {
            let request: Value = serde_json::from_str(request.trim()).unwrap();
            let method = request["method"].as_str().unwrap().to_owned();
            let params = &request["params"];
            let pane_id = params["pane_id"].as_str().unwrap().to_owned();
            self.methods.lock().unwrap().push(method.clone());
            let mut panes = self.panes.lock().unwrap();
            let Some(pane) = panes.get_mut(&pane_id) else {
                let error = json!({ "code": "pane_not_found", "message": format!("pane {pane_id} not found") });
                return json!({ "id": request["id"], "error": error }).to_string();
            };
            let result = match method.as_str() {
                "pane.read" => json!({ "type": "pane_read", "read": {
                    "pane_id": pane_id, "source": "visible", "format": "ansi",
                    "text": pane.screen, "revision": 0, "truncated": false
                }}),
                "pane.layout" => json!({ "type": "pane_layout", "layout": {
                    "panes": [{ "pane_id": pane_id, "focused": true,
                                "rect": { "x": 0, "y": 0, "width": 80, "height": 24 } }]
                }}),
                "pane.send_text" => {
                    pane.input.push(params["text"].as_str().unwrap().to_owned());
                    json!({ "type": "ok" })
                }
                "pane.send_keys" => {
                    for key in params["keys"].as_array().unwrap() {
                        pane.input.push(format!("<{}>", key.as_str().unwrap()));
                    }
                    json!({ "type": "ok" })
                }
                other => panic!("unexpected herdr method {other}"),
            };
            json!({ "id": request["id"], "result": result }).to_string() + "\n"
        }
    }

    struct FakeConnection {
        herdr: FakeHerdr,
        request: Vec<u8>,
        output: Option<Cursor<Vec<u8>>>,
    }

    impl Read for FakeConnection {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            match &mut self.output {
                Some(output) => output.read(buf),
                None => Ok(0),
            }
        }
    }

    impl Write for FakeConnection {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.request.extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            let request = String::from_utf8(std::mem::take(&mut self.request)).unwrap();
            self.output = Some(Cursor::new(self.herdr.answer(&request).into_bytes()));
            Ok(())
        }
    }

    impl Connector for FakeHerdr {
        fn connect(&self) -> io::Result<Box<dyn Connection>> {
            Ok(Box::new(FakeConnection {
                herdr: self.clone(),
                request: Vec::new(),
                output: None,
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeHerdr;
    use super::*;
    use crate::adapters::herdr_events::fake::FakeConnector;

    // Captured from herdr 0.9.5 (text shortened).
    const READ: &str = r#"{"id":"toodo:pane","result":{"type":"pane_read","read":{"pane_id":"wAW:p1","workspace_id":"wAW","tab_id":"wAW:t1","source":"visible","format":"ansi","text":"\u001b[0m\u001b[1m$\u001b[0m ls\r\n","revision":0,"truncated":false}}}"#;
    const LAYOUT: &str = r#"{"id":"toodo:pane","result":{"type":"pane_layout","layout":{"workspace_id":"wAW","tab_id":"wAW:t1","zoomed":false,"area":{"x":0,"y":0,"width":172,"height":55},"focused_pane_id":"wAW:p1","panes":[{"pane_id":"wAW:p1","focused":true,"rect":{"x":0,"y":0,"width":172,"height":55}}],"splits":[]}}}"#;
    const NOT_FOUND: &str = r#"{"id":"toodo:pane","error":{"code":"pane_not_found","message":"pane wAW:p9 not found"}}"#;

    #[test]
    fn screens_are_read_with_their_size_one_request_per_connection() {
        let connector = FakeConnector::new([Ok(format!("{READ}\n")), Ok(format!("{LAYOUT}\n"))]);
        let screen = read_pane(&connector, "wAW:p1").unwrap();
        assert_eq!(
            screen,
            Screen {
                ansi: "\u{1b}[0m\u{1b}[1m$\u{1b}[0m ls\r\n".to_owned(),
                cols: 172,
                rows: 55,
            }
        );
        let requests = connector.requests.lock().unwrap();
        let requests: Vec<Value> = requests
            .iter()
            .map(|request| serde_json::from_str(request).unwrap())
            .collect();
        assert_eq!(requests[0]["method"], "pane.read");
        assert_eq!(
            requests[0]["params"],
            json!({ "pane_id": "wAW:p1", "source": "visible", "format": "ansi", "strip_ansi": false })
        );
        assert_eq!(requests[1]["method"], "pane.layout");
    }

    #[test]
    fn api_errors_carry_their_code() {
        let connector = FakeConnector::new([Ok(format!("{NOT_FOUND}\n"))]);
        let error = read_screen(&connector, "wAW:p9").unwrap_err();
        assert_eq!(error.code(), Some(PANE_NOT_FOUND));
    }

    #[test]
    fn closed_and_malformed_answers_are_errors() {
        let connector = FakeConnector::new([Ok(String::new()), Ok("not json\n".to_owned())]);
        assert!(matches!(
            read_screen(&connector, "wAW:p1"),
            Err(PaneError::Io(_))
        ));
        assert!(matches!(
            read_screen(&connector, "wAW:p1"),
            Err(PaneError::Unexpected(_))
        ));
    }

    #[test]
    fn input_is_sent_as_text_and_keys() {
        let herdr = FakeHerdr::with_pane("wAW:p1", "");
        send_text(&herdr, "wAW:p1", "yes\r").unwrap();
        send_keys(&herdr, "wAW:p1", &["esc".to_owned(), "ctrl+c".to_owned()]).unwrap();
        assert_eq!(herdr.input("wAW:p1"), ["yes\r", "<esc>", "<ctrl+c>"]);
        assert_eq!(
            send_text(&herdr, "wAW:p2", "x").unwrap_err().code(),
            Some(PANE_NOT_FOUND)
        );
    }
}
