use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

use super::*;
use crate::oauth::{FetchFuture, resolve_access_token, server_owner};
use crate::storage::Storage;

const VERIFIER: &str = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const REDIRECT: &str = "https://client.example/callback";

struct FakeFetcher {
    document: Vec<u8>,
    calls: AtomicUsize,
}

impl ClientMetadataFetcher for FakeFetcher {
    fn fetch<'a>(&'a self, _: &'a str) -> FetchFuture<'a> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(self.document.clone()) })
    }
}

fn server() -> (Arc<Server>, Arc<AtomicI64>) {
    let clock = Arc::new(AtomicI64::new(1_000));
    let mut storage = Storage::open_in_memory().unwrap();
    let now = clock.clone();
    storage.set_clock(move || now.load(Ordering::SeqCst));
    (
        Arc::new(Server {
            issuer: PublicUrl::parse("https://toodo.example").unwrap(),
            web_token: "owner-web-token".to_owned(),
            storage: Arc::new(Mutex::new(storage)),
            fetcher: Arc::new(FakeFetcher {
                document: vec![],
                calls: AtomicUsize::new(0),
            }),
            cache: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            codes: Mutex::new(HashMap::new()),
        }),
        clock,
    )
}

async fn text(response: Response) -> String {
    String::from_utf8(
        axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap()
}

async fn json_body(response: Response) -> Value {
    serde_json::from_str(&text(response).await).unwrap()
}

async fn client(s: &Arc<Server>) -> String {
    let response = register(
        State(s.clone()),
        Bytes::from(
            json!({
                "redirect_uris": [REDIRECT], "token_endpoint_auth_method": "none",
                "client_name": "Example client"
            })
            .to_string(),
        ),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    json_body(response).await["client_id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn query(id: &str) -> Authorize {
    Authorize {
        response_type: Some("code".to_owned()),
        client_id: Some(id.to_owned()),
        redirect_uri: Some(REDIRECT.to_owned()),
        code_challenge: Some(URL_SAFE_NO_PAD.encode(Sha256::digest(VERIFIER.as_bytes()))),
        code_challenge_method: Some("S256".to_owned()),
        state: Some("<state>&value".to_owned()),
        ..Default::default()
    }
}

async fn pending(s: &Arc<Server>, id: &str) -> String {
    let response = authorize(State(s.clone()), Query(query(id))).await;
    assert_eq!(response.status(), StatusCode::OK);
    s.pending.lock().unwrap().keys().next().unwrap().clone()
}

fn approval(id: &str) -> Consent {
    Consent {
        pending_id: id.to_owned(),
        web_token: "owner-web-token".to_owned(),
        decision: "approve".to_owned(),
        write: Some("yes".to_owned()),
        ..Default::default()
    }
}

fn location(response: &Response) -> reqwest::Url {
    reqwest::Url::parse(response.headers()[header::LOCATION].to_str().unwrap()).unwrap()
}

async fn code(s: &Arc<Server>, id: &str) -> String {
    let request = pending(s, id).await;
    let response = consent(State(s.clone()), Form(approval(&request))).await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    let url = location(&response);
    let pairs: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(pairs["state"], "<state>&value");
    assert_eq!(pairs["iss"], s.issuer.as_str());
    pairs["code"].clone()
}

fn exchange(id: &str, code: &str) -> TokenForm {
    TokenForm {
        grant_type: Some("authorization_code".to_owned()),
        client_id: Some(id.to_owned()),
        code: Some(code.to_owned()),
        redirect_uri: Some(REDIRECT.to_owned()),
        code_verifier: Some(VERIFIER.to_owned()),
        ..Default::default()
    }
}

fn refresh_form(id: &str, refresh: &str) -> TokenForm {
    TokenForm {
        grant_type: Some("refresh_token".to_owned()),
        client_id: Some(id.to_owned()),
        refresh_token: Some(refresh.to_owned()),
        ..Default::default()
    }
}

async fn pair(s: &Arc<Server>, id: &str) -> Value {
    let code = code(s, id).await;
    json_body(
        token(
            State(s.clone()),
            HeaderMap::new(),
            Form(exchange(id, &code)),
        )
        .await
        .unwrap(),
    )
    .await
}

#[test]
fn public_url_rejects_non_origins_and_requires_secure_transport() {
    for value in [
        "https://toodo.example/",
        "http://localhost:8080",
        "http://127.0.0.1",
        "http://[::1]:8080",
    ] {
        assert!(PublicUrl::parse(value).is_ok(), "{value}");
    }
    for value in [
        "http://example.com",
        "https://x/path",
        "https://x?query",
        "https://x/#fragment",
        "https://user@x",
        "ftp://x",
        "bad",
    ] {
        assert!(PublicUrl::parse(value).is_err(), "{value}");
    }
    assert_eq!(
        PublicUrl::parse("https://toodo.example/").unwrap().as_str(),
        "https://toodo.example"
    );
}

#[test]
fn scopes_are_independent_and_default_to_both() {
    assert_eq!(Scopes::parse(None).unwrap(), Scopes::ALL);
    let write = Scopes::parse(Some("toodo.write")).unwrap();
    assert!(!write.contains(Scope::Read));
    assert!(write.can_read());
    assert!(write.can_write());
    assert!(!Scopes::READ.can_write());
    assert!(Scopes::parse(Some("unknown")).is_err());
    assert!(Scopes::parse(Some("")).is_err());
    assert!(Scopes::parse(Some(" \t\r\n")).is_err());
}

#[tokio::test]
async fn discovery_metadata_matches_issuer_and_supported_protocols() {
    let (s, _) = server();
    let resource = json_body(resource_metadata(State(s.clone())).await).await;
    assert_eq!(
        resource,
        json!({
            "resource": "https://toodo.example/mcp", "authorization_servers": ["https://toodo.example"],
            "scopes_supported": ["toodo.read", "toodo.write"],
            "bearer_methods_supported": ["header"], "resource_name": "Toodo"
        })
    );
    let metadata = json_body(server_metadata(State(s.clone())).await).await;
    assert_eq!(metadata["issuer"], s.issuer.as_str());
    for (field, path) in [
        ("authorization_endpoint", "authorize"),
        ("token_endpoint", "token"),
        ("registration_endpoint", "register"),
        ("revocation_endpoint", "revoke"),
    ] {
        assert_eq!(metadata[field], format!("{}/oauth/{path}", s.issuer));
    }
    assert_eq!(metadata["response_types_supported"], json!(["code"]));
    assert_eq!(
        metadata["grant_types_supported"],
        json!(["authorization_code", "refresh_token"])
    );
    assert_eq!(
        metadata["code_challenge_methods_supported"],
        json!(["S256"])
    );
    assert_eq!(
        metadata["token_endpoint_auth_methods_supported"],
        json!(["none", "client_secret_post", "client_secret_basic"])
    );
    assert_eq!(
        metadata["revocation_endpoint_auth_methods_supported"],
        metadata["token_endpoint_auth_methods_supported"]
    );
    assert_eq!(metadata["client_id_metadata_document_supported"], true);
    let _router = router(
        s.issuer.clone(),
        s.web_token.clone(),
        s.storage.clone(),
        s.fetcher.clone(),
    );
}

#[tokio::test]
async fn registration_issues_only_hashed_secrets_and_rejects_invalid_metadata() {
    let (s, _) = server();
    for method in ["none", "client_secret_post", "client_secret_basic"] {
        let response = register(
            State(s.clone()),
            Bytes::from(
                json!({
                    "redirect_uris": [REDIRECT], "token_endpoint_auth_method": method
                })
                .to_string(),
            ),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let value = json_body(response).await;
        let stored = lock(&s.storage)
            .oauth_client(value["client_id"].as_str().unwrap())
            .unwrap()
            .unwrap();
        if method == "none" {
            assert!(value.get("client_secret").is_none());
            assert!(stored.secret_hash.is_none());
        } else {
            let secret = value["client_secret"].as_str().unwrap();
            assert_eq!(stored.secret_hash.as_deref(), Some(hash(secret).as_str()));
            assert_ne!(stored.secret_hash.as_deref(), Some(secret));
        }
    }
    for (body, error) in [
        (json!({}), "invalid_client_metadata"),
        (json!({"redirect_uris": []}), "invalid_redirect_uri"),
        (
            json!({"redirect_uris": ["http://not-loopback.example/cb"]}),
            "invalid_redirect_uri",
        ),
        (
            json!({"redirect_uris": ["https://client.example/#fragment"]}),
            "invalid_redirect_uri",
        ),
        (
            json!({"redirect_uris": [REDIRECT], "token_endpoint_auth_method": "client_secret_jwt"}),
            "invalid_client_metadata",
        ),
        (
            json!({"redirect_uris": [REDIRECT], "grant_types": ["password"]}),
            "invalid_client_metadata",
        ),
        (
            json!({"redirect_uris": [REDIRECT], "scope": "admin"}),
            "invalid_client_metadata",
        ),
    ] {
        let rejected = register(State(s.clone()), Bytes::from(body.to_string()))
            .await
            .unwrap_err();
        assert_eq!(rejected.error, error);
    }
    let defaults = json_body(
        register(
            State(s.clone()),
            Bytes::from(json!({"redirect_uris":[REDIRECT]}).to_string()),
        )
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(
        defaults["token_endpoint_auth_method"],
        "client_secret_basic"
    );
    assert!(defaults["client_secret"].is_string());
}

#[tokio::test]
async fn cimd_is_validated_and_cached_with_a_fake_fetcher() {
    let (mut s, _) = server();
    let id = "https://client.example/metadata.json";
    let fetcher = Arc::new(FakeFetcher {
        document: json!({"client_id": id, "redirect_uris": [REDIRECT], "token_endpoint_auth_method": "none"}).to_string().into_bytes(),
        calls: AtomicUsize::new(0),
    });
    Arc::get_mut(&mut s).unwrap().fetcher = fetcher.clone();
    for _ in 0..2 {
        let client = clients::resolve(&s, id).await.unwrap();
        assert_eq!(client.client_id, id);
        assert_eq!(client.auth_method, "none");
    }
    assert_eq!(fetcher.calls.load(Ordering::SeqCst), 1);
    assert!(
        clients::resolve(&s, "https://client.example/")
            .await
            .is_err()
    );
    for document in [
        json!({"client_id": "https://other.example/document", "redirect_uris": [REDIRECT]}),
        json!({"client_id": id, "redirect_uris": [REDIRECT], "token_endpoint_auth_method": "client_secret_post"}),
        json!({"client_id": id, "redirect_uris": []}),
    ] {
        let (mut s, _) = server();
        Arc::get_mut(&mut s).unwrap().fetcher = Arc::new(FakeFetcher {
            document: document.to_string().into_bytes(),
            calls: AtomicUsize::new(0),
        });
        assert!(clients::resolve(&s, id).await.is_err());
    }
}

#[tokio::test]
async fn cimd_cache_prunes_expired_documents_and_evicts_the_oldest_at_capacity() {
    use std::time::{Duration, Instant};

    let (mut s, _) = server();
    let id = "https://client.example/metadata.json";
    Arc::get_mut(&mut s).unwrap().fetcher = Arc::new(FakeFetcher {
        document: json!({"client_id": id, "redirect_uris": [REDIRECT]})
            .to_string()
            .into_bytes(),
        calls: AtomicUsize::new(0),
    });
    let client = clients::resolve(&s, id).await.unwrap();
    let now = Instant::now();
    {
        let mut cache = s.cache.lock().unwrap();
        cache.clear();
        for n in 0..100 {
            cache.insert(
                format!("https://client.example/{n}"),
                (now - Duration::from_secs(100 - n), client.clone()),
            );
        }
        cache.insert(
            "https://client.example/expired".to_owned(),
            (now - Duration::from_secs(600), client.clone()),
        );
    }
    clients::resolve(&s, id).await.unwrap();
    let cache = s.cache.lock().unwrap();
    assert_eq!(cache.len(), 100);
    assert!(!cache.contains_key("https://client.example/expired"));
    assert!(!cache.contains_key("https://client.example/0"));
    assert!(cache.contains_key("https://client.example/1"));
    assert!(cache.contains_key(id));
}

#[tokio::test]
async fn authorization_never_redirects_bad_clients_or_redirects_and_requires_s256_resource() {
    let (s, _) = server();
    let response = authorize(State(s.clone()), Query(query("unknown"))).await;
    assert!(!response.headers().contains_key(header::LOCATION));
    let id = client(&s).await;
    let mut q = query(&id);
    q.redirect_uri = Some("https://attacker.example/callback".to_owned());
    assert!(
        !authorize(State(s.clone()), Query(q))
            .await
            .headers()
            .contains_key(header::LOCATION)
    );
    for (method, resource, error) in [
        ("plain", None, "invalid_request"),
        ("S256", Some("https://other.example/mcp"), "invalid_target"),
    ] {
        let mut q = query(&id);
        q.code_challenge_method = Some(method.to_owned());
        q.resource = resource.map(str::to_owned);
        let response = authorize(State(s.clone()), Query(q)).await;
        assert_eq!(
            location(&response)
                .query_pairs()
                .find(|(k, _)| k == "error")
                .unwrap()
                .1,
            error
        );
    }
    let mut q = query(&id);
    q.redirect_uri = None;
    q.resource = Some(s.issuer.as_str().to_owned());
    assert_eq!(
        authorize(State(s.clone()), Query(q)).await.status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn consent_denial_wrong_token_lockout_and_parameter_binding() {
    let (s, _) = server();
    let id = client(&s).await;
    let request = pending(&s, &id).await;
    for attempt in 1..=5 {
        let mut form = approval(&request);
        form.web_token = "wrong".to_owned();
        let response = consent(State(s.clone()), Form(form)).await;
        assert_eq!(
            response.status(),
            if attempt == 5 {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::OK
            }
        );
    }
    assert!(!s.pending.lock().unwrap().contains_key(&request));
    assert_eq!(
        consent(State(s.clone()), Form(approval(&request)))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    let request = pending(&s, &id).await;
    let form: Consent = serde_json::from_value(json!({
        "pending_id": request, "decision": "deny"
    }))
    .unwrap();
    let response = consent(State(s.clone()), Form(form)).await;
    assert_eq!(
        location(&response)
            .query_pairs()
            .find(|(k, _)| k == "error")
            .unwrap()
            .1,
        "access_denied"
    );
    assert!(s.codes.lock().unwrap().is_empty());
    assert!(!s.pending.lock().unwrap().contains_key(&request));
    let request = pending(&s, &id).await;
    let mut form = approval(&request);
    form.write = None;
    consent(State(s.clone()), Form(form)).await;
    assert_eq!(
        s.codes
            .lock()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .pending
            .scopes,
        Scopes::READ
    );
}

#[tokio::test]
async fn pkce_exchange_rejects_wrong_verifier_and_reuse_revokes_grant() {
    let (s, _) = server();
    let id = client(&s).await;
    let code = code(&s, &id).await;
    let mut form = exchange(&id, &code);
    form.code_verifier = Some("z".repeat(43));
    assert_eq!(
        token(State(s.clone()), HeaderMap::new(), Form(form))
            .await
            .unwrap_err()
            .error,
        "invalid_grant"
    );
    let response = token(
        State(s.clone()),
        HeaderMap::new(),
        Form(exchange(&id, &code)),
    )
    .await
    .unwrap();
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let tokens = json_body(response).await;
    let access = tokens["access_token"].as_str().unwrap();
    let live = resolve_access_token(&s.storage, access).unwrap().unwrap();
    assert_eq!(live.owner_key, server_owner());
    assert_eq!(live.scopes, Scopes::ALL);
    assert!(
        resolve_access_token(&s.storage, tokens["refresh_token"].as_str().unwrap())
            .unwrap()
            .is_none()
    );
    assert!(
        token(
            State(s.clone()),
            HeaderMap::new(),
            Form(exchange(&id, &code))
        )
        .await
        .is_err()
    );
    assert!(resolve_access_token(&s.storage, access).unwrap().is_none());
}

#[tokio::test]
async fn token_redirect_is_optional_only_when_omitted_from_authorization() {
    for included in [false, true] {
        for redirect in [None, Some(REDIRECT), Some("https://client.example/other")] {
            let (s, _) = server();
            let id = client(&s).await;
            let mut q = query(&id);
            if !included {
                q.redirect_uri = None;
            }
            assert_eq!(
                authorize(State(s.clone()), Query(q)).await.status(),
                StatusCode::OK
            );
            let request = s.pending.lock().unwrap().keys().next().unwrap().clone();
            let response = consent(State(s.clone()), Form(approval(&request))).await;
            let code = location(&response)
                .query_pairs()
                .find(|(key, _)| key == "code")
                .unwrap()
                .1
                .into_owned();
            let mut form = exchange(&id, &code);
            form.redirect_uri = redirect.map(str::to_owned);
            let result = token(State(s.clone()), HeaderMap::new(), Form(form)).await;
            if redirect == Some(REDIRECT) || (!included && redirect.is_none()) {
                assert_eq!(result.unwrap().status(), StatusCode::OK);
            } else {
                assert_eq!(result.unwrap_err().error, "invalid_grant");
            }
        }
    }
}

#[tokio::test]
async fn write_only_consent_can_be_reduced_to_read() {
    for write in [None, Some("yes".to_owned())] {
        let (s, _) = server();
        let id = client(&s).await;
        let mut q = query(&id);
        q.scope = Some("toodo.write".to_owned());
        assert_eq!(
            authorize(State(s.clone()), Query(q)).await.status(),
            StatusCode::OK
        );
        let request = s.pending.lock().unwrap().keys().next().unwrap().clone();
        let mut form = approval(&request);
        form.write = write.clone();
        let response = consent(State(s.clone()), Form(form)).await;
        let code = location(&response)
            .query_pairs()
            .find(|(key, _)| key == "code")
            .unwrap()
            .1
            .into_owned();
        let tokens = json_body(
            token(
                State(s.clone()),
                HeaderMap::new(),
                Form(exchange(&id, &code)),
            )
            .await
            .unwrap(),
        )
        .await;
        assert_eq!(
            tokens["scope"],
            if write.is_some() {
                "toodo.write"
            } else {
                "toodo.read"
            }
        );
    }
}

#[tokio::test]
async fn refresh_rotates_narrows_and_replay_revokes_the_family() {
    let (s, _) = server();
    let id = client(&s).await;
    let original = pair(&s, &id).await;
    let refresh = original["refresh_token"].as_str().unwrap();
    let mut form = refresh_form(&id, refresh);
    form.scope = Some("toodo.read".to_owned());
    let narrowed = json_body(
        token(State(s.clone()), HeaderMap::new(), Form(form))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(narrowed["scope"], "toodo.read");
    assert_ne!(narrowed["refresh_token"], original["refresh_token"]);
    let mut form = refresh_form(&id, narrowed["refresh_token"].as_str().unwrap());
    form.scope = Some("toodo.write".to_owned());
    assert_eq!(
        token(State(s.clone()), HeaderMap::new(), Form(form))
            .await
            .unwrap_err()
            .error,
        "invalid_scope"
    );
    let access = narrowed["access_token"].as_str().unwrap();
    assert_eq!(
        resolve_access_token(&s.storage, access)
            .unwrap()
            .unwrap()
            .scopes,
        Scopes::READ
    );
    assert!(
        token(
            State(s.clone()),
            HeaderMap::new(),
            Form(refresh_form(&id, refresh))
        )
        .await
        .is_err()
    );
    assert!(resolve_access_token(&s.storage, access).unwrap().is_none());
}

#[tokio::test]
async fn revocation_rejects_wrong_client_and_accepts_unknown_tokens() {
    let (s, _) = server();
    let id = client(&s).await;
    let other = client(&s).await;
    for field in ["access_token", "refresh_token"] {
        let tokens = pair(&s, &id).await;
        let access = tokens["access_token"].as_str().unwrap();
        let revoke_form = |client_id: &str| TokenForm {
            client_id: Some(client_id.to_owned()),
            token: Some(tokens[field].as_str().unwrap().to_owned()),
            ..Default::default()
        };
        revoke(
            State(s.clone()),
            HeaderMap::new(),
            Form(revoke_form(&other)),
        )
        .await
        .unwrap();
        assert!(resolve_access_token(&s.storage, access).unwrap().is_some());
        revoke(State(s.clone()), HeaderMap::new(), Form(revoke_form(&id)))
            .await
            .unwrap();
        assert!(resolve_access_token(&s.storage, access).unwrap().is_none());
    }
    let response = revoke(
        State(s.clone()),
        HeaderMap::new(),
        Form(TokenForm {
            client_id: Some(id),
            token: Some("unknown".to_owned()),
            ..Default::default()
        }),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn expiry_and_last_use_follow_the_database_clock() {
    let (s, clock) = server();
    let id = client(&s).await;
    let tokens = pair(&s, &id).await;
    let access = tokens["access_token"].as_str().unwrap();
    assert!(resolve_access_token(&s.storage, access).unwrap().is_some());
    assert_eq!(
        lock(&s.storage).oauth_list_grants().unwrap()[0].last_used_at,
        Some(1_000)
    );
    clock.store(4_600, Ordering::SeqCst);
    assert!(resolve_access_token(&s.storage, access).unwrap().is_none());
    clock.store(1_000 + 30 * 86400, Ordering::SeqCst);
    assert!(
        token(
            State(s.clone()),
            HeaderMap::new(),
            Form(refresh_form(&id, tokens["refresh_token"].as_str().unwrap()))
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn html_escapes_untrusted_client_names_and_sets_security_headers() {
    let (s, _) = server();
    let response = register(State(s.clone()), Bytes::from(json!({
        "redirect_uris": [REDIRECT], "client_name": "<script>\"'&</script>", "token_endpoint_auth_method": "none"
    }).to_string())).await.unwrap();
    let id = json_body(response).await["client_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let response = authorize(State(s.clone()), Query(query(&id))).await;
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(response.headers()[header::X_FRAME_OPTIONS], "DENY");
    assert_eq!(response.headers()[header::REFERRER_POLICY], "no-referrer");
    assert_eq!(
        response.headers()[header::CONTENT_SECURITY_POLICY],
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"
    );
    let page = text(response).await;
    assert!(page.contains(r#"<button name="decision" value="deny" formnovalidate>"#));
    assert!(!page.contains("<script>"));
    assert!(page.contains("&lt;script&gt;&quot;&#39;&amp;&lt;/script&gt;"));
}

#[tokio::test]
async fn confidential_authentication_enforces_registered_method() {
    let (s, _) = server();
    for method in ["client_secret_post", "client_secret_basic"] {
        let registration = json_body(
            register(
                State(s.clone()),
                Bytes::from(
                    json!({
                        "redirect_uris": [REDIRECT], "token_endpoint_auth_method": method
                    })
                    .to_string(),
                ),
            )
            .await
            .unwrap(),
        )
        .await;
        let id = registration["client_id"].as_str().unwrap();
        let secret = registration["client_secret"].as_str().unwrap();
        let mut form = TokenForm {
            client_id: Some(id.to_owned()),
            ..Default::default()
        };
        assert!(authenticate(&s, &HeaderMap::new(), &form).await.is_err());
        let mut headers = HeaderMap::new();
        if method == "client_secret_basic" {
            headers.insert(
                header::AUTHORIZATION,
                format!("Basic {}", STANDARD.encode(format!("{id}:{secret}")))
                    .parse()
                    .unwrap(),
            );
        } else {
            form.client_secret = Some(secret.to_owned());
        }
        assert!(authenticate(&s, &headers, &form).await.is_ok());
        form.client_secret = Some("wrong".to_owned());
        assert!(authenticate(&s, &headers, &form).await.is_err());
    }
}

#[tokio::test]
async fn pending_requests_and_unused_codes_expire_without_grants() {
    let (s, clock) = server();
    let id = client(&s).await;
    let request = pending(&s, &id).await;
    clock.store(1600, Ordering::SeqCst);
    assert_eq!(
        consent(State(s.clone()), Form(approval(&request)))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    let code = code(&s, &id).await;
    clock.store(1660, Ordering::SeqCst);
    assert_eq!(
        token(
            State(s.clone()),
            HeaderMap::new(),
            Form(exchange(&id, &code))
        )
        .await
        .unwrap_err()
        .error,
        "invalid_grant"
    );
    assert!(lock(&s.storage).oauth_list_grants().unwrap().is_empty());
}

#[tokio::test]
async fn router_serves_discovery_and_handles_malformed_forms() {
    let (s, _) = server();
    let fetcher = Arc::new(crate::oauth::HttpClientMetadataFetcher::new().unwrap());
    // Only this in-process test router listens on an ephemeral port; it never opens app data.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = router(
        s.issuer.clone(),
        s.web_token.clone(),
        s.storage.clone(),
        fetcher,
    );
    let (shutdown, receiver) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = receiver.await;
            })
            .await
            .unwrap();
    });
    drop(rustls::crypto::ring::default_provider().install_default());
    let http = reqwest::Client::new();
    for path in [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
        "/.well-known/oauth-authorization-server",
        "/.well-known/openid-configuration",
    ] {
        let response = http
            .get(format!("http://{address}{path}"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        let _: Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
    }
    let response = http
        .post(format!("http://{address}/oauth/register"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(
            json!({"redirect_uris": [REDIRECT], "token_endpoint_auth_method": "none"}).to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    for path in ["/oauth/token", "/oauth/revoke"] {
        let response = http
            .post(format!("http://{address}{path}"))
            .body("not-a-form")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let error: Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
        assert_eq!(error["error"], "invalid_request");
    }
    let response = http
        .post(format!("http://{address}/oauth/authorize"))
        .body("not-a-form")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(response.headers()[header::X_FRAME_OPTIONS], "DENY");
    shutdown.send(()).unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn exchanged_codes_have_a_bounded_replay_detection_window() {
    let (s, clock) = server();
    let id = client(&s).await;
    let original = code(&s, &id).await;
    token(
        State(s.clone()),
        HeaderMap::new(),
        Form(exchange(&id, &original)),
    )
    .await
    .unwrap();
    clock.store(1659, Ordering::SeqCst);
    code(&s, &id).await;
    assert!(s.codes.lock().unwrap().contains_key(&hash(&original)));
    clock.store(1660, Ordering::SeqCst);
    code(&s, &id).await;
    assert!(!s.codes.lock().unwrap().contains_key(&hash(&original)));
}
