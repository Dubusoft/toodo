//! Outbound HTTP to addresses that come from outside the server (client metadata
//! documents, push service endpoints, URL criteria) reaches only the public internet, never
//! the server itself or its private network.

use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

/// A client that reaches only public addresses, without following redirects or using a
/// proxy from the environment, and gives up after `timeout`. Callers also check
/// [`literal_ip`].
pub(crate) fn public_client(timeout: Duration) -> reqwest::Result<reqwest::Client> {
    client_builder(timeout).dns_resolver(PublicOnly).build()
}

fn client_builder(timeout: Duration) -> reqwest::ClientBuilder {
    // reqwest uses the process-wide rustls provider; another one may already be set.
    drop(rustls::crypto::ring::default_provider().install_default());
    reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
}

/// GETs URLs that come from outside the server, from public addresses only.
pub(crate) struct Outbound {
    client: reqwest::Client,
    any_address: bool,
}

impl Outbound {
    /// A client that reaches only public addresses and gives up after `timeout`.
    pub(crate) fn public(timeout: Duration) -> reqwest::Result<Self> {
        Ok(Self {
            client: public_client(timeout)?,
            any_address: false,
        })
    }

    /// A client that also reaches loopback and private addresses, for tests against a local
    /// server.
    #[cfg(test)]
    pub(crate) fn any_address(timeout: Duration) -> reqwest::Result<Self> {
        Ok(Self {
            client: client_builder(timeout).build()?,
            any_address: true,
        })
    }

    /// Sends a GET to `url`. A redirect is returned as the response, not followed.
    pub(crate) async fn get(&self, url: &str) -> Result<reqwest::Response, Error> {
        let literal = reqwest::Url::parse(url).ok().as_ref().and_then(literal_ip);
        if !self.any_address && literal.is_some_and(|ip| !is_public(ip)) {
            return Err(Error::NotPublic);
        }
        Ok(self.client.get(url).send().await?)
    }
}

/// Why a GET of a URL from outside the server failed.
#[derive(Debug)]
pub(crate) enum Error {
    /// The URL names a loopback, private, link-local, or otherwise reserved address.
    NotPublic,
    Http(reqwest::Error),
}

impl From<reqwest::Error> for Error {
    fn from(error: reqwest::Error) -> Self {
        Self::Http(error)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotPublic => f.write_str("the URL names an address that is not public"),
            Self::Http(error) => error.fmt(f),
        }
    }
}

/// Resolves names only to public addresses. An address written in the URL skips the
/// resolver, so callers also check [`literal_ip`].
pub(crate) struct PublicOnly;

impl reqwest::dns::Resolve for PublicOnly {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addresses = public_addresses(&host).await?;
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// The public addresses `host` resolves to; an error when it has none.
pub(crate) async fn public_addresses(
    host: &str,
) -> Result<Vec<SocketAddr>, Box<dyn std::error::Error + Send + Sync>> {
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, 0))
        .await?
        .filter(|address| is_public(address.ip()))
        .collect();
    if addresses.is_empty() {
        return Err(format!("{host} has no public address").into());
    }
    Ok(addresses)
}

/// The IP address a URL names as its host, if it names one rather than a host name.
pub(crate) fn literal_ip(url: &reqwest::Url) -> Option<IpAddr> {
    url.host_str()
        .and_then(|host| host.trim_matches(['[', ']']).parse::<IpAddr>().ok())
}

/// Whether `ip` is reachable on the public internet, not loopback, private, link-local,
/// shared (CGNAT), or otherwise reserved.
pub(crate) fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, ..] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_multicast()
                || a == 0
                || (a == 100 && b & 0xc0 == 64))
        }
        IpAddr::V6(ip) => match ip.to_ipv4_mapped() {
            Some(ip) => is_public(IpAddr::V4(ip)),
            None => {
                let first = ip.segments()[0];
                !(ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_multicast()
                    || first & 0xfe00 == 0xfc00
                    || first & 0xffc0 == 0xfe80)
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_public_addresses_count_as_public() {
        for public in ["93.184.216.34", "2606:4700::1111", "::ffff:93.184.216.34"] {
            assert!(is_public(public.parse().unwrap()), "{public}");
        }
        for private in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fd00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!is_public(private.parse().unwrap()), "{private}");
        }
    }

    #[test]
    fn host_names_resolving_only_to_private_addresses_are_refused() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert!(runtime.block_on(public_addresses("localhost")).is_err());
    }

    #[test]
    fn private_address_literals_are_not_requested() {
        let outbound = Outbound::public(Duration::from_secs(5)).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for url in [
            "http://127.0.0.1/ready",
            "http://2130706433/ready",
            "http://[::1]/ready",
            "http://[::ffff:10.0.0.1]/ready",
            "http://169.254.169.254/latest/meta-data/",
        ] {
            assert!(
                matches!(runtime.block_on(outbound.get(url)), Err(Error::NotPublic)),
                "{url}"
            );
        }
    }
}
