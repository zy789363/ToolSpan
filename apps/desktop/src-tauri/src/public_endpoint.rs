use std::fs;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::path::Path;
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use reqwest::header::LOCATION;
use reqwest::redirect::Policy;
use serde::Serialize;
use serde_json::Value;
use thiserror::Error;
use url::Url;

const MAX_REDIRECTS: usize = 3;
const MAX_RESPONSE_BODY_BYTES: u64 = 128 * 1024;
const MAX_RESPONSE_HEADER_BYTES: usize = 64 * 1024;
const MAX_LOCATION_BYTES: usize = 4096;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PublicEndpointError {
    #[error("configured publicBaseUrl is unavailable")]
    NotConfigured,
    #[error("public endpoint must use HTTPS")]
    HttpsRequired,
    #[error("public endpoint must not contain userinfo")]
    UserInfo,
    #[error("public endpoint must be an origin without query or fragment")]
    InvalidBaseUrl,
    #[error("public endpoint resolved to a private, loopback, reserved, or unroutable address")]
    NonPublicAddress,
    #[error("public endpoint DNS resolution failed")]
    Dns,
    #[error("public endpoint request failed")]
    Request,
    #[error("public endpoint attempted a HTTPS to HTTP downgrade")]
    Downgrade,
    #[error("public endpoint attempted a cross-origin redirect")]
    CrossOriginRedirect,
    #[error("public endpoint exceeded the redirect limit")]
    RedirectLimit,
    #[error("public endpoint response headers exceeded the safety limit")]
    HeadersTooLarge,
    #[error("public endpoint response body exceeded the safety limit")]
    BodyTooLarge,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicEndpointResult {
    pub checked_url: String,
    pub ok: bool,
    pub status_code: u16,
    pub latency_ms: u128,
    pub redirects: usize,
    pub response_bytes: u64,
}

pub fn configured_public_base_url(config_path: &Path) -> Result<Url, PublicEndpointError> {
    let bytes = fs::read(config_path).map_err(|_| PublicEndpointError::NotConfigured)?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| PublicEndpointError::NotConfigured)?;
    let raw = value
        .get("publicBaseUrl")
        .and_then(Value::as_str)
        .ok_or(PublicEndpointError::NotConfigured)?;
    validate_public_base_url(raw)
}

pub fn validate_public_base_url(raw: &str) -> Result<Url, PublicEndpointError> {
    let url = Url::parse(raw).map_err(|_| PublicEndpointError::InvalidBaseUrl)?;
    if url.scheme() != "https" {
        return Err(PublicEndpointError::HttpsRequired);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(PublicEndpointError::UserInfo);
    }
    if url.host_str().is_none()
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(PublicEndpointError::InvalidBaseUrl);
    }
    Ok(url)
}

pub fn test_configured_public_endpoint(
    config_path: &Path,
) -> Result<PublicEndpointResult, PublicEndpointError> {
    let base = configured_public_base_url(config_path)?;
    let health_url = base
        .join("healthz")
        .map_err(|_| PublicEndpointError::InvalidBaseUrl)?;
    test_same_origin_https(health_url, &base)
}

fn test_same_origin_https(
    mut current: Url,
    configured_base: &Url,
) -> Result<PublicEndpointResult, PublicEndpointError> {
    let start = Instant::now();
    for redirect_count in 0..=MAX_REDIRECTS {
        validate_redirect_target(&current, configured_base)?;
        let addresses = resolve_public_addresses(&current)?;
        let host = current
            .host_str()
            .ok_or(PublicEndpointError::InvalidBaseUrl)?;
        let client = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .resolve_to_addrs(host, &addresses)
            .build()
            .map_err(|_| PublicEndpointError::Request)?;
        let mut response = client
            .get(current.clone())
            .send()
            .map_err(|_| PublicEndpointError::Request)?;
        validate_header_size(response.headers())?;

        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Err(PublicEndpointError::RedirectLimit);
            }
            let location = response
                .headers()
                .get(LOCATION)
                .ok_or(PublicEndpointError::Request)?
                .to_str()
                .map_err(|_| PublicEndpointError::Request)?;
            if location.len() > MAX_LOCATION_BYTES {
                return Err(PublicEndpointError::HeadersTooLarge);
            }
            current = current
                .join(location)
                .map_err(|_| PublicEndpointError::Request)?;
            continue;
        }

        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BODY_BYTES)
        {
            return Err(PublicEndpointError::BodyTooLarge);
        }
        let mut body = (&mut response).take(MAX_RESPONSE_BODY_BYTES + 1);
        let response_bytes = std::io::copy(&mut body, &mut std::io::sink())
            .map_err(|_| PublicEndpointError::Request)?;
        if response_bytes > MAX_RESPONSE_BODY_BYTES {
            return Err(PublicEndpointError::BodyTooLarge);
        }
        let status = response.status();
        return Ok(PublicEndpointResult {
            checked_url: current.to_string(),
            ok: status.is_success(),
            status_code: status.as_u16(),
            latency_ms: start.elapsed().as_millis(),
            redirects: redirect_count,
            response_bytes,
        });
    }
    Err(PublicEndpointError::RedirectLimit)
}

fn validate_redirect_target(
    candidate: &Url,
    configured_base: &Url,
) -> Result<(), PublicEndpointError> {
    if candidate.scheme() != "https" {
        return Err(PublicEndpointError::Downgrade);
    }
    if !candidate.username().is_empty() || candidate.password().is_some() {
        return Err(PublicEndpointError::UserInfo);
    }
    if candidate.origin() != configured_base.origin() {
        return Err(PublicEndpointError::CrossOriginRedirect);
    }
    Ok(())
}

fn resolve_public_addresses(url: &Url) -> Result<Vec<SocketAddr>, PublicEndpointError> {
    let host = url.host_str().ok_or(PublicEndpointError::InvalidBaseUrl)?;
    let port = url
        .port_or_known_default()
        .ok_or(PublicEndpointError::InvalidBaseUrl)?;
    let addresses: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|_| PublicEndpointError::Dns)?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(PublicEndpointError::NonPublicAddress);
    }
    Ok(addresses)
}

pub fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    !(address.is_unspecified()
        || address.is_loopback()
        || address.is_private()
        || address.is_link_local()
        || address.is_broadcast()
        || address.is_documentation()
        || address.is_multicast()
        || octets[0] == 0
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 198 && (18..=19).contains(&octets[1]))
        || octets[0] >= 240)
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return is_public_ipv4(mapped);
    }
    let segments = address.segments();
    !(address.is_unspecified()
        || address.is_loopback()
        || address.is_multicast()
        || address.is_unique_local()
        || address.is_unicast_link_local()
        || (segments[0] & 0xffc0) == 0xfec0
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || (segments[0] == 0x0100 && segments[1] == 0 && segments[2] == 0 && segments[3] == 0))
}

fn validate_header_size(headers: &reqwest::header::HeaderMap) -> Result<(), PublicEndpointError> {
    let size = headers.iter().fold(0_usize, |total, (name, value)| {
        total
            .saturating_add(name.as_str().len())
            .saturating_add(value.as_bytes().len())
            .saturating_add(4)
    });
    if size > MAX_RESPONSE_HEADER_BYTES {
        Err(PublicEndpointError::HeadersTooLarge)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_base_requires_clean_https_origin() {
        assert!(validate_public_base_url("https://mcp.example.com").is_ok());
        assert_eq!(
            validate_public_base_url("http://mcp.example.com"),
            Err(PublicEndpointError::HttpsRequired)
        );
        assert_eq!(
            validate_public_base_url("https://user:pass@mcp.example.com"),
            Err(PublicEndpointError::UserInfo)
        );
        assert_eq!(
            validate_public_base_url("https://mcp.example.com/arbitrary"),
            Err(PublicEndpointError::InvalidBaseUrl)
        );
    }

    #[test]
    fn private_loopback_reserved_and_documentation_addresses_are_rejected() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "100.64.0.1",
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
        ] {
            let address: IpAddr = address.parse().expect("fixture IP");
            assert!(!is_public_ip(address), "{address}");
        }
        assert!(is_public_ip("1.1.1.1".parse().expect("public IP")));
        assert!(is_public_ip(
            "2606:4700:4700::1111".parse().expect("public IP")
        ));
    }

    #[test]
    fn redirect_policy_rejects_downgrade_cross_origin_and_userinfo() {
        let configured = Url::parse("https://mcp.example.com").expect("configured URL");
        assert!(
            validate_redirect_target(
                &Url::parse("https://mcp.example.com/healthz").expect("same origin"),
                &configured
            )
            .is_ok()
        );
        assert_eq!(
            validate_redirect_target(
                &Url::parse("http://mcp.example.com/healthz").expect("downgrade"),
                &configured
            ),
            Err(PublicEndpointError::Downgrade)
        );
        assert_eq!(
            validate_redirect_target(
                &Url::parse("https://other.example/healthz").expect("cross origin"),
                &configured
            ),
            Err(PublicEndpointError::CrossOriginRedirect)
        );
    }

    #[test]
    fn endpoint_is_loaded_only_from_the_current_config_file() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("toolspan.config.json");
        fs::write(&path, br#"{"publicBaseUrl":"https://mcp.example.com"}"#).expect("write config");
        assert_eq!(
            configured_public_base_url(&path)
                .expect("configured URL")
                .as_str(),
            "https://mcp.example.com/"
        );
    }
}
