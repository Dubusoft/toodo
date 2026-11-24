//! Outbound HTTP to addresses that come from outside the server (client metadata
//! documents, push service endpoints) reaches only the public internet, never the server
//! itself or its private network.

use std::net::{IpAddr, SocketAddr};

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
}
