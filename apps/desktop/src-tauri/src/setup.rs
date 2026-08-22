use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;
use zeroize::{Zeroize, Zeroizing};

use crate::commands::{CommandError, DesktopState};
use crate::protocol::DesktopRequest;

const MAX_SECRET_BYTES: usize = 65_536;
const GLOBAL_KEY_ACKNOWLEDGEMENT: &str = "I UNDERSTAND GLOBAL API KEY ACCESS";

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SetupCredentialInputValue {
    ApiToken {
        token: String,
    },
    GlobalApiKey {
        email: String,
        key: String,
        acknowledgement: String,
    },
}

impl Drop for SetupCredentialInputValue {
    fn drop(&mut self) {
        match self {
            Self::ApiToken { token } => token.zeroize(),
            Self::GlobalApiKey {
                email,
                key,
                acknowledgement,
            } => {
                email.zeroize();
                key.zeroize();
                acknowledgement.zeroize();
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetupCredentialInput {
    session_id: String,
    credential: SetupCredentialInputValue,
}

impl Drop for SetupCredentialInput {
    fn drop(&mut self) {
        self.session_id.zeroize();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupCredentialAccepted {
    accepted: bool,
    credential_kind: &'static str,
}

enum StoredCredential {
    ApiToken {
        token: Zeroizing<String>,
    },
    GlobalApiKey {
        email: Zeroizing<String>,
        key: Zeroizing<String>,
        acknowledgement: Zeroizing<String>,
    },
}

impl StoredCredential {
    fn kind(&self) -> &'static str {
        match self {
            Self::ApiToken { .. } => "api_token",
            Self::GlobalApiKey { .. } => "global_api_key",
        }
    }

    fn to_protocol_value(&self) -> Value {
        match self {
            Self::ApiToken { token } => json!({
                "kind": "api_token",
                "token": token.as_str(),
            }),
            Self::GlobalApiKey {
                email,
                key,
                acknowledgement,
            } => json!({
                "kind": "global_api_key",
                "email": email.as_str(),
                "key": key.as_str(),
                "acknowledgement": acknowledgement.as_str(),
            }),
        }
    }
}

struct StoredSetupCredential {
    session_id: Zeroizing<String>,
    host_nonce: Option<String>,
    credential: StoredCredential,
}

pub struct SetupCredentialVault {
    value: Mutex<Option<StoredSetupCredential>>,
}

impl std::fmt::Debug for SetupCredentialVault {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SetupCredentialVault([REDACTED])")
    }
}

impl Default for SetupCredentialVault {
    fn default() -> Self {
        Self {
            value: Mutex::new(None),
        }
    }
}

impl SetupCredentialVault {
    fn replace(
        &self,
        session_id: String,
        host_nonce: Option<String>,
        credential: StoredCredential,
    ) -> Result<&'static str, ()> {
        let kind = credential.kind();
        *self.value.lock().map_err(|_| ())? = Some(StoredSetupCredential {
            session_id: Zeroizing::new(session_id),
            host_nonce,
            credential,
        });
        Ok(kind)
    }

    pub(crate) fn clear(&self) {
        if let Ok(mut value) = self.value.lock() {
            *value = None;
        }
    }

    fn inject(
        &self,
        host_nonce: Option<&str>,
        request: &mut DesktopRequest,
    ) -> SetupRequestContext {
        let Some(session_id) = setup_session_id(request) else {
            return SetupRequestContext::default();
        };
        let mut context = SetupRequestContext {
            session_id: Some(session_id.to_owned()),
            setup_method: true,
            injected: false,
        };
        if !accepts_credential(&request.method) {
            return context;
        }
        let Ok(mut stored) = self.value.lock() else {
            return context;
        };
        let Some(value) = stored.as_ref() else {
            return context;
        };
        if value.session_id.as_str() != session_id {
            return context;
        }
        if value
            .host_nonce
            .as_deref()
            .is_some_and(|bound| Some(bound) != host_nonce)
        {
            *stored = None;
            return context;
        }
        let credential = value.credential.to_protocol_value();
        if let Some(params) = request.params.as_object_mut() {
            params.insert("credential".into(), credential);
            context.injected = true;
        }
        context
    }

    pub(crate) fn finish(
        &self,
        context: &SetupRequestContext,
        method: &str,
        host_nonce: Option<&str>,
        response: &Value,
    ) {
        if method == "setup.discardCredential" {
            self.clear();
            return;
        }
        if !context.setup_method {
            return;
        }
        let response_ok = response.get("ok").and_then(Value::as_bool) == Some(true);
        let requires_credential = response
            .pointer("/result/requiresCredential")
            .and_then(Value::as_bool)
            == Some(true);
        let terminal = response
            .pointer("/result/status")
            .and_then(Value::as_str)
            .is_some_and(|status| {
                matches!(status, "COMPLETE" | "ROLLED_BACK" | "ROLLBACK_PARTIAL")
            });
        let Ok(mut stored) = self.value.lock() else {
            return;
        };
        if !response_ok || requires_credential || terminal {
            *stored = None;
            return;
        }
        if context.injected {
            if let (Some(value), Some(session_id)) =
                (stored.as_mut(), context.session_id.as_deref())
            {
                if value.session_id.as_str() == session_id && value.host_nonce.is_none() {
                    value.host_nonce = host_nonce.map(str::to_owned);
                }
            }
        }
    }
}

#[derive(Default)]
pub(crate) struct SetupRequestContext {
    session_id: Option<String>,
    setup_method: bool,
    injected: bool,
}

pub(crate) fn renderer_supplied_credential(request: &DesktopRequest) -> bool {
    request.method.starts_with("setup.")
        && request
            .params
            .as_object()
            .is_some_and(|params| params.contains_key("credential"))
}

pub(crate) fn inject_setup_credential(
    vault: &SetupCredentialVault,
    host_nonce: Option<&str>,
    request: &mut DesktopRequest,
) -> SetupRequestContext {
    vault.inject(host_nonce, request)
}

pub(crate) fn setup_response_is_safe(method: &str, response: &Value) -> bool {
    !method.starts_with("setup.") || !contains_secret_field(response)
}

fn contains_secret_field(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, child)| {
            matches!(
                key.to_ascii_lowercase().as_str(),
                "credential"
                    | "token"
                    | "apikey"
                    | "api_key"
                    | "key"
                    | "email"
                    | "acknowledgement"
                    | "authorization"
                    | "password"
                    | "secret"
            ) || contains_secret_field(child)
        }),
        Value::Array(values) => values.iter().any(contains_secret_field),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => false,
    }
}

#[tauri::command]
pub fn setup_set_credential(
    state: State<'_, DesktopState>,
    mut input: SetupCredentialInput,
) -> Result<SetupCredentialAccepted, CommandError> {
    if !valid_session_id(&input.session_id) {
        return Err(CommandError::new("SETUP_CREDENTIAL_REJECTED"));
    }
    validate_credential(&input.credential)
        .map_err(|_| CommandError::new("SETUP_CREDENTIAL_REJECTED"))?;
    let host_nonce = state
        .supervisor
        .lock()
        .map_err(|_| CommandError::new("DESKTOP_HOST_UNAVAILABLE"))?
        .ownership_nonce()
        .map(str::to_owned);
    let session_id = std::mem::take(&mut input.session_id);
    let credential = take_stored_credential(&mut input.credential);
    let kind = state
        .setup_credentials
        .replace(session_id, host_nonce, credential)
        .map_err(|_| CommandError::new("SETUP_CREDENTIAL_UNAVAILABLE"))?;
    Ok(SetupCredentialAccepted {
        accepted: true,
        credential_kind: kind,
    })
}

fn take_stored_credential(input: &mut SetupCredentialInputValue) -> StoredCredential {
    match input {
        SetupCredentialInputValue::ApiToken { token } => StoredCredential::ApiToken {
            token: Zeroizing::new(std::mem::take(token)),
        },
        SetupCredentialInputValue::GlobalApiKey {
            email,
            key,
            acknowledgement,
        } => StoredCredential::GlobalApiKey {
            email: Zeroizing::new(std::mem::take(email)),
            key: Zeroizing::new(std::mem::take(key)),
            acknowledgement: Zeroizing::new(std::mem::take(acknowledgement)),
        },
    }
}

fn validate_credential(input: &SetupCredentialInputValue) -> Result<(), ()> {
    match input {
        SetupCredentialInputValue::ApiToken { token } => {
            valid_secret(token).then_some(()).ok_or(())
        }
        SetupCredentialInputValue::GlobalApiKey {
            email,
            key,
            acknowledgement,
        } => (valid_email(email)
            && valid_secret(key)
            && acknowledgement == GLOBAL_KEY_ACKNOWLEDGEMENT)
            .then_some(())
            .ok_or(()),
    }
}

fn valid_secret(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SECRET_BYTES
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn valid_email(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 254
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return false;
    }
    let mut parts = value.split('@');
    matches!((parts.next(), parts.next(), parts.next()), (Some(local), Some(domain), None) if !local.is_empty() && !domain.is_empty())
}

fn valid_session_id(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_-".contains(character))
}

fn accepts_credential(method: &str) -> bool {
    matches!(
        method,
        "setup.preflight" | "setup.apply" | "setup.rollback" | "setup.reconcile"
    )
}

fn setup_session_id(request: &DesktopRequest) -> Option<&str> {
    if request.method.starts_with("setup.") {
        request.params.get("sessionId")?.as_str()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};
    use std::thread;

    use super::*;

    fn token_input(session_id: &str, token: &str) -> SetupCredentialInput {
        SetupCredentialInput {
            session_id: session_id.into(),
            credential: SetupCredentialInputValue::ApiToken {
                token: token.into(),
            },
        }
    }

    fn store(vault: &SetupCredentialVault, mut input: SetupCredentialInput, nonce: Option<&str>) {
        validate_credential(&input.credential).expect("valid fixture credential");
        let session_id = std::mem::take(&mut input.session_id);
        let credential = take_stored_credential(&mut input.credential);
        vault
            .replace(session_id, nonce.map(str::to_owned), credential)
            .expect("credential vault");
    }

    #[test]
    fn credential_is_injected_only_for_the_matching_setup_session() {
        let vault = SetupCredentialVault::default();
        store(
            &vault,
            token_input("setup-001", "fixture-secret"),
            Some("host-1"),
        );
        let mut request = DesktopRequest {
            id: "apply".into(),
            method: "setup.apply".into(),
            params: json!({"sessionId": "setup-001", "confirmation": "APPLY"}),
        };
        let context = vault.inject(Some("host-1"), &mut request);
        assert!(context.injected);
        assert_eq!(
            request
                .params
                .pointer("/credential/token")
                .and_then(Value::as_str),
            Some("fixture-secret")
        );

        let mut other = DesktopRequest {
            id: "other".into(),
            method: "setup.reconcile".into(),
            params: json!({"sessionId": "setup-002"}),
        };
        assert!(!vault.inject(Some("host-1"), &mut other).injected);
        assert!(other.params.get("credential").is_none());
    }

    #[test]
    fn host_restart_discards_the_session_credential_before_injection() {
        let vault = SetupCredentialVault::default();
        store(
            &vault,
            token_input("setup-001", "fixture-secret"),
            Some("host-1"),
        );
        let mut request = DesktopRequest {
            id: "reconcile".into(),
            method: "setup.reconcile".into(),
            params: json!({"sessionId": "setup-001"}),
        };
        let context = vault.inject(Some("host-2"), &mut request);
        assert!(!context.injected);
        assert!(request.params.get("credential").is_none());

        let mut retry = DesktopRequest {
            id: "retry".into(),
            method: "setup.reconcile".into(),
            params: json!({"sessionId": "setup-001"}),
        };
        assert!(!vault.inject(Some("host-2"), &mut retry).injected);
    }

    #[test]
    fn concurrent_credential_sets_never_cross_setup_sessions() {
        let vault = Arc::new(SetupCredentialVault::default());
        let barrier = Arc::new(Barrier::new(3));
        let handles: Vec<_> = [
            ("setup-001", "fixture-secret-one"),
            ("setup-002", "fixture-secret-two"),
        ]
        .into_iter()
        .map(|(session_id, secret)| {
            let vault = Arc::clone(&vault);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                store(&vault, token_input(session_id, secret), Some("host-1"));
            })
        })
        .collect();
        barrier.wait();
        for handle in handles {
            handle.join().expect("credential writer");
        }

        let mut injections = 0;
        for session_id in ["setup-001", "setup-002"] {
            let mut request = DesktopRequest {
                id: format!("apply-{session_id}"),
                method: "setup.apply".into(),
                params: json!({"sessionId": session_id, "confirmation": "APPLY"}),
            };
            if vault.inject(Some("host-1"), &mut request).injected {
                injections += 1;
                assert_eq!(
                    request.params["credential"]["kind"],
                    Value::String("api_token".into())
                );
            } else {
                assert!(request.params.get("credential").is_none());
            }
        }
        assert_eq!(injections, 1);
    }

    #[test]
    fn global_key_requires_email_and_the_exact_acknowledgement() {
        let valid = SetupCredentialInputValue::GlobalApiKey {
            email: "owner@example.test".into(),
            key: "fixture-key".into(),
            acknowledgement: GLOBAL_KEY_ACKNOWLEDGEMENT.into(),
        };
        assert!(validate_credential(&valid).is_ok());

        let wrong = SetupCredentialInputValue::GlobalApiKey {
            email: "owner@example.test".into(),
            key: "fixture-key".into(),
            acknowledgement: "remember this".into(),
        };
        assert!(validate_credential(&wrong).is_err());
    }

    #[test]
    fn renderer_cannot_send_a_credential_through_desktop_invoke() {
        let request = DesktopRequest {
            id: "unsafe".into(),
            method: "setup.apply".into(),
            params: json!({
                "sessionId": "setup-001",
                "confirmation": "APPLY",
                "credential": {"kind": "api_token", "token": "fixture-secret"}
            }),
        };
        assert!(renderer_supplied_credential(&request));
    }

    #[test]
    fn setup_response_rejects_secret_fields_but_allows_idempotency_key() {
        assert!(setup_response_is_safe(
            "setup.apply",
            &json!({"ok": true, "result": {"idempotencyKey": "safe-id"}})
        ));
        assert!(!setup_response_is_safe(
            "setup.apply",
            &json!({"ok": true, "result": {"credential": "fixture-secret"}})
        ));
    }
}
