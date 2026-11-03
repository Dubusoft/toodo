//! HTTP endpoints and short-lived, server-side consent and authorization codes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::rejection::{FormRejection, QueryRejection};
use axum::extract::{Form, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::clients::{self, Cache, ClientMetadataFetcher, Metadata};
use super::{OwnerKey, PublicUrl, Scope, Scopes, hash, random};
use crate::commands::{StorageState, lock};
use crate::storage::oauth::{Client, RefreshResult};

pub(super) struct Server {
    pub issuer: PublicUrl,
    pub web_token: String,
    pub storage: Arc<StorageState>,
    pub fetcher: Arc<dyn ClientMetadataFetcher>,
    pub cache: Cache,
    pending: Mutex<HashMap<String, Pending>>,
    codes: Mutex<HashMap<String, Code>>,
}

/// Constructs only public OAuth and discovery routes; the caller opts in by mounting it.
pub fn router(
    issuer: PublicUrl,
    web_token: String,
    storage: Arc<StorageState>,
    fetcher: Arc<dyn ClientMetadataFetcher>,
) -> Router {
    Router::new()
        .route(
            "/.well-known/oauth-protected-resource",
            get(resource_metadata),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(resource_metadata),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(server_metadata),
        )
        .route("/.well-known/openid-configuration", get(server_metadata))
        .route("/oauth/register", post(register))
        .route(
            "/oauth/authorize",
            get(
                |state, query: Result<Query<Authorize>, QueryRejection>| async move {
                    match query {
                        Ok(query) => authorize(state, query).await,
                        Err(_) => html(StatusCode::BAD_REQUEST, "Start the connection again from the app with valid authorization parameters."),
                    }
                },
            )
            .post(
                |state, form: Result<Form<Consent>, FormRejection>| async move {
                    match form {
                        Ok(form) => consent(state, form).await,
                        Err(_) => html(StatusCode::BAD_REQUEST, "Start the connection again from the app and submit the consent form."),
                    }
                },
            ),
        )
        .route(
            "/oauth/token",
            post(
                |state, headers, form: Result<Form<TokenForm>, FormRejection>| async move {
                    match form {
                        Ok(form) => token(state, headers, form).await.into_response(),
                        Err(_) => OAuthError::bad("invalid_request", "Send token parameters as application/x-www-form-urlencoded form fields.").into_response(),
                    }
                },
            ),
        )
        .route(
            "/oauth/revoke",
            post(
                |state, headers, form: Result<Form<TokenForm>, FormRejection>| async move {
                    match form {
                        Ok(form) => revoke(state, headers, form).await.into_response(),
                        Err(_) => OAuthError::bad("invalid_request", "Send token and client authentication as application/x-www-form-urlencoded form fields.").into_response(),
                    }
                },
            ),
        )
        .with_state(Arc::new(Server {
            issuer,
            web_token,
            storage,
            fetcher,
            cache: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            codes: Mutex::new(HashMap::new()),
        }))
}

#[derive(Debug)]
pub(super) struct OAuthError {
    status: StatusCode,
    error: &'static str,
    description: String,
}

impl OAuthError {
    pub fn bad(error: &'static str, description: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            error,
            description: description.into(),
        }
    }

    pub fn internal() -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            error: "server_error",
            description: "Check the server database and random source, then start the connection again from the app.".to_owned(),
        }
    }

    fn client() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            error: "invalid_client",
            description: "Authenticate using the registered client method and secret, or register the client again.".to_owned(),
        }
    }

    fn grant() -> Self {
        Self::bad(
            "invalid_grant",
            "Start the connection again from the app to obtain a fresh authorization code or refresh token.",
        )
    }
}

impl IntoResponse for OAuthError {
    fn into_response(self) -> Response {
        let mut response = json_response(
            self.status,
            json!({
                "error": self.error, "error_description": self.description
            }),
        );
        if self.status == StatusCode::UNAUTHORIZED {
            response.headers_mut().insert(
                header::WWW_AUTHENTICATE,
                "Basic realm=\"oauth\"".parse().unwrap(),
            );
        }
        response
    }
}

fn json_response(status: StatusCode, value: Value) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        value.to_string(),
    )
        .into_response()
}

async fn resource_metadata(State(s): State<Arc<Server>>) -> Response {
    json_response(
        StatusCode::OK,
        json!({
            "resource": s.issuer.resource(), "authorization_servers": [s.issuer.as_str()],
            "scopes_supported": ["toodo.read", "toodo.write"],
            "bearer_methods_supported": ["header"], "resource_name": "Toodo"
        }),
    )
}

async fn server_metadata(State(s): State<Arc<Server>>) -> Response {
    let issuer = s.issuer.as_str();
    json_response(
        StatusCode::OK,
        json!({
            "issuer": issuer, "authorization_endpoint": format!("{issuer}/oauth/authorize"),
            "token_endpoint": format!("{issuer}/oauth/token"),
            "registration_endpoint": format!("{issuer}/oauth/register"),
            "revocation_endpoint": format!("{issuer}/oauth/revoke"),
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
            "revocation_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
            "scopes_supported": ["toodo.read", "toodo.write"],
            "client_id_metadata_document_supported": true
        }),
    )
}

async fn register(State(s): State<Arc<Server>>, body: Bytes) -> Result<Response, OAuthError> {
    let metadata: Metadata = serde_json::from_slice(&body).map_err(|_| OAuthError::bad(
        "invalid_client_metadata", "Send JSON metadata with a nonempty redirect_uris array and supported authentication method."))?;
    let method = metadata.validate(false)?;
    let id = random()?;
    let secret = if method == "none" {
        None
    } else {
        Some(random()?)
    };
    let at = lock(&s.storage).now();
    let client = metadata.client(id.clone(), method.clone(), secret.as_deref().map(hash), at);
    lock(&s.storage)
        .oauth_register_client(&client)
        .map_err(|_| OAuthError::internal())?;
    let mut result = json!({
        "client_id": id, "client_id_issued_at": at, "client_secret_expires_at": 0,
        "redirect_uris": metadata.redirect_uris, "token_endpoint_auth_method": method,
        "grant_types": metadata.grant_types.unwrap_or_else(|| vec!["authorization_code".to_owned(), "refresh_token".to_owned()]),
        "scope": Scopes::parse(metadata.scope.as_deref()).unwrap().to_string()
    });
    if let Some(name) = metadata.client_name {
        result["client_name"] = json!(name);
    }
    if let Some(secret) = secret {
        result["client_secret"] = json!(secret);
    }
    Ok(json_response(StatusCode::CREATED, result))
}

/// The most consent requests kept at once; the oldest is dropped beyond it.
const MAX_PENDING: usize = 1000;

#[derive(Clone)]
struct Pending {
    client: Client,
    redirect: String,
    redirect_required: bool,
    challenge: String,
    scopes: Scopes,
    state: Option<String>,
    resource: String,
    expires: i64,
    attempts: u8,
}

struct Code {
    pending: Pending,
    owner: OwnerKey,
    expires: i64,
    grant_id: Option<i64>,
}

#[derive(Default, Deserialize)]
struct Authorize {
    response_type: Option<String>,
    client_id: Option<String>,
    redirect_uri: Option<String>,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
    scope: Option<String>,
    state: Option<String>,
    resource: Option<String>,
}

async fn authorize(State(s): State<Arc<Server>>, Query(q): Query<Authorize>) -> Response {
    let client = match clients::resolve(&s, q.client_id.as_deref().unwrap_or("")).await {
        Ok(client) => client,
        Err(e) => return html(StatusCode::BAD_REQUEST, &escape(&e.description)),
    };
    let redirect_required = q.redirect_uri.is_some();
    let redirect = match q.redirect_uri {
        Some(uri) if client.redirect_uris.contains(&uri) => uri,
        None if client.redirect_uris.len() == 1 => client.redirect_uris[0].clone(),
        _ => {
            return html(
                StatusCode::BAD_REQUEST,
                "Register the redirect URI, then start the connection again from the app.",
            );
        }
    };
    let fail = |error, description: &str| {
        redirect_error(&s, &redirect, q.state.as_deref(), error, description)
    };
    if q.response_type.as_deref() != Some("code") {
        return fail(
            "unsupported_response_type",
            "Request response_type=code from the app.",
        );
    }
    let Some(challenge) = q.code_challenge else {
        return fail(
            "invalid_request",
            "Start the connection again with an S256 PKCE code challenge.",
        );
    };
    if q.code_challenge_method.as_deref() != Some("S256")
        || challenge.len() != 43
        || URL_SAFE_NO_PAD.decode(&challenge).is_err()
    {
        return fail(
            "invalid_request",
            "Start the connection again with an S256 PKCE code challenge.",
        );
    }
    let scopes = match Scopes::parse(q.scope.as_deref()) {
        Ok(scopes) => scopes,
        Err(e) => return fail("invalid_scope", &e),
    };
    if q.resource
        .as_ref()
        .is_some_and(|r| r != &s.issuer.resource() && r != s.issuer.as_str())
    {
        return fail(
            "invalid_target",
            "Request the issuer URL or its /mcp resource, then start the connection again from the app.",
        );
    }
    let id = match random() {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let now = lock(&s.storage).now();
    let pending = Pending {
        client,
        redirect,
        redirect_required,
        challenge,
        scopes,
        state: q.state,
        resource: q.resource.unwrap_or_else(|| s.issuer.resource()),
        expires: now + 600,
        attempts: 0,
    };
    let response = consent_page(&id, &pending, "");
    let mut requests = s.pending.lock().unwrap();
    requests.retain(|_, p| p.expires > now);
    // Anyone can start an authorization for a registered client; bound what they can hold.
    if requests.len() >= MAX_PENDING
        && let Some(oldest) = requests
            .iter()
            .min_by_key(|(_, p)| p.expires)
            .map(|(id, _)| id.clone())
    {
        requests.remove(&oldest);
    }
    requests.insert(id, pending);
    response
}

#[derive(Default, Deserialize)]
struct Consent {
    pending_id: String,
    #[serde(default)]
    web_token: String,
    decision: String,
    read: Option<String>,
    write: Option<String>,
}

async fn consent(State(s): State<Arc<Server>>, Form(form): Form<Consent>) -> Response {
    let now = lock(&s.storage).now();
    let mut requests = s.pending.lock().unwrap();
    let Some(mut pending) = requests
        .remove(&form.pending_id)
        .filter(|p| p.expires > now)
    else {
        return html(
            StatusCode::BAD_REQUEST,
            "Start the connection again from the app; this consent request has expired.",
        );
    };
    if form.decision == "deny" {
        return redirect_error(
            &s,
            &pending.redirect,
            pending.state.as_deref(),
            "access_denied",
            "Start the connection again from the app and approve it to grant access.",
        );
    }
    if !crate::mcp::same_secret(&form.web_token, &s.web_token) {
        pending.attempts += 1;
        if pending.attempts >= 5 {
            return html(
                StatusCode::BAD_REQUEST,
                "Start the connection again from the app; this consent request is locked after five incorrect sign-in tokens.",
            );
        }
        let response = consent_page(
            &form.pending_id,
            &pending,
            "Enter the web sign-in token from the server data directory and approve again.",
        );
        requests.insert(form.pending_id, pending);
        return response;
    }
    if form.decision != "approve" {
        let response = consent_page(
            &form.pending_id,
            &pending,
            "Choose Approve or Deny to continue.",
        );
        requests.insert(form.pending_id, pending);
        return response;
    }
    // Write-only approval keeps its scope; unticking write always grants read-only access.
    let _ = form.read;
    let mut scopes = if pending.scopes.contains(Scope::Read) {
        Scopes::READ
    } else {
        Scopes(0)
    };
    if pending.scopes.contains(Scope::Write) && form.write.is_some() {
        scopes.0 |= 2;
    }
    if scopes.0 == 0 {
        scopes = Scopes::READ;
    }
    pending.scopes = scopes;
    let code = match random() {
        Ok(code) => code,
        Err(e) => return e.into_response(),
    };
    let response = redirect_to(
        &s,
        &pending.redirect,
        pending.state.as_deref(),
        &[("code", &code)],
    );
    let mut codes = s.codes.lock().unwrap();
    codes.retain(|_, c| c.expires > now || (c.grant_id.is_some() && c.expires + 600 > now));
    codes.insert(
        hash(&code),
        Code {
            pending,
            owner: super::server_owner(),
            expires: now + 60,
            grant_id: None,
        },
    );
    response
}

fn redirect_to(s: &Server, uri: &str, state: Option<&str>, fields: &[(&str, &str)]) -> Response {
    let mut url = reqwest::Url::parse(uri).expect("redirect URI was validated");
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in fields {
            query.append_pair(key, value);
        }
        if let Some(state) = state {
            query.append_pair("state", state);
        }
        query.append_pair("iss", s.issuer.as_str());
    }
    (
        StatusCode::SEE_OTHER,
        [
            (header::LOCATION, url.as_str()),
            (header::CACHE_CONTROL, "no-store"),
        ],
    )
        .into_response()
}

fn redirect_error(
    s: &Server,
    uri: &str,
    state: Option<&str>,
    error: &str,
    description: &str,
) -> Response {
    redirect_to(
        s,
        uri,
        state,
        &[("error", error), ("error_description", description)],
    )
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn html(status: StatusCode, content: &str) -> Response {
    (status, [
        (header::CONTENT_TYPE, "text/html; charset=utf-8"),
        (header::CACHE_CONTROL, "no-store"),
        (header::X_FRAME_OPTIONS, "DENY"),
        (header::CONTENT_SECURITY_POLICY, "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"),
        (header::REFERRER_POLICY, "no-referrer"),
    ], format!(r#"<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Toodo connection</title><style>
body {{ font: 1rem system-ui; margin: 3rem auto; padding: 0 1rem; max-width: 32rem; line-height: 1.6; color: #222; background: #fff; }}
label {{ display: block; margin: 1rem 0; }} input[type=password] {{ box-sizing: border-box; width: 100%; padding: .6rem; }} button {{ padding: .6rem 1rem; margin-right: .5rem; }}
@media (prefers-color-scheme: dark) {{ body {{ background: #171717; color: #eee; }} input, button {{ background: #333; color: #eee; }} }}
</style><main><h1>Connect to Toodo</h1>{content}</main></html>"#)).into_response()
}

fn consent_page(id: &str, p: &Pending, error: &str) -> Response {
    let host = reqwest::Url::parse(&p.redirect).expect("validated redirect");
    let mut checkboxes = r#"<label><input type="checkbox" checked disabled> Read workspaces and tasks (toodo.read)</label>"#.to_owned();
    if p.scopes.contains(Scope::Write) {
        checkboxes.push_str(r#"<label><input type="checkbox" name="write" value="yes" checked> Create and update workspaces and tasks (toodo.write)</label>"#);
    }
    html(
        StatusCode::OK,
        &format!(
            r#"<p><strong>{}</strong> requests access. Return to {}.</p><p>{}</p><form method="post" action="/oauth/authorize"><input type="hidden" name="pending_id" value="{}">{}<label>Web sign-in token<input type="password" name="web_token" required autocomplete="off"></label><button name="decision" value="approve">Approve</button><button name="decision" value="deny" formnovalidate>Deny</button></form>"#,
            escape(
                p.client
                    .client_name
                    .as_deref()
                    .unwrap_or(&p.client.client_id)
            ),
            escape(host.host_str().unwrap_or("")),
            escape(error),
            escape(id),
            checkboxes
        ),
    )
}

#[derive(Default, Deserialize)]
struct TokenForm {
    grant_type: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    code: Option<String>,
    redirect_uri: Option<String>,
    code_verifier: Option<String>,
    refresh_token: Option<String>,
    scope: Option<String>,
    token: Option<String>,
    token_type_hint: Option<String>,
}

fn decode_basic(value: &str) -> Option<(String, String)> {
    let encoded = value.strip_prefix("Basic ")?;
    let decoded = String::from_utf8(STANDARD.decode(encoded).ok()?).ok()?;
    let (id, secret) = decoded.split_once(':')?;
    // Basic credentials use application/x-www-form-urlencoded encoding before base64.
    let decode = |value: &str| {
        reqwest::Url::parse(&format!("https://localhost/?value={value}"))
            .ok()?
            .query_pairs()
            .find(|(key, _)| key == "value")
            .map(|(_, value)| value.into_owned())
    };
    Some((decode(id)?, decode(secret)?))
}

async fn authenticate(
    s: &Server,
    headers: &HeaderMap,
    form: &TokenForm,
) -> Result<Client, OAuthError> {
    let auth = headers.get(header::AUTHORIZATION);
    let basic = match auth {
        Some(value) => Some(
            decode_basic(value.to_str().map_err(|_| OAuthError::client())?)
                .ok_or_else(OAuthError::client)?,
        ),
        None => None,
    };
    if basic.is_some() && form.client_secret.is_some() {
        return Err(OAuthError::client());
    }
    let id = basic
        .as_ref()
        .map(|(id, _)| id.as_str())
        .or(form.client_id.as_deref())
        .ok_or_else(OAuthError::client)?;
    if basic
        .as_ref()
        .is_some_and(|(id, _)| form.client_id.as_ref().is_some_and(|body_id| body_id != id))
    {
        return Err(OAuthError::client());
    }
    let client = clients::resolve(s, id)
        .await
        .map_err(|_| OAuthError::client())?;
    let secret = match client.auth_method.as_str() {
        "none" if basic.is_none() && form.client_secret.is_none() => return Ok(client),
        "client_secret_basic" => basic.as_ref().map(|(_, secret)| secret.as_str()),
        "client_secret_post" if basic.is_none() => form.client_secret.as_deref(),
        _ => None,
    }
    .ok_or_else(OAuthError::client)?;
    if !client
        .secret_hash
        .as_deref()
        .is_some_and(|stored| crate::mcp::same_secret(&hash(secret), stored))
    {
        return Err(OAuthError::client());
    }
    Ok(client)
}

fn verifier_matches(verifier: &str, challenge: &str) -> bool {
    (43..=128).contains(&verifier.len())
        && verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
        && crate::mcp::same_secret(
            &URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
            challenge,
        )
}

async fn token(
    State(s): State<Arc<Server>>,
    headers: HeaderMap,
    Form(form): Form<TokenForm>,
) -> Result<Response, OAuthError> {
    let client = authenticate(&s, &headers, &form).await?;
    let access = random()?;
    let refresh = random()?;
    let scopes = match form.grant_type.as_deref() {
        Some("authorization_code") => {
            let mut codes = s.codes.lock().unwrap();
            let code = codes
                .get_mut(&hash(form.code.as_deref().unwrap_or("")))
                .ok_or_else(OAuthError::grant)?;
            if code.pending.client.client_id != client.client_id
                || ((code.pending.redirect_required || form.redirect_uri.is_some())
                    && form.redirect_uri.as_deref() != Some(&code.pending.redirect))
                || !verifier_matches(
                    form.code_verifier.as_deref().unwrap_or(""),
                    &code.pending.challenge,
                )
            {
                return Err(OAuthError::grant());
            }
            if let Some(id) = code.grant_id {
                lock(&s.storage)
                    .oauth_revoke_grant(id)
                    .map_err(|_| OAuthError::internal())?;
                return Err(OAuthError::grant());
            }
            if code.expires <= lock(&s.storage).now()
                || (code.pending.resource != s.issuer.resource()
                    && code.pending.resource != s.issuer.as_str())
            {
                return Err(OAuthError::grant());
            }
            let id = lock(&s.storage)
                .oauth_create_grant(
                    &code.owner,
                    &client,
                    code.pending.scopes,
                    &hash(&access),
                    &hash(&refresh),
                )
                .map_err(|_| OAuthError::internal())?;
            code.grant_id = Some(id);
            code.pending.scopes
        }
        Some("refresh_token") => {
            let requested = form
                .scope
                .as_deref()
                .map(|scope| Scopes::parse(Some(scope)))
                .transpose()
                .map_err(|e| OAuthError::bad("invalid_scope", e))?;
            match lock(&s.storage)
                .oauth_rotate(
                    &hash(form.refresh_token.as_deref().unwrap_or("")),
                    &client.client_id,
                    requested,
                    &hash(&access),
                    &hash(&refresh),
                )
                .map_err(|_| OAuthError::internal())?
            {
                RefreshResult::Issued(scopes) => scopes,
                RefreshResult::Invalid => return Err(OAuthError::grant()),
                RefreshResult::InvalidScope => {
                    return Err(OAuthError::bad(
                        "invalid_scope",
                        "Request the same scopes or fewer scopes than the current refresh grant.",
                    ));
                }
            }
        }
        None => {
            return Err(OAuthError::bad(
                "invalid_request",
                "Send grant_type=authorization_code or grant_type=refresh_token.",
            ));
        }
        _ => {
            return Err(OAuthError::bad(
                "unsupported_grant_type",
                "Use authorization_code or refresh_token as grant_type.",
            ));
        }
    };
    Ok(json_response(
        StatusCode::OK,
        json!({
            "access_token": access, "token_type": "Bearer", "expires_in": 3600,
            "refresh_token": refresh, "scope": scopes.to_string()
        }),
    ))
}

async fn revoke(
    State(s): State<Arc<Server>>,
    headers: HeaderMap,
    Form(form): Form<TokenForm>,
) -> Result<Response, OAuthError> {
    let client = authenticate(&s, &headers, &form).await?;
    let token = form.token.ok_or_else(|| {
        OAuthError::bad(
            "invalid_request",
            "Send the token to revoke in the token form field.",
        )
    })?;
    let _ = form.token_type_hint;
    lock(&s.storage)
        .oauth_revoke_token(&hash(&token), &client.client_id)
        .map_err(|_| OAuthError::internal())?;
    Ok((StatusCode::OK, [(header::CACHE_CONTROL, "no-store")]).into_response())
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
