//! Sign-in through Cloudflare Access. Behind an Access application, Cloudflare signs every
//! request it lets through with a JWT in the `Cf-Access-Jwt-Assertion` header. With
//! `TOODO_CF_ACCESS_TEAM_DOMAIN` and `TOODO_CF_ACCESS_AUD` set, `/api` lets a request in
//! when that JWT verifies: an RS256 signature by a key of the team's certificate list
//! (`https://<team domain>/cdn-cgi/access/certs`), the team domain as issuer, the
//! application's AUD tag among its audiences, and a time between `nbf` and `exp`. A
//! request without a valid JWT goes through the token rules as before.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::http::HeaderMap;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents};
use serde::Deserialize;

/// The header Cloudflare Access puts its JWT in.
pub const HEADER: &str = "cf-access-jwt-assertion";

/// How long fetched keys are used before they are fetched again.
const KEY_LIFETIME: Duration = Duration::from_secs(60 * 60);
/// The least time between two fetches of the keys, so tokens with unknown key ids cannot
/// make the server fetch them on every request.
const REFETCH_INTERVAL: Duration = Duration::from_secs(30);
/// Clock difference allowed when checking `exp` and `nbf`, in seconds.
const LEEWAY_SECONDS: i64 = 60;
/// The largest certificate list accepted, in bytes.
const MAX_CERTS_BYTES: usize = 64 * 1024;

/// Which Access application's JWTs the server accepts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessConfig {
    /// `https://<team domain>`, the `iss` of the team's JWTs.
    issuer: String,
    /// The application's AUD tag.
    audience: String,
}

impl AccessConfig {
    /// Reads the team domain (`myteam.cloudflareaccess.com`, optionally with `https://`)
    /// and the application's AUD tag.
    pub fn parse(team_domain: &str, audience: &str) -> Result<Self, String> {
        let trimmed = team_domain.trim();
        let host = trimmed.strip_prefix("https://").unwrap_or(trimmed);
        let host = host.strip_suffix('/').unwrap_or(host);
        let is_host = host.contains('.')
            && host.split('.').all(|label| {
                !label.is_empty() && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            });
        if !is_host {
            return Err(format!(
                "TOODO_CF_ACCESS_TEAM_DOMAIN {team_domain:?} is not a team domain such as \
                 myteam.cloudflareaccess.com"
            ));
        }
        let audience = audience.trim();
        if audience.is_empty() {
            return Err(
                "TOODO_CF_ACCESS_AUD is empty; set it to the Application Audience (AUD) tag of \
                 the Access application"
                    .to_owned(),
            );
        }
        Ok(Self {
            issuer: format!("https://{}", host.to_ascii_lowercase()),
            audience: audience.to_owned(),
        })
    }

    pub fn issuer(&self) -> &str {
        &self.issuer
    }

    fn certs_url(&self) -> String {
        format!("{}/cdn-cgi/access/certs", self.issuer)
    }
}

pub type FetchFuture<'a> = Pin<Box<dyn Future<Output = Result<Vec<u8>, String>> + Send + 'a>>;

/// Where the team's certificate list comes from.
pub trait KeySource: Send + Sync {
    fn fetch<'a>(&'a self, url: &'a str) -> FetchFuture<'a>;
}

/// Fetches the certificate list over HTTPS within five seconds, without redirects.
pub struct HttpKeySource {
    client: reqwest::Client,
}

impl HttpKeySource {
    pub fn new() -> Result<Self, reqwest::Error> {
        // reqwest uses the process-wide rustls provider; another one may already be set.
        drop(rustls::crypto::ring::default_provider().install_default());
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
        })
    }
}

impl KeySource for HttpKeySource {
    fn fetch<'a>(&'a self, url: &'a str) -> FetchFuture<'a> {
        Box::pin(async move {
            let mut response = self
                .client
                .get(url)
                .send()
                .await
                .map_err(|error| error.to_string())?;
            if !response.status().is_success() {
                return Err(format!("answered {}", response.status()));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
                if bytes.len() + chunk.len() > MAX_CERTS_BYTES {
                    return Err(format!("the list is over {MAX_CERTS_BYTES} bytes"));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(bytes)
        })
    }
}

/// Why a JWT is not accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    Malformed,
    Algorithm,
    UnknownKey,
    Signature,
    Issuer,
    Audience,
    Expired,
    NotYetValid,
}

/// An RSA public key of the certificate list.
#[derive(Debug, Clone)]
struct Key {
    n: Vec<u8>,
    e: Vec<u8>,
}

#[derive(Default)]
struct Keys {
    by_id: HashMap<String, Key>,
    /// When the keys were last fetched successfully.
    fetched: Option<Instant>,
    /// When a fetch was last tried.
    tried: Option<Instant>,
}

/// Checks Access JWTs against the team's keys, which it fetches when they are older than
/// [`KEY_LIFETIME`] or a JWT names a key it does not know.
pub struct Verifier {
    config: AccessConfig,
    source: Arc<dyn KeySource>,
    keys: tokio::sync::Mutex<Keys>,
}

impl Verifier {
    pub fn new(config: AccessConfig, source: Arc<dyn KeySource>) -> Self {
        Self {
            config,
            source,
            keys: tokio::sync::Mutex::new(Keys::default()),
        }
    }

    /// Whether `headers` carry a valid Access JWT.
    pub async fn admits(&self, headers: &HeaderMap) -> bool {
        let Some(token) = headers.get(HEADER).and_then(|value| value.to_str().ok()) else {
            return false;
        };
        self.verify(token, unix_now()).await.is_ok()
    }

    async fn verify(&self, token: &str, now: i64) -> Result<(), Rejection> {
        let jwt = Jwt::parse(token)?;
        let key = self.key(&jwt.kid).await.ok_or(Rejection::UnknownKey)?;
        RsaPublicKeyComponents {
            n: &key.n,
            e: &key.e,
        }
        .verify(
            &RSA_PKCS1_2048_8192_SHA256,
            jwt.signed.as_bytes(),
            &jwt.signature,
        )
        .map_err(|_| Rejection::Signature)?;
        jwt.claims.check(&self.config, now)
    }

    /// The key `kid`, fetching the keys first when they are stale or do not have it.
    async fn key(&self, kid: &str) -> Option<Key> {
        let mut keys = self.keys.lock().await;
        let stale = keys
            .fetched
            .is_none_or(|fetched| fetched.elapsed() >= KEY_LIFETIME);
        let may_fetch = keys
            .tried
            .is_none_or(|tried| tried.elapsed() >= REFETCH_INTERVAL);
        if (stale || !keys.by_id.contains_key(kid)) && may_fetch {
            keys.tried = Some(Instant::now());
            let url = self.config.certs_url();
            match self
                .source
                .fetch(&url)
                .await
                .and_then(|body| parse_keys(&body))
            {
                Ok(by_id) => {
                    keys.by_id = by_id;
                    keys.fetched = Some(Instant::now());
                }
                // The keys fetched before stay in use: Cloudflare keeps a replaced key
                // valid for a while.
                Err(error) => {
                    eprintln!(
                        "toodo-server: cannot fetch the Cloudflare Access keys from {url}: {error}"
                    );
                }
            }
        }
        keys.by_id.get(kid).cloned()
    }
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX)
        })
}

/// The RSA keys of a certificate list (`{"keys": [{"kid", "kty", "n", "e"}, ...]}`) by id.
fn parse_keys(body: &[u8]) -> Result<HashMap<String, Key>, String> {
    #[derive(Deserialize)]
    struct Jwk {
        kid: Option<String>,
        kty: String,
        n: Option<String>,
        e: Option<String>,
    }
    #[derive(Deserialize)]
    struct Jwks {
        keys: Vec<Jwk>,
    }
    let jwks: Jwks = serde_json::from_slice(body)
        .map_err(|error| format!("the certificate list is not a JSON Web Key Set: {error}"))?;
    let mut keys = HashMap::new();
    for jwk in jwks.keys {
        let (Some(kid), "RSA", Some(n), Some(e)) = (jwk.kid, jwk.kty.as_str(), jwk.n, jwk.e) else {
            continue;
        };
        let (Ok(n), Ok(e)) = (URL_SAFE_NO_PAD.decode(n), URL_SAFE_NO_PAD.decode(e)) else {
            continue;
        };
        keys.insert(kid, Key { n, e });
    }
    Ok(keys)
}

struct Jwt {
    kid: String,
    /// `<header>.<claims>`, what the signature covers.
    signed: String,
    signature: Vec<u8>,
    claims: Claims,
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    kid: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Audience {
    One(String),
    Many(Vec<String>),
}

#[derive(Deserialize)]
struct Claims {
    iss: String,
    aud: Audience,
    exp: i64,
    nbf: Option<i64>,
}

impl Jwt {
    fn parse(token: &str) -> Result<Self, Rejection> {
        let mut parts = token.trim().split('.');
        let (Some(header), Some(claims), Some(signature), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(Rejection::Malformed);
        };
        let decode = |part: &str| {
            URL_SAFE_NO_PAD
                .decode(part)
                .map_err(|_| Rejection::Malformed)
        };
        let parsed: Header =
            serde_json::from_slice(&decode(header)?).map_err(|_| Rejection::Malformed)?;
        if parsed.alg != "RS256" {
            return Err(Rejection::Algorithm);
        }
        let kid = parsed.kid.ok_or(Rejection::UnknownKey)?;
        Ok(Self {
            kid,
            signed: format!("{header}.{claims}"),
            signature: decode(signature)?,
            claims: serde_json::from_slice(&decode(claims)?).map_err(|_| Rejection::Malformed)?,
        })
    }
}

impl Claims {
    fn check(&self, config: &AccessConfig, now: i64) -> Result<(), Rejection> {
        if self.iss != config.issuer {
            return Err(Rejection::Issuer);
        }
        let audience = match &self.aud {
            Audience::One(one) => one == &config.audience,
            Audience::Many(many) => many.contains(&config.audience),
        };
        if !audience {
            return Err(Rejection::Audience);
        }
        if now >= self.exp.saturating_add(LEEWAY_SECONDS) {
            return Err(Rejection::Expired);
        }
        if self
            .nbf
            .is_some_and(|nbf| now < nbf.saturating_sub(LEEWAY_SECONDS))
        {
            return Err(Rejection::NotYetValid);
        }
        Ok(())
    }
}

#[cfg(test)]
pub(super) mod testing {
    //! A team with one signing key, for tests of the server.
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use ring::rand::SystemRandom;
    use ring::signature::{RSA_PKCS1_SHA256, RsaKeyPair};

    use super::*;

    pub const TEAM: &str = "toodo-test.cloudflareaccess.com";
    pub const AUD: &str = "test-aud";
    pub const KID: &str = "test-kid";

    fn key_pair() -> RsaKeyPair {
        RsaKeyPair::from_pkcs8(include_bytes!("access-test-key.pk8")).unwrap()
    }

    /// Serves `body` as the certificate list and counts the fetches.
    pub struct FakeKeys {
        pub body: Mutex<Vec<u8>>,
        pub fetches: AtomicUsize,
    }

    impl KeySource for FakeKeys {
        fn fetch<'a>(&'a self, url: &'a str) -> FetchFuture<'a> {
            assert_eq!(url, format!("https://{TEAM}/cdn-cgi/access/certs"));
            self.fetches.fetch_add(1, Ordering::SeqCst);
            let body = self.body.lock().unwrap().clone();
            Box::pin(async move { Ok(body) })
        }
    }

    /// The certificate list with the test key under `kid`.
    pub fn certs(kid: &str) -> Vec<u8> {
        let public: RsaPublicKeyComponents<Vec<u8>> = key_pair().public().into();
        serde_json::json!({ "keys": [{
            "kid": kid,
            "kty": "RSA",
            "alg": "RS256",
            "use": "sig",
            "n": URL_SAFE_NO_PAD.encode(&public.n),
            "e": URL_SAFE_NO_PAD.encode(&public.e),
        }]})
        .to_string()
        .into_bytes()
    }

    pub fn keys() -> Arc<FakeKeys> {
        Arc::new(FakeKeys {
            body: Mutex::new(certs(KID)),
            fetches: AtomicUsize::new(0),
        })
    }

    pub fn verifier(keys: Arc<FakeKeys>) -> Verifier {
        Verifier::new(AccessConfig::parse(TEAM, AUD).unwrap(), keys)
    }

    /// A JWT with `claims`, signed with the test key under `kid`.
    pub fn token(kid: &str, claims: &serde_json::Value) -> String {
        let header = serde_json::json!({ "alg": "RS256", "kid": kid, "typ": "JWT" });
        let signed = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header.to_string()),
            URL_SAFE_NO_PAD.encode(claims.to_string())
        );
        let pair = key_pair();
        let mut signature = vec![0; pair.public().modulus_len()];
        pair.sign(
            &RSA_PKCS1_SHA256,
            &SystemRandom::new(),
            signed.as_bytes(),
            &mut signature,
        )
        .unwrap();
        format!("{signed}.{}", URL_SAFE_NO_PAD.encode(signature))
    }

    /// The claims of a JWT Access issues for the test application at `now`.
    pub fn claims(now: i64) -> serde_json::Value {
        serde_json::json!({
            "iss": format!("https://{TEAM}"),
            "aud": [AUD],
            "email": "owner@example.com",
            "sub": "owner",
            "iat": now,
            "nbf": now,
            "exp": now + 3600,
        })
    }

    pub fn valid_token() -> String {
        token(KID, &claims(unix_now()))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use super::testing::*;
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn check(token: &str) -> Result<(), Rejection> {
        let verifier = verifier(keys());
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(verifier.verify(token, NOW))
    }

    fn with(change: impl FnOnce(&mut serde_json::Value)) -> String {
        let mut claims = claims(NOW);
        change(&mut claims);
        token(KID, &claims)
    }

    #[test]
    fn a_jwt_of_the_team_for_the_application_is_accepted() {
        assert_eq!(check(&token(KID, &claims(NOW))), Ok(()));
        assert_eq!(check(&with(|claims| claims["aud"] = AUD.into())), Ok(()));
        // Within the leeway for clocks that differ.
        assert_eq!(
            check(&with(|claims| claims["exp"] = (NOW - 30).into())),
            Ok(())
        );
        assert_eq!(
            check(&with(|claims| claims["nbf"] = (NOW + 30).into())),
            Ok(())
        );
    }

    #[test]
    fn other_issuers_audiences_and_times_are_rejected() {
        let issuer = with(|claims| claims["iss"] = "https://other.cloudflareaccess.com".into());
        assert_eq!(check(&issuer), Err(Rejection::Issuer));
        let audience = with(|claims| claims["aud"] = serde_json::json!(["other-aud"]));
        assert_eq!(check(&audience), Err(Rejection::Audience));
        let expired = with(|claims| claims["exp"] = (NOW - 61).into());
        assert_eq!(check(&expired), Err(Rejection::Expired));
        let early = with(|claims| claims["nbf"] = (NOW + 61).into());
        assert_eq!(check(&early), Err(Rejection::NotYetValid));
        let no_expiry = with(|claims| drop(claims.as_object_mut().unwrap().remove("exp")));
        assert_eq!(check(&no_expiry), Err(Rejection::Malformed));
    }

    #[test]
    fn forged_and_malformed_jwts_are_rejected() {
        let valid = token(KID, &claims(NOW));
        let (signed, signature) = valid.rsplit_once('.').unwrap();
        // Claims changed after signing.
        let (header, _) = signed.split_once('.').unwrap();
        let other = with(|claims| claims["aud"] = serde_json::json!(["other-aud", AUD]));
        let other_claims = other.split('.').nth(1).unwrap();
        assert_eq!(
            check(&format!("{header}.{other_claims}.{signature}")),
            Err(Rejection::Signature)
        );
        let mut flipped = URL_SAFE_NO_PAD.decode(signature).unwrap();
        flipped[0] ^= 1;
        assert_eq!(
            check(&format!("{signed}.{}", URL_SAFE_NO_PAD.encode(flipped))),
            Err(Rejection::Signature)
        );
        assert_eq!(
            check(&token("other-kid", &claims(NOW))),
            Err(Rejection::UnknownKey)
        );
        let none = format!(
            "{}.{}.",
            URL_SAFE_NO_PAD.encode(r#"{"alg":"none","kid":"test-kid"}"#),
            signed.split_once('.').unwrap().1
        );
        assert_eq!(check(&none), Err(Rejection::Algorithm));
        for malformed in ["", "a.b", "a.b.c.d", "!!.!!.!!", &format!("{signed}.%%")] {
            assert_eq!(check(malformed), Err(Rejection::Malformed), "{malformed}");
        }
    }

    #[test]
    fn keys_are_cached_and_fetched_again_for_an_unknown_key_id_at_most_every_30_seconds() {
        let keys = keys();
        let verifier = verifier(keys.clone());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let verify = |token: &str| runtime.block_on(verifier.verify(token, NOW));
        assert_eq!(verify(&token(KID, &claims(NOW))), Ok(()));
        assert_eq!(verify(&token(KID, &claims(NOW))), Ok(()));
        assert_eq!(keys.fetches.load(Ordering::SeqCst), 1);
        // A rotated key is not fetched again right away.
        *keys.body.lock().unwrap() = certs("rotated-kid");
        assert_eq!(
            verify(&token("rotated-kid", &claims(NOW))),
            Err(Rejection::UnknownKey)
        );
        assert_eq!(keys.fetches.load(Ordering::SeqCst), 1);
        // Once the interval passed, an unknown key id fetches the list again.
        runtime.block_on(verifier.keys.lock()).tried = Some(Instant::now() - REFETCH_INTERVAL);
        assert_eq!(verify(&token("rotated-kid", &claims(NOW))), Ok(()));
        assert_eq!(keys.fetches.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn the_team_domain_is_a_host_name() {
        let config = |team: &str| AccessConfig::parse(team, AUD).map(|config| config.issuer);
        assert_eq!(
            config("Team.cloudflareaccess.com").unwrap(),
            "https://team.cloudflareaccess.com"
        );
        assert_eq!(
            config("https://team.cloudflareaccess.com/").unwrap(),
            "https://team.cloudflareaccess.com"
        );
        for bad in [
            "",
            "team",
            "http://team.cloudflareaccess.com",
            "team.cloudflareaccess.com/path",
            "a..b",
        ] {
            assert!(config(bad).is_err(), "{bad}");
        }
        assert!(AccessConfig::parse(TEAM, " ").is_err());
    }

    #[test]
    fn only_the_rsa_keys_of_the_list_are_kept() {
        let keys = parse_keys(
            br#"{"keys":[{"kid":"a","kty":"EC","x":"AA","y":"AA"},{"kty":"RSA","n":"AQ","e":"AQAB"},{"kid":"b","kty":"RSA","n":"AQ","e":"AQAB"}],"public_cert":{}}"#,
        )
        .unwrap();
        assert_eq!(keys.keys().collect::<Vec<_>>(), ["b"]);
        assert!(parse_keys(b"<html>").is_err());
    }
}
