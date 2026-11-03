//! Web Push notifications for the devices of `toodo-server`, so a phone or desktop hears
//! about its tasks while Toodo is closed. Each device subscribes its browser with the
//! server's VAPID public key; the server watches the changes it announces to the frontend
//! (see [`alerts`]) and posts an encrypted message to every subscription that wants it.
//!
//! - `GET /api/push` returns `{ publicKey, subscription }`, the subscription being the
//!   asking device's (`{ endpoint, settings }` or `null`).
//! - `PUT /api/push/subscription` with the browser's `PushSubscription` JSON subscribes
//!   the asking device; `DELETE` unsubscribes it.
//! - `PUT /api/push/settings` with `{ agent, pullRequests, completion }` chooses which
//!   kinds of notification the device gets.
//! - `POST /api/push/test` sends a test notification to the asking device.
//!
//! Subscriptions belong to devices: a browser signed in with the shared web token gets 403.

pub mod alerts;
pub mod crypto;

use std::future::Future;
use std::io;
use std::path::Path;
use std::pin::Pin;
use std::sync::mpsc;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};

use self::alerts::{Alert, Watch};
use self::crypto::VapidKey;
use super::Services;
use super::devices::{Caller, blocking};
use super::rpc::{Reply, json};
use crate::commands::types::{TaskAgentStatus, TaskPullRequestStatus};
use crate::commands::{CommandError, StorageState, lock};
use crate::domain::device::DeviceId;
use crate::domain::push::{PushEndpoint, PushSettings, PushSubscription, subscription_keys};
use crate::storage::NewPushSubscription;

/// The file in the data directory that holds the VAPID key.
pub const KEY_FILE: &str = "push-key";

/// The contact push services see in every request, unless `TOODO_PUSH_SUBJECT` sets one.
pub const DEFAULT_SUBJECT: &str = "https://github.com/dev-bokdong/toodo";

/// How long a push service keeps a message for a device that is offline.
const TIME_TO_LIVE: Duration = Duration::from_secs(24 * 60 * 60);

/// How long a VAPID token is valid; push services accept at most 24 hours.
const TOKEN_LIFETIME: Duration = Duration::from_secs(12 * 60 * 60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushRequest {
    pub endpoint: String,
    pub authorization: String,
    pub urgency: &'static str,
    pub ttl: u64,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushResponse {
    pub status: u16,
    pub body: String,
}

/// Posts messages to push services; faked in tests.
pub trait Transport: Send + Sync {
    fn post(
        &self,
        request: PushRequest,
    ) -> Pin<Box<dyn Future<Output = Result<PushResponse, String>> + Send + '_>>;
}

pub struct Http(reqwest::Client);

impl Http {
    pub fn new() -> Result<Self, String> {
        // reqwest uses the process-wide rustls provider; another one may already be set.
        drop(rustls::crypto::ring::default_provider().install_default());
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map(Self)
            .map_err(|error| format!("cannot create the push client: {error}"))
    }
}

impl Transport for Http {
    fn post(
        &self,
        request: PushRequest,
    ) -> Pin<Box<dyn Future<Output = Result<PushResponse, String>> + Send + '_>> {
        Box::pin(async move {
            let response = self
                .0
                .post(&request.endpoint)
                .header("Authorization", request.authorization)
                .header("TTL", request.ttl.to_string())
                .header("Urgency", request.urgency)
                .header("Content-Encoding", "aes128gcm")
                .header("Content-Type", "application/octet-stream")
                .body(request.body)
                .send()
                .await
                .map_err(|error| error.to_string())?;
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            Ok(PushResponse { status, body })
        })
    }
}

/// Why a message did not reach a device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendError {
    /// The push service no longer knows the subscription (404 or 410); it is dropped.
    Gone,
    /// The push service refused the message.
    Refused(PushResponse),
    /// The message could not be built or posted.
    Failed(String),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Gone => write!(f, "the push service no longer knows this subscription"),
            Self::Refused(response) => write!(
                f,
                "the push service refused the notification ({}): {}",
                response.status,
                response.body.trim()
            ),
            Self::Failed(message) => message.fmt(f),
        }
    }
}

/// A change the worker turns into notifications.
#[derive(Debug)]
enum Change {
    Tasks,
    /// The tasks changed through the app; the baseline moves without notifications.
    TasksSeen,
    Agents(Vec<TaskAgentStatus>),
    PullRequests(Vec<TaskPullRequestStatus>),
}

pub struct Push {
    key: VapidKey,
    subject: String,
    transport: Box<dyn Transport>,
    changes: OnceLock<mpsc::Sender<Change>>,
}

impl Push {
    pub fn new(key: VapidKey, subject: String, transport: Box<dyn Transport>) -> Self {
        Self {
            key,
            subject,
            transport,
            changes: OnceLock::new(),
        }
    }

    /// Loads (or creates) the key in `data_dir` and posts over HTTP.
    pub fn load(data_dir: &Path, subject: String) -> io::Result<Self> {
        let key = VapidKey::load_or_create(&data_dir.join(KEY_FILE))?;
        let http = Http::new().map_err(io::Error::other)?;
        Ok(Self::new(key, subject, Box::new(http)))
    }

    pub fn public_key(&self) -> String {
        crypto::base64url(self.key.public_key())
    }

    fn changed(&self, change: Change) {
        if let Some(changes) = self.changes.get() {
            // The worker only stops with the process.
            drop(changes.send(change));
        }
    }

    pub fn tasks_changed(&self) {
        self.changed(Change::Tasks);
    }

    pub fn tasks_seen(&self) {
        self.changed(Change::TasksSeen);
    }

    pub fn agent_statuses_changed(&self, statuses: &[TaskAgentStatus]) {
        self.changed(Change::Agents(statuses.to_vec()));
    }

    pub fn pull_request_statuses_changed(&self, statuses: &[TaskPullRequestStatus]) {
        self.changed(Change::PullRequests(statuses.to_vec()));
    }

    /// Encrypts `alert` for `subscription` and posts it.
    pub async fn send(
        &self,
        subscription: &PushSubscription,
        alert: &Alert,
    ) -> Result<(), SendError> {
        let payload = serde_json::to_vec(alert)
            .map_err(|error| SendError::Failed(format!("cannot encode the message: {error}")))?;
        let body =
            crypto::encrypt(&subscription.p256dh, &subscription.auth, &payload).map_err(|_| {
                SendError::Failed("cannot encrypt for this subscription's key".to_owned())
            })?;
        let expires = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |now| now.as_secs())
            + TOKEN_LIFETIME.as_secs();
        let request = PushRequest {
            endpoint: subscription.endpoint.as_str().to_owned(),
            authorization: self.key.authorization(
                subscription.endpoint.origin(),
                &self.subject,
                i64::try_from(expires).unwrap_or(i64::MAX),
            ),
            urgency: if alert.urgent { "high" } else { "normal" },
            ttl: TIME_TO_LIVE.as_secs(),
            body,
        };
        let response = self
            .transport
            .post(request)
            .await
            .map_err(SendError::Failed)?;
        match response.status {
            200..=299 => Ok(()),
            404 | 410 => Err(SendError::Gone),
            _ => Err(SendError::Refused(response)),
        }
    }
}

/// Sends every alert to every subscription whose settings allow it, and drops the
/// subscriptions their push service reports gone. Returns how many messages were sent.
pub(crate) fn deliver(
    storage: &StorageState,
    push: &Push,
    runtime: &tokio::runtime::Runtime,
    alerts: &[Alert],
) -> usize {
    if alerts.is_empty() {
        return 0;
    }
    let subscriptions = match lock(storage).active_push_subscriptions() {
        Ok(subscriptions) => subscriptions,
        Err(error) => {
            eprintln!("toodo-server: cannot read push subscriptions: {error}");
            return 0;
        }
    };
    let mut sent = 0;
    let mut gone = Vec::new();
    for subscription in &subscriptions {
        for alert in alerts {
            if alert
                .kind
                .is_some_and(|kind| !subscription.settings.allows(kind))
            {
                continue;
            }
            match runtime.block_on(push.send(subscription, alert)) {
                Ok(()) => sent += 1,
                Err(SendError::Gone) => {
                    gone.push(subscription.endpoint.clone());
                    break;
                }
                Err(error) => eprintln!(
                    "toodo-server: push to device {} failed: {error}",
                    subscription.device
                ),
            }
        }
    }
    for endpoint in gone {
        if let Err(error) = lock(storage).delete_push_endpoint(&endpoint) {
            eprintln!("toodo-server: cannot drop a gone push subscription: {error}");
        }
    }
    sent
}

/// Starts the worker that turns announced changes into notifications.
pub fn spawn(services: Arc<Services>) -> io::Result<()> {
    let (sender, changes) = mpsc::channel();
    if services.push.changes.set(sender).is_err() {
        return Err(io::Error::other("the push worker is already running"));
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    std::thread::Builder::new()
        .name("push".to_owned())
        .spawn(move || {
            let mut watch = Watch::default();
            watch_tasks(&services, &mut watch);
            for change in changes {
                let alerts = match change {
                    Change::Tasks => watch_tasks(&services, &mut watch),
                    Change::TasksSeen => {
                        watch_tasks(&services, &mut watch);
                        Vec::new()
                    }
                    Change::Agents(statuses) => watch.agents(&statuses),
                    Change::PullRequests(statuses) => watch.pull_requests(&statuses),
                };
                deliver(&services.storage, &services.push, &runtime, &alerts);
            }
        })?;
    Ok(())
}

fn watch_tasks(services: &Services, watch: &mut Watch) -> Vec<Alert> {
    let tasks = match lock(&services.storage).list_all_tasks() {
        Ok(tasks) => tasks,
        Err(error) => {
            eprintln!("toodo-server: cannot read tasks for notifications: {error}");
            return Vec::new();
        }
    };
    watch.tasks(
        tasks
            .iter()
            .map(|task| (task.id, task.status, task.title.as_str())),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsView {
    agent: bool,
    pull_requests: bool,
    completion: bool,
}

impl From<PushSettings> for SettingsView {
    fn from(settings: PushSettings) -> Self {
        Self {
            agent: settings.agent,
            pull_requests: settings.pull_requests,
            completion: settings.completion,
        }
    }
}

impl From<SettingsView> for PushSettings {
    fn from(view: SettingsView) -> Self {
        Self {
            agent: view.agent,
            pull_requests: view.pull_requests,
            completion: view.completion,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct SubscriptionView {
    endpoint: String,
    settings: SettingsView,
}

impl From<PushSubscription> for SubscriptionView {
    fn from(subscription: PushSubscription) -> Self {
        Self {
            endpoint: subscription.endpoint.as_str().to_owned(),
            settings: subscription.settings.into(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PushView {
    public_key: String,
    subscription: Option<SubscriptionView>,
}

/// The JSON of a browser's `PushSubscription`; `expirationTime` is ignored.
#[derive(Debug, Deserialize)]
struct SubscriptionInput {
    endpoint: String,
    keys: KeysInput,
}

#[derive(Debug, Deserialize)]
struct KeysInput {
    p256dh: String,
    auth: String,
}

fn parse_subscription(input: &SubscriptionInput) -> Result<NewPushSubscription, CommandError> {
    let invalid = |error: &dyn std::fmt::Display| CommandError::invalid_input(error.to_string());
    let endpoint = PushEndpoint::parse(&input.endpoint).map_err(|error| invalid(&error))?;
    let decode = |name: &str, text: &str| {
        crypto::from_base64url(text).ok_or_else(|| {
            CommandError::invalid_input(format!("push subscription key {name} is not base64url"))
        })
    };
    let (p256dh, auth) = subscription_keys(
        &decode("p256dh", &input.keys.p256dh)?,
        &decode("auth", &input.keys.auth)?,
    )
    .map_err(|error| invalid(&error))?;
    if !crypto::is_valid_public_key(&p256dh) {
        return Err(CommandError::invalid_input(
            "push subscription key p256dh is not a point on P-256",
        ));
    }
    Ok(NewPushSubscription {
        endpoint,
        p256dh,
        auth,
    })
}

/// The asking device, or the 403 for a browser signed in with the shared token.
fn device(caller: Caller) -> Result<DeviceId, Box<Response>> {
    match caller {
        Caller::Device(id) => Ok(id),
        Caller::Shared => Err(Box::new(json(
            StatusCode::FORBIDDEN,
            &CommandError::rejected(
                "notifications are per device; sign in on this device to get a device token \
                 instead of using the shared web token",
            ),
        ))),
    }
}

fn parse<T: serde::de::DeserializeOwned>(body: &Bytes) -> Result<T, Box<Response>> {
    serde_json::from_slice(body)
        .map_err(|error| Box::new(Reply::BadArguments(error.to_string()).into_response()))
}

pub async fn state(
    State(services): State<Arc<Services>>,
    Extension(caller): Extension<Caller>,
) -> Response {
    let public_key = services.push.public_key();
    let subscription = match caller {
        Caller::Shared => Ok(None),
        Caller::Device(id) => {
            blocking(move || Ok(lock(&services.storage).push_subscription(id)?)).await
        }
    };
    Reply::result(subscription.map(|subscription| PushView {
        public_key,
        subscription: subscription.map(Into::into),
    }))
    .into_response()
}

pub async fn subscribe(
    State(services): State<Arc<Services>>,
    Extension(caller): Extension<Caller>,
    body: Bytes,
) -> Response {
    let device = match device(caller) {
        Ok(device) => device,
        Err(response) => return *response,
    };
    let input: SubscriptionInput = match parse(&body) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let new = match parse_subscription(&input) {
        Ok(new) => new,
        Err(error) => return Reply::Failed(error).into_response(),
    };
    let saved = blocking(move || {
        Ok(lock(&services.storage)
            .save_push_subscription(device, &new)
            .map(SubscriptionView::from)?)
    })
    .await;
    Reply::result(saved).into_response()
}

pub async fn unsubscribe(
    State(services): State<Arc<Services>>,
    Extension(caller): Extension<Caller>,
) -> Response {
    let device = match device(caller) {
        Ok(device) => device,
        Err(response) => return *response,
    };
    let removed = blocking(move || {
        lock(&services.storage).delete_push_subscription(device)?;
        Ok(())
    })
    .await;
    Reply::result(removed).into_response()
}

pub async fn save_settings(
    State(services): State<Arc<Services>>,
    Extension(caller): Extension<Caller>,
    body: Bytes,
) -> Response {
    let device = match device(caller) {
        Ok(device) => device,
        Err(response) => return *response,
    };
    let settings: SettingsView = match parse(&body) {
        Ok(settings) => settings,
        Err(response) => return *response,
    };
    let saved = blocking(move || {
        Ok(lock(&services.storage)
            .set_push_settings(device, settings.into())
            .map(SubscriptionView::from)?)
    })
    .await;
    Reply::result(saved).into_response()
}

pub async fn send_test(
    State(services): State<Arc<Services>>,
    Extension(caller): Extension<Caller>,
) -> Response {
    let device = match device(caller) {
        Ok(device) => device,
        Err(response) => return *response,
    };
    let storage_services = services.clone();
    let subscription = blocking(move || {
        lock(&storage_services.storage)
            .push_subscription(device)?
            .ok_or_else(|| {
                CommandError::from(crate::storage::StorageError::PushSubscriptionNotFound(
                    device,
                ))
            })
    })
    .await;
    let subscription = match subscription {
        Ok(subscription) => subscription,
        Err(error) => return Reply::Failed(error).into_response(),
    };
    let sent = match services.push.send(&subscription, &Alert::test()).await {
        Ok(()) => Ok(()),
        Err(SendError::Gone) => {
            let endpoint = subscription.endpoint.clone();
            let dropped = blocking(move || {
                lock(&services.storage).delete_push_endpoint(&endpoint)?;
                Ok(())
            })
            .await;
            dropped.and(Err(CommandError::not_found(
                "the push service no longer knows this device's subscription; turn \
                 notifications on again",
            )))
        }
        Err(error) => Err(CommandError::external(error.to_string())),
    };
    Reply::result(sent).into_response()
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::Mutex;

    use super::*;

    /// Records every request and answers each with the next queued status (201 when none
    /// is queued).
    #[derive(Default)]
    pub(crate) struct FakeTransport {
        pub requests: Arc<Mutex<Vec<PushRequest>>>,
        pub statuses: Arc<Mutex<Vec<u16>>>,
    }

    impl Transport for FakeTransport {
        fn post(
            &self,
            request: PushRequest,
        ) -> Pin<Box<dyn Future<Output = Result<PushResponse, String>> + Send + '_>> {
            self.requests.lock().unwrap().push(request);
            let status = {
                let mut statuses = self.statuses.lock().unwrap();
                if statuses.is_empty() {
                    201
                } else {
                    statuses.remove(0)
                }
            };
            Box::pin(async move {
                Ok(PushResponse {
                    status,
                    body: "nope".to_owned(),
                })
            })
        }
    }

    /// A push identity with a fresh key in `dir` and `transport`.
    pub(crate) fn push(dir: &Path, transport: FakeTransport) -> Push {
        let key = VapidKey::load_or_create(&dir.join(KEY_FILE)).unwrap();
        Push::new(
            key,
            "mailto:toodo@example.com".to_owned(),
            Box::new(transport),
        )
    }

    /// A browser's side of a subscription: the key it decrypts with and the JSON it sends.
    pub(crate) struct Browser {
        private: ring::agreement::EphemeralPrivateKey,
        pub public: [u8; 65],
        pub auth: [u8; 16],
    }

    impl Browser {
        pub(crate) fn new() -> Self {
            let rng = ring::rand::SystemRandom::new();
            let private =
                ring::agreement::EphemeralPrivateKey::generate(&ring::agreement::ECDH_P256, &rng)
                    .unwrap();
            let public = private
                .compute_public_key()
                .unwrap()
                .as_ref()
                .try_into()
                .unwrap();
            Self {
                private,
                public,
                auth: [7; 16],
            }
        }

        pub(crate) fn json(&self, endpoint: &str) -> serde_json::Value {
            serde_json::json!({
                "endpoint": endpoint,
                "expirationTime": null,
                "keys": {
                    "p256dh": crypto::base64url(&self.public),
                    "auth": crypto::base64url(&self.auth),
                }
            })
        }

        /// Decrypts a message, which only works once per browser key.
        pub(crate) fn decrypt(self, message: &[u8]) -> serde_json::Value {
            let secret = ring::agreement::agree_ephemeral(
                self.private,
                &ring::agreement::UnparsedPublicKey::new(
                    &ring::agreement::ECDH_P256,
                    crypto::sender_key(message),
                ),
                <[u8]>::to_vec,
            )
            .unwrap();
            serde_json::from_slice(&crypto::decrypt_with(
                &secret,
                &self.public,
                &self.auth,
                message,
            ))
            .unwrap()
        }
    }

    fn subscribed(
        storage: &StorageState,
        label: &str,
        endpoint: &str,
        settings: PushSettings,
    ) -> Browser {
        let browser = Browser::new();
        let mut storage = lock(storage);
        let device = storage
            .create_device(
                &crate::domain::device::DeviceLabel::parse(label).unwrap(),
                &crate::server::devices::token_hash(label),
            )
            .unwrap()
            .id;
        storage
            .save_push_subscription(
                device,
                &NewPushSubscription {
                    endpoint: PushEndpoint::parse(endpoint).unwrap(),
                    p256dh: browser.public,
                    auth: browser.auth,
                },
            )
            .unwrap();
        storage.set_push_settings(device, settings).unwrap();
        browser
    }

    #[test]
    fn alerts_reach_the_subscriptions_that_want_them_and_gone_ones_are_dropped() {
        let temp = tempfile::tempdir().unwrap();
        let transport = FakeTransport::default();
        let requests = transport.requests.clone();
        let statuses = transport.statuses.clone();
        let push = push(temp.path(), transport);
        let storage: StorageState =
            std::sync::Mutex::new(crate::storage::Storage::open_in_memory().unwrap());
        let phone = subscribed(
            &storage,
            "Phone",
            "https://push.example/phone",
            PushSettings::default(),
        );
        subscribed(
            &storage,
            "Laptop",
            "https://push.example/laptop",
            PushSettings {
                agent: false,
                ..PushSettings::default()
            },
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut watch = Watch::default();
        let agent = |status| TaskAgentStatus {
            task_id: crate::commands::types::TaskId(4),
            status,
        };
        watch.agents(&[agent(crate::commands::types::AgentStatus::Working)]);
        let alerts = watch.agents(&[agent(crate::commands::types::AgentStatus::Blocked)]);

        assert_eq!(deliver(&storage, &push, &runtime, &alerts), 1);
        let request = requests.lock().unwrap().remove(0);
        assert_eq!(request.endpoint, "https://push.example/phone");
        assert_eq!(request.urgency, "high");
        assert_eq!(request.ttl, 86_400);
        assert!(request.authorization.starts_with("vapid t="));
        assert_eq!(
            phone.decrypt(&request.body),
            serde_json::json!({
                "title": "Agent needs input", "body": "#4", "tag": "task-4-agent", "taskId": 4
            })
        );

        // The laptop's push service forgot it: it is dropped, and the phone keeps going.
        statuses.lock().unwrap().extend([201, 410]);
        assert_eq!(deliver(&storage, &push, &runtime, &[Alert::test()]), 1);
        let endpoints: Vec<String> = lock(&storage)
            .active_push_subscriptions()
            .unwrap()
            .into_iter()
            .map(|subscription| subscription.endpoint.as_str().to_owned())
            .collect();
        assert_eq!(endpoints, ["https://push.example/phone"]);
    }
}
