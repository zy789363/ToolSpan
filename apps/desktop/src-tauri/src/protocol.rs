use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use url::Url;
use zeroize::Zeroize;

pub const DESKTOP_PROTOCOL_VERSION: u64 = 1;
pub const MAX_PROTOCOL_MESSAGE_BYTES: usize = 1024 * 1024;
pub const MAX_REQUEST_ID_BYTES: usize = 128;

pub const ALLOWED_METHODS: [&str; 21] = [
    "system.hello",
    "runtime.getSnapshot",
    "runtime.start",
    "runtime.stop",
    "runtime.restart",
    "runtime.validateConfig",
    "runtime.getConfigSummary",
    "runtime.listJobs",
    "runtime.cancelJob",
    "runtime.listArtifacts",
    "runtime.getLogChunk",
    "runtime.subscribeEvents",
    "connection.testLocal",
    "connection.testPublic",
    "setup.getSnapshot",
    "setup.preflight",
    "setup.plan",
    "setup.apply",
    "setup.rollback",
    "setup.reconcile",
    "setup.discardCredential",
];

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopRequest {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

impl Drop for DesktopRequest {
    fn drop(&mut self) {
        self.id.zeroize();
        self.method.zeroize();
        zeroize_json_value(&mut self.params);
    }
}

fn zeroize_json_value(value: &mut Value) {
    match value {
        Value::String(text) => text.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(zeroize_json_value),
        Value::Object(object) => object.values_mut().for_each(zeroize_json_value),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("request exceeds the 1 MiB desktop protocol limit")]
    Oversize,
    #[error("request id must be a non-empty string of at most 128 UTF-8 bytes")]
    InvalidRequestId,
    #[error("request method is not part of desktop protocol v1")]
    UnknownMethod,
    #[error("desktop protocol version 1 is required")]
    ProtocolVersionMismatch,
    #[error("desktop product version {0} is required")]
    ProductVersionMismatch(String),
    #[error("connection tests do not accept a caller-provided URL")]
    CallerProvidedUrl,
    #[error("request id has already been used for this host process")]
    DuplicateRequestId,
    #[error("too many request ids were used for one host process")]
    RequestIdCapacity,
    #[error("request parameters do not match the desktop protocol method")]
    InvalidParams,
}

impl DesktopRequest {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        let encoded = serde_json::to_vec(self).map_err(|_| ProtocolError::Oversize)?;
        if encoded.len() > MAX_PROTOCOL_MESSAGE_BYTES {
            return Err(ProtocolError::Oversize);
        }
        if self.id.is_empty()
            || self.id.len() > MAX_REQUEST_ID_BYTES
            || self.id.chars().any(char::is_control)
        {
            return Err(ProtocolError::InvalidRequestId);
        }
        if !ALLOWED_METHODS.contains(&self.method.as_str()) {
            return Err(ProtocolError::UnknownMethod);
        }
        if self.method == "system.hello" {
            self.validate_hello()?;
        }
        if self.method.starts_with("setup.") {
            self.validate_setup_params()?;
        }
        if matches!(
            self.method.as_str(),
            "connection.testLocal" | "connection.testPublic"
        ) && contains_url_parameter(&self.params)
        {
            return Err(ProtocolError::CallerProvidedUrl);
        }
        Ok(())
    }

    fn validate_hello(&self) -> Result<(), ProtocolError> {
        let Some(params) = self.params.as_object() else {
            return Err(ProtocolError::ProtocolVersionMismatch);
        };
        if params.get("protocolVersion").and_then(Value::as_u64) != Some(DESKTOP_PROTOCOL_VERSION) {
            return Err(ProtocolError::ProtocolVersionMismatch);
        }
        if let Some(product_version) = params.get("productVersion") {
            if product_version.as_str() != Some(env!("CARGO_PKG_VERSION")) {
                return Err(ProtocolError::ProductVersionMismatch(
                    env!("CARGO_PKG_VERSION").to_owned(),
                ));
            }
        }
        Ok(())
    }

    fn validate_setup_params(&self) -> Result<(), ProtocolError> {
        let Some(params) = self.params.as_object() else {
            return Err(ProtocolError::InvalidParams);
        };
        let valid = match self.method.as_str() {
            "setup.getSnapshot" => {
                has_only_keys(params, &["sessionId"])
                    && params.get("sessionId").is_none_or(is_setup_id_value)
            }
            "setup.preflight" => {
                has_only_keys(
                    params,
                    &[
                        "sessionId",
                        "idempotencyKey",
                        "zoneName",
                        "manifest",
                        "credential",
                    ],
                ) && params.get("sessionId").is_some_and(is_setup_id_value)
                    && params.get("idempotencyKey").is_some_and(is_setup_id_value)
                    && params.get("zoneName").is_some_and(is_domain_name_value)
                    && params.get("manifest").is_some_and(is_setup_manifest)
                    && params.get("credential").is_none_or(is_setup_credential)
            }
            "setup.plan" | "setup.discardCredential" => {
                has_only_keys(params, &["sessionId"])
                    && params.get("sessionId").is_some_and(is_setup_id_value)
            }
            "setup.apply" => {
                has_only_keys(params, &["sessionId", "confirmation", "credential"])
                    && params.get("sessionId").is_some_and(is_setup_id_value)
                    && params.get("confirmation").and_then(Value::as_str) == Some("APPLY")
                    && params.get("credential").is_none_or(is_setup_credential)
            }
            "setup.rollback" => {
                has_only_keys(params, &["sessionId", "confirmation", "credential"])
                    && params.get("sessionId").is_some_and(is_setup_id_value)
                    && params.get("confirmation").and_then(Value::as_str) == Some("ROLLBACK")
                    && params.get("credential").is_none_or(is_setup_credential)
            }
            "setup.reconcile" => {
                has_only_keys(params, &["sessionId", "credential"])
                    && params.get("sessionId").is_some_and(is_setup_id_value)
                    && params.get("credential").is_none_or(is_setup_credential)
            }
            _ => false,
        };
        valid.then_some(()).ok_or(ProtocolError::InvalidParams)
    }
}

fn has_only_keys(object: &serde_json::Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().all(|key| allowed.contains(&key.as_str()))
}

fn is_bounded_string(value: &Value, maximum: usize) -> bool {
    value
        .as_str()
        .is_some_and(|text| !text.is_empty() && text.len() <= maximum)
}

fn is_setup_id_value(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        (8..=128).contains(&text.len())
            && text.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
            })
    })
}

fn is_domain_name_value(value: &Value) -> bool {
    value.as_str().is_some_and(is_domain_name)
}

fn is_domain_name(domain: &str) -> bool {
    domain == domain.to_ascii_lowercase()
        && !domain.ends_with('.')
        && domain.len() <= 253
        && domain.split('.').count() >= 2
        && domain.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && label
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '-')
                && label
                    .chars()
                    .next()
                    .is_some_and(|character| character.is_ascii_alphanumeric())
                && label
                    .chars()
                    .next_back()
                    .is_some_and(|character| character.is_ascii_alphanumeric())
        })
}

fn is_setup_credential(value: &Value) -> bool {
    const GLOBAL_ACKNOWLEDGEMENT: &str = "I UNDERSTAND GLOBAL API KEY ACCESS";
    let Some(object) = value.as_object() else {
        return false;
    };
    match object.get("kind").and_then(Value::as_str) {
        Some("api_token") => {
            has_only_keys(object, &["kind", "token"])
                && object.get("token").is_some_and(|token| {
                    is_bounded_string(token, 65_536)
                        && token.as_str().is_some_and(|text| text.trim() == text)
                })
        }
        Some("global_api_key") => {
            has_only_keys(object, &["kind", "email", "key", "acknowledgement"])
                && object.get("email").is_some_and(|email| {
                    is_bounded_string(email, 254)
                        && email.as_str().is_some_and(|text| {
                            if text.chars().any(char::is_whitespace) {
                                return false;
                            }
                            let mut parts = text.split('@');
                            matches!(
                                (parts.next(), parts.next(), parts.next()),
                                (Some(local), Some(domain), None)
                                    if !local.is_empty() && !domain.is_empty()
                            )
                        })
                })
                && object.get("key").is_some_and(|key| {
                    is_bounded_string(key, 65_536)
                        && key.as_str().is_some_and(|text| text.trim() == text)
                })
                && object.get("acknowledgement").and_then(Value::as_str)
                    == Some(GLOBAL_ACKNOWLEDGEMENT)
        }
        _ => false,
    }
}

fn is_setup_manifest(value: &Value) -> bool {
    const FIELDS: &[&str] = &[
        "schemaVersion",
        "toolSpanVersion",
        "instanceName",
        "localUrl",
        "desiredHostname",
        "publicMcpUrl",
        "oauthDiscoveryUrl",
        "expectedToolCount",
        "tunnelName",
        "domainChoice",
        "officialDocs",
        "generatedAt",
    ];
    let Some(object) = value.as_object() else {
        return false;
    };
    let Some(instance_name) = object.get("instanceName").and_then(Value::as_str) else {
        return false;
    };
    let Some(desired_hostname) = object.get("desiredHostname").and_then(Value::as_str) else {
        return false;
    };
    let Some(local_url) = object
        .get("localUrl")
        .and_then(Value::as_str)
        .and_then(parse_safe_url)
    else {
        return false;
    };
    let Some(public_mcp_url) = object
        .get("publicMcpUrl")
        .and_then(Value::as_str)
        .and_then(parse_safe_url)
    else {
        return false;
    };
    let Some(oauth_url) = object
        .get("oauthDiscoveryUrl")
        .and_then(Value::as_str)
        .and_then(parse_safe_url)
    else {
        return false;
    };
    has_only_keys(object, FIELDS)
        && object.get("schemaVersion").and_then(Value::as_str) == Some("1.0")
        && object.get("toolSpanVersion").and_then(Value::as_str) == Some(env!("CARGO_PKG_VERSION"))
        && !instance_name.is_empty()
        && instance_name.len() <= 80
        && !has_personal_path(instance_name)
        && local_url.scheme() == "http"
        && matches!(local_url.host_str(), Some("127.0.0.1" | "localhost"))
        && local_url.path() == "/"
        && local_url.query().is_none()
        && local_url.fragment().is_none()
        && is_domain_name(desired_hostname)
        && public_mcp_url.scheme() == "https"
        && public_mcp_url.host_str() == Some(desired_hostname)
        && public_mcp_url.port().is_none()
        && public_mcp_url.path() == "/mcp"
        && public_mcp_url.query().is_none()
        && public_mcp_url.fragment().is_none()
        && oauth_url.scheme() == "https"
        && oauth_url.host_str() == Some(desired_hostname)
        && oauth_url.port().is_none()
        && oauth_url.path() == "/.well-known/oauth-authorization-server"
        && oauth_url.query().is_none()
        && oauth_url.fragment().is_none()
        && object.get("expectedToolCount").and_then(Value::as_u64) == Some(27)
        && object
            .get("tunnelName")
            .and_then(Value::as_str)
            .is_some_and(|name| !name.is_empty() && name.len() <= 100 && !has_personal_path(name))
        && object
            .get("domainChoice")
            .and_then(Value::as_str)
            .is_some_and(|choice| {
                matches!(
                    choice,
                    "existing" | "other_registrar" | "namesilo_referral" | "namesilo_no_referral"
                )
            })
        && object
            .get("officialDocs")
            .and_then(Value::as_array)
            .is_some_and(|docs| valid_official_docs(docs))
        && object
            .get("generatedAt")
            .and_then(Value::as_str)
            .is_some_and(|value| OffsetDateTime::parse(value, &Rfc3339).is_ok())
}

fn parse_safe_url(value: &str) -> Option<Url> {
    if value.is_empty() || value.len() > 2_048 {
        return None;
    }
    let parsed = Url::parse(value).ok()?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    Some(parsed)
}

fn has_personal_path(value: &str) -> bool {
    let normalized = value.replace('\\', "/").to_ascii_lowercase();
    (normalized.len() >= 3 && normalized.as_bytes()[1] == b':' && normalized.as_bytes()[2] == b'/')
        || normalized.starts_with("users/")
        || normalized.contains("/users/")
}

fn valid_official_docs(docs: &[Value]) -> bool {
    if docs.is_empty() {
        return false;
    }
    let mut unique = HashSet::new();
    docs.iter().all(|value| {
        let Some(text) = value.as_str() else {
            return false;
        };
        if !unique.insert(text) {
            return false;
        }
        parse_safe_url(text).is_some_and(|url| {
            url.scheme() == "https"
                && url.port().is_none()
                && matches!(
                    url.host_str(),
                    Some("developers.cloudflare.com" | "developers.openai.com")
                )
        })
    })
}

fn contains_url_parameter(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, child)| {
            matches!(
                key.to_ascii_lowercase().as_str(),
                "url" | "uri" | "endpoint" | "baseurl" | "publicbaseurl"
            ) || contains_url_parameter(child)
        }),
        Value::Array(values) => values.iter().any(contains_url_parameter),
        _ => false,
    }
}

#[derive(Debug, Default)]
pub struct RequestIds {
    seen: HashSet<String>,
}

impl RequestIds {
    pub fn record(&mut self, id: &str) -> Result<(), ProtocolError> {
        const MAX_IDS_PER_HOST: usize = 65_536;
        if self.seen.contains(id) {
            return Err(ProtocolError::DuplicateRequestId);
        }
        if self.seen.len() >= MAX_IDS_PER_HOST {
            return Err(ProtocolError::RequestIdCapacity);
        }
        self.seen.insert(id.to_owned());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn exact_v1_method_allowlist_is_frozen() {
        assert_eq!(ALLOWED_METHODS.len(), 21);
        let request = DesktopRequest {
            id: "one".into(),
            method: "runtime.runShell".into(),
            params: json!({}),
        };
        assert_eq!(request.validate(), Err(ProtocolError::UnknownMethod));
    }

    #[test]
    fn setup_methods_require_exact_safe_parameters() {
        let apply = DesktopRequest {
            id: "apply".into(),
            method: "setup.apply".into(),
            params: json!({
                "sessionId": "setup-001",
                "confirmation": "APPLY",
                "credential": {"kind": "api_token", "token": "fixture-token"}
            }),
        };
        assert_eq!(apply.validate(), Ok(()));

        let mut remember = apply.clone();
        remember.params["remember"] = json!(true);
        assert_eq!(remember.validate(), Err(ProtocolError::InvalidParams));

        let mut wrong_confirmation = apply;
        wrong_confirmation.params["confirmation"] = json!("YES");
        assert_eq!(
            wrong_confirmation.validate(),
            Err(ProtocolError::InvalidParams)
        );
    }

    #[test]
    fn setup_preflight_keeps_internal_fields_outside_the_safe_manifest() {
        let manifest = json!({
            "schemaVersion": "1.0",
            "toolSpanVersion": env!("CARGO_PKG_VERSION"),
            "instanceName": "Desktop",
            "localUrl": "http://127.0.0.1:8787",
            "desiredHostname": "mcp.example.test",
            "publicMcpUrl": "https://mcp.example.test/mcp",
            "oauthDiscoveryUrl": "https://mcp.example.test/.well-known/oauth-authorization-server",
            "expectedToolCount": 27,
            "tunnelName": "toolspan-test",
            "domainChoice": "other_registrar",
            "officialDocs": ["https://developers.cloudflare.com/"],
            "generatedAt": "2026-08-21T00:00:00.000Z"
        });
        let request = DesktopRequest {
            id: "preflight".into(),
            method: "setup.preflight".into(),
            params: json!({
                "sessionId": "setup-session-001",
                "idempotencyKey": "idempotency-001",
                "zoneName": "example.test",
                "manifest": manifest,
                "credential": {"kind": "api_token", "token": "fixture-token"}
            }),
        };
        assert_eq!(request.validate(), Ok(()));

        let mut extra_internal_version = request;
        extra_internal_version.params["manifest"]["setupProtocolVersion"] = json!("1");
        assert_eq!(
            extra_internal_version.validate(),
            Err(ProtocolError::InvalidParams)
        );
    }

    #[test]
    fn hello_requires_protocol_and_matching_product_version() {
        let good = DesktopRequest {
            id: "hello".into(),
            method: "system.hello".into(),
            params: json!({
                "protocolVersion": 1,
                "productVersion": env!("CARGO_PKG_VERSION")
            }),
        };
        assert_eq!(good.validate(), Ok(()));

        let mut wrong = good;
        wrong.params["protocolVersion"] = json!(2);
        assert_eq!(
            wrong.validate(),
            Err(ProtocolError::ProtocolVersionMismatch)
        );
    }

    #[test]
    fn public_test_cannot_smuggle_an_arbitrary_url() {
        let request = DesktopRequest {
            id: "public".into(),
            method: "connection.testPublic".into(),
            params: json!({"options": {"url": "https://attacker.example"}}),
        };
        assert_eq!(request.validate(), Err(ProtocolError::CallerProvidedUrl));
    }

    #[test]
    fn duplicate_ids_are_rejected_per_host_lifetime() {
        let mut ids = RequestIds::default();
        assert_eq!(ids.record("same"), Ok(()));
        assert_eq!(ids.record("same"), Err(ProtocolError::DuplicateRequestId));
    }

    #[test]
    fn oversized_request_is_rejected_before_host_io() {
        let request = DesktopRequest {
            id: "large".into(),
            method: "runtime.validateConfig".into(),
            params: json!({"value": "x".repeat(MAX_PROTOCOL_MESSAGE_BYTES)}),
        };
        assert_eq!(request.validate(), Err(ProtocolError::Oversize));
    }
}
