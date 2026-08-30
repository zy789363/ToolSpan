use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use zeroize::Zeroize;

use crate::config::{
    ConfigError, content_hash, read_json_config, write_json_config, write_private_text,
};
use crate::node::validate_node_executable;
use crate::password::{hash_owner_password_local, validate_bcrypt_hash};
use crate::process::{HostLaunch, HostReply, HostSupervisor};
use crate::protocol::DesktopRequest;
use crate::public_endpoint::test_configured_public_endpoint;
use crate::setup::{
    SetupCredentialVault, inject_setup_credential, renderer_supplied_credential,
    setup_response_is_safe,
};

#[derive(Debug, Clone)]
pub struct DesktopPaths {
    pub config_file: PathBuf,
    pub password_file: PathBuf,
    pub node_settings_file: PathBuf,
    pub app_data_root: PathBuf,
    pub app_log_root: PathBuf,
}

/// Tracks whether the renderer acknowledged the most recent tray quit
/// request. A quit request must never hang forever when the renderer is
/// unreachable (WebView still loading, event lost, or renderer dead), so
/// `request_safe_quit` arms a bounded fallback that runs the same
/// confirm-quit stop sequence when no acknowledgement arrives in time.
#[derive(Debug, Default)]
pub(crate) struct QuitGate {
    generation: AtomicU64,
    acknowledged: AtomicBool,
}

impl QuitGate {
    /// Begins a new quit request and returns its generation.
    pub(crate) fn begin_request(&self) -> u64 {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.acknowledged.store(false, Ordering::SeqCst);
        generation
    }

    /// The renderer received the quit request (dialog is reachable).
    pub(crate) fn acknowledge(&self) {
        self.acknowledged.store(true, Ordering::SeqCst);
    }

    /// True only for the current, still-unacknowledged quit request.
    pub(crate) fn is_unacknowledged(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
            && !self.acknowledged.load(Ordering::SeqCst)
    }
}

#[derive(Debug)]
pub struct DesktopState {
    pub supervisor: Arc<Mutex<HostSupervisor>>,
    pub(crate) quit_gate: QuitGate,
    pub(crate) setup_credentials: SetupCredentialVault,
    paths: DesktopPaths,
    config_hash: Mutex<Option<String>>,
    roots: Mutex<HashMap<String, WorkspaceRoot>>,
}

impl DesktopState {
    pub fn new(paths: DesktopPaths, host_resource: PathBuf) -> Result<Self, CommandError> {
        let configured_node = load_configured_node(&paths.node_settings_file);
        let launch = HostLaunch::new(configured_node, host_resource, paths.config_file.clone())
            .map_err(|_| CommandError::new("HOST_RESOURCE_INVALID"))?;
        let current = read_json_config(&paths.config_file)
            .map_err(|_| CommandError::new("CONFIG_READ_FAILED"))?;
        let roots = current
            .as_ref()
            .map(|snapshot| roots_from_config(&snapshot.value))
            .unwrap_or_default();
        Ok(Self {
            supervisor: Arc::new(Mutex::new(HostSupervisor::new(launch))),
            quit_gate: QuitGate::default(),
            setup_credentials: SetupCredentialVault::default(),
            paths,
            config_hash: Mutex::new(current.map(|snapshot| snapshot.hash)),
            roots: Mutex::new(roots),
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    code: &'static str,
    message: &'static str,
}

impl CommandError {
    pub(crate) fn new(code: &'static str) -> Self {
        Self {
            code,
            message: "The local desktop operation could not be completed.",
        }
    }
}

impl From<crate::process::HostError> for CommandError {
    fn from(error: crate::process::HostError) -> Self {
        Self::new(error.safe_code())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRoot {
    pub id: String,
    pub name: String,
    pub path: String,
    pub access: RootAccess,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RootAccess {
    Read,
    ReadWrite,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FirstRunRoot {
    name: String,
    path: String,
    access: RootAccess,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FirstRunInput {
    instance_name: String,
    allowed_roots: Vec<FirstRunRoot>,
    state_path: String,
    log_path: String,
    owner_password_hash: String,
    start_after_save: bool,
}

impl Drop for FirstRunInput {
    fn drop(&mut self) {
        self.owner_password_hash.zeroize();
    }
}

#[tauri::command]
pub async fn desktop_invoke(
    app: AppHandle,
    state: State<'_, DesktopState>,
    mut request: DesktopRequest,
) -> Result<Value, CommandError> {
    if renderer_supplied_credential(&request) {
        return Err(CommandError::new("SETUP_CREDENTIAL_CHANNEL_REJECTED"));
    }
    request
        .validate()
        .map_err(|_| CommandError::new("DESKTOP_PROTOCOL_REJECTED"))?;

    if request.method == "runtime.getSnapshot" && !state.paths.config_file.is_file() {
        return first_run_snapshot_response(&request, &state);
    }
    if request.method == "connection.testPublic" {
        return public_endpoint_response(&request, &state.paths.config_file);
    }

    let is_snapshot = request.method == "runtime.getSnapshot";
    let method = request.method.clone();
    let supervisor = Arc::clone(&state.supervisor);
    let host_nonce = supervisor
        .lock()
        .map_err(|_| CommandError::new("DESKTOP_HOST_UNAVAILABLE"))?
        .ownership_nonce()
        .map(str::to_owned);
    let setup_context = inject_setup_credential(
        &state.setup_credentials,
        host_nonce.as_deref(),
        &mut request,
    );
    request
        .validate()
        .map_err(|_| CommandError::new("DESKTOP_PROTOCOL_REJECTED"))?;
    let invoked = tauri::async_runtime::spawn_blocking(move || {
        supervisor
            .lock()
            .map_err(|_| CommandError::new("DESKTOP_HOST_UNAVAILABLE"))?
            .invoke(&request)
            .map_err(CommandError::from)
    })
    .await;
    let reply = match invoked {
        Ok(Ok(reply)) => reply,
        Ok(Err(error)) => {
            state.setup_credentials.clear();
            return Err(error);
        }
        Err(_) => {
            state.setup_credentials.clear();
            return Err(CommandError::new("DESKTOP_HOST_UNAVAILABLE"));
        }
    };
    if !setup_response_is_safe(&method, &reply.response) {
        state.setup_credentials.clear();
        return Err(CommandError::new("SETUP_RESPONSE_REJECTED"));
    }
    let current_host_nonce = state
        .supervisor
        .lock()
        .ok()
        .and_then(|supervisor| supervisor.ownership_nonce().map(str::to_owned));
    state.setup_credentials.finish(
        &setup_context,
        &method,
        current_host_nonce.as_deref(),
        &reply.response,
    );
    for event in reply.events {
        let _ = app.emit("desktop://event", event);
    }
    let response = if is_snapshot {
        merge_runtime_snapshot_response(reply.response, &state)?
    } else {
        reply.response
    };
    if response.get("ok").and_then(Value::as_bool) == Some(true) {
        match response
            .pointer("/result/core/state")
            .or_else(|| response.pointer("/result/state"))
            .and_then(Value::as_str)
        {
            Some("running") => crate::app::update_tray_status(&app, "running"),
            Some("stopped") => crate::app::update_tray_status(&app, "stopped"),
            Some("attention" | "unavailable") => crate::app::update_tray_status(&app, "attention"),
            _ => {}
        }
    }
    Ok(response)
}

#[tauri::command]
pub async fn hash_owner_password(password: String) -> Result<String, CommandError> {
    tauri::async_runtime::spawn_blocking(move || hash_owner_password_local(password))
        .await
        .map_err(|_| CommandError::new("PASSWORD_HASH_FAILED"))?
        .map_err(|_| CommandError::new("PASSWORD_HASH_FAILED"))
}

#[tauri::command]
pub async fn pick_allowed_root(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Option<WorkspaceRoot>, CommandError> {
    let selected = app.dialog().file().blocking_pick_folder();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| CommandError::new("ROOT_SELECTION_INVALID"))?;
    let canonical =
        fs::canonicalize(&path).map_err(|_| CommandError::new("ROOT_SELECTION_INVALID"))?;
    if !fs::metadata(&canonical)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
    {
        return Err(CommandError::new("ROOT_SELECTION_INVALID"));
    }
    let root = workspace_root(canonical);
    add_root_to_config_if_present(&state, &root)?;
    state
        .roots
        .lock()
        .map_err(|_| CommandError::new("ROOT_REGISTRY_UNAVAILABLE"))?
        .insert(root.id.clone(), root.clone());
    Ok(Some(root))
}

#[tauri::command]
pub fn remove_allowed_root(state: State<'_, DesktopState>, id: String) -> Result<(), CommandError> {
    let root = state
        .roots
        .lock()
        .map_err(|_| CommandError::new("ROOT_REGISTRY_UNAVAILABLE"))?
        .get(&id)
        .cloned()
        .ok_or_else(|| CommandError::new("ROOT_NOT_REGISTERED"))?;
    remove_root_from_config_if_present(&state, &root)?;
    state
        .roots
        .lock()
        .map_err(|_| CommandError::new("ROOT_REGISTRY_UNAVAILABLE"))?
        .remove(&id);
    Ok(())
}

#[tauri::command]
pub fn complete_first_run(
    state: State<'_, DesktopState>,
    input: FirstRunInput,
) -> Result<(), CommandError> {
    validate_instance_name(&input.instance_name)?;
    validate_bcrypt_hash(&input.owner_password_hash)
        .map_err(|_| CommandError::new("PASSWORD_HASH_INVALID"))?;
    let state_path = require_app_path(&input.state_path, &state.paths.app_data_root)?;
    let log_path = require_app_path(&input.log_path, &state.paths.app_log_root)?;
    fs::create_dir_all(&state_path).map_err(|_| CommandError::new("APP_PATH_CREATE_FAILED"))?;
    fs::create_dir_all(&log_path).map_err(|_| CommandError::new("APP_PATH_CREATE_FAILED"))?;

    let registered = state
        .roots
        .lock()
        .map_err(|_| CommandError::new("ROOT_REGISTRY_UNAVAILABLE"))?;
    if input.allowed_roots.is_empty()
        || input.allowed_roots.iter().any(|candidate| {
            !registered.values().any(|root| {
                same_path(Path::new(&candidate.path), Path::new(&root.path))
                    && candidate.access == root.access
                    && valid_root_name(&candidate.name)
            })
        })
    {
        return Err(CommandError::new("ROOT_NOT_REGISTERED"));
    }

    let allowed_roots: Vec<_> = input
        .allowed_roots
        .iter()
        .map(|root| Value::String(root.path.clone()))
        .collect();
    let candidate = json!({
        "instanceName": input.instance_name,
        "host": "127.0.0.1",
        "port": 8787,
        "publicBaseUrl": "http://127.0.0.1:8787",
        "allowedRoots": allowed_roots,
        "stateDirectory": state_path,
        "ownerPasswordHashFile": state.paths.password_file,
        "allowedOrigins": ["http://127.0.0.1", "http://localhost"]
    });
    drop(registered);

    let mut known_hash = state
        .config_hash
        .lock()
        .map_err(|_| CommandError::new("CONFIG_WRITE_FAILED"))?;
    let snapshot = write_first_run_files(
        &state.paths,
        known_hash.as_deref(),
        &candidate,
        &input.owner_password_hash,
    )?;
    *known_hash = Some(snapshot.hash);
    drop(known_hash);

    if input.start_after_save {
        let request = DesktopRequest {
            id: tray_request_id("first-run-start"),
            method: "runtime.start".into(),
            params: json!({}),
        };
        state
            .supervisor
            .lock()
            .map_err(|_| CommandError::new("DESKTOP_HOST_UNAVAILABLE"))?
            .invoke(&request)
            .map_err(|_| CommandError::new("RUNTIME_START_FAILED"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn update_owner_password_hash(
    state: State<'_, DesktopState>,
    mut hash: String,
) -> Result<(), CommandError> {
    validate_bcrypt_hash(&hash).map_err(|_| CommandError::new("PASSWORD_HASH_INVALID"))?;
    let result = write_private_text(&state.paths.password_file, &format!("{hash}\n"));
    hash.zeroize();
    result.map_err(|_| CommandError::new("PASSWORD_HASH_WRITE_FAILED"))
}

#[tauri::command]
pub async fn choose_node_executable(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<(), CommandError> {
    let selected = app.dialog().file().blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(());
    };
    let path = selected
        .into_path()
        .map_err(|_| CommandError::new("NODE_SELECTION_INVALID"))?;
    let validated = tauri::async_runtime::spawn_blocking(move || validate_node_executable(&path))
        .await
        .map_err(|_| CommandError::new("NODE_SELECTION_INVALID"))?
        .map_err(|_| CommandError::new("NODE_SELECTION_INVALID"))?;
    let current = read_json_config(&state.paths.node_settings_file)
        .map_err(|_| CommandError::new("NODE_SETTINGS_WRITE_FAILED"))?;
    write_json_config(
        &state.paths.node_settings_file,
        current.as_ref().map(|snapshot| snapshot.hash.as_str()),
        &json!({"nodePath": validated.path, "nodeVersion": validated.version}),
        validate_node_settings,
    )
    .map_err(|_| CommandError::new("NODE_SETTINGS_WRITE_FAILED"))?;
    state
        .supervisor
        .lock()
        .map_err(|_| CommandError::new("DESKTOP_HOST_UNAVAILABLE"))?
        .set_configured_node(validated.path);
    Ok(())
}

#[tauri::command]
pub fn acknowledge_quit_request(state: State<'_, DesktopState>) {
    state.quit_gate.acknowledge();
}

#[tauri::command]
pub fn confirm_quit(
    app: AppHandle,
    state: State<'_, DesktopState>,
    stop_managed: bool,
) -> Result<(), CommandError> {
    confirm_quit_internal(&app, &state, stop_managed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QuitDecision {
    Cancel,
    StopOwnedAndExit,
    ExitWithoutStop,
}

fn quit_decision(managed: bool, stop_managed: bool) -> QuitDecision {
    match (managed, stop_managed) {
        (true, true) => QuitDecision::StopOwnedAndExit,
        (true, false) => QuitDecision::Cancel,
        (false, _) => QuitDecision::ExitWithoutStop,
    }
}

fn validate_runtime_stop_reply(reply: &HostReply) -> Result<(), CommandError> {
    if reply.response.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err(CommandError::new("RUNTIME_STOP_FAILED"))
    }
}

pub(crate) fn confirm_quit_internal(
    app: &AppHandle,
    state: &DesktopState,
    stop_managed: bool,
) -> Result<(), CommandError> {
    // The renderer answered the quit request: disarm the bounded fallback.
    state.quit_gate.acknowledge();
    let mut supervisor = state
        .supervisor
        .lock()
        .map_err(|_| CommandError::new("DESKTOP_HOST_UNAVAILABLE"))?;
    let managed = supervisor.ownership_nonce().is_some();
    match quit_decision(managed, stop_managed) {
        QuitDecision::Cancel => Ok(()),
        QuitDecision::ExitWithoutStop => {
            drop(supervisor);
            app.exit(0);
            Ok(())
        }
        QuitDecision::StopOwnedAndExit => {
            let stop = DesktopRequest {
                id: tray_request_id("quit-stop"),
                method: "runtime.stop".into(),
                params: json!({}),
            };
            // The owner already confirmed quitting, so a failed or rejected
            // graceful stop must never strand a quit-confirmed process.
            // Validate the reply first, then terminate the owned host and
            // exit even when the graceful stop did not succeed.
            if let Ok(reply) = supervisor.invoke(&stop) {
                let _ = validate_runtime_stop_reply(&reply);
            }
            if let Some(nonce) = supervisor.ownership_nonce().map(str::to_owned) {
                supervisor
                    .stop_owned(&nonce)
                    .map_err(|_| CommandError::new("DESKTOP_HOST_UNAVAILABLE"))?;
            }
            drop(supervisor);
            app.exit(0);
            Ok(())
        }
    }
}

fn write_first_run_files(
    paths: &DesktopPaths,
    expected_config_hash: Option<&str>,
    candidate: &Value,
    password_hash: &str,
) -> Result<crate::config::ConfigSnapshot, CommandError> {
    let previous_password = match fs::read_to_string(&paths.password_file) {
        Ok(value) => Some(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(CommandError::new("PASSWORD_HASH_WRITE_FAILED")),
    };
    write_private_text(&paths.password_file, &format!("{password_hash}\n"))
        .map_err(|_| CommandError::new("PASSWORD_HASH_WRITE_FAILED"))?;
    match write_json_config(
        &paths.config_file,
        expected_config_hash,
        candidate,
        validate_core_config,
    ) {
        Ok(snapshot) => Ok(snapshot),
        Err(error) => {
            let rollback = match previous_password {
                Some(previous) => write_private_text(&paths.password_file, &previous),
                None => match fs::remove_file(&paths.password_file) {
                    Ok(()) => Ok(()),
                    Err(remove_error) if remove_error.kind() == std::io::ErrorKind::NotFound => {
                        Ok(())
                    }
                    Err(remove_error) => Err(remove_error.into()),
                },
            };
            rollback.map_err(|_| CommandError::new("PASSWORD_HASH_ROLLBACK_FAILED"))?;
            Err(map_config_error(error))
        }
    }
}

fn public_endpoint_response(
    request: &DesktopRequest,
    config_path: &Path,
) -> Result<Value, CommandError> {
    match test_configured_public_endpoint(config_path) {
        Ok(result) => Ok(json!({
            "id": request.id,
            "ok": true,
            "result": {
                "target": "public",
                "ok": result.ok,
                "latencyMs": result.latency_ms,
                "status": if result.ok { "READY" } else { "HTTP_ERROR" },
                "checkedUrl": result.checked_url,
                "checkedAt": OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default()
            }
        })),
        Err(_) => Ok(json!({
            "id": request.id,
            "ok": false,
            "error": {"code": "PUBLIC_ENDPOINT_REJECTED"}
        })),
    }
}

fn first_run_snapshot_response(
    request: &DesktopRequest,
    state: &DesktopState,
) -> Result<Value, CommandError> {
    let mut workspaces: Vec<_> = state
        .roots
        .lock()
        .map_err(|_| CommandError::new("ROOT_REGISTRY_UNAVAILABLE"))?
        .values()
        .cloned()
        .collect();
    workspaces.sort_by(|left, right| left.id.cmp(&right.id));
    let node_settings = read_json_config(&state.paths.node_settings_file)
        .ok()
        .flatten()
        .map(|snapshot| snapshot.value);
    let node_version = node_settings
        .as_ref()
        .and_then(|settings| settings.get("nodeVersion"))
        .and_then(Value::as_str);
    let node_path_configured = node_settings
        .as_ref()
        .and_then(|settings| settings.get("nodePath"))
        .and_then(Value::as_str)
        .is_some();
    Ok(json!({
        "id": request.id,
        "ok": true,
        "result": {
            "firstRunRequired": true,
            "instanceName": "ToolSpan",
            "core": {
                "state": "unavailable",
                "version": env!("CARGO_PKG_VERSION"),
                "managedByDesktop": false,
                "uptimeSeconds": Value::Null,
                "nodeVersion": node_version,
                "nodePathConfigured": node_path_configured
            },
            "connection": {
                "localUrl": "http://127.0.0.1:8787/mcp",
                "publicBaseUrl": Value::Null,
                "oauthDiscoveryUrl": Value::Null,
                "localReady": false,
                "publicReady": Value::Null
            },
            "toolContract": {"available": 0, "total": 27},
            "workspaces": workspaces,
            "recentJobs": [],
            "recentArtifacts": [],
            "statePath": state.paths.app_data_root.join("state"),
            "logPath": state.paths.app_log_root,
            "ownerPasswordConfigured": false,
            "lastUpdatedAt": OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default()
        }
    }))
}

fn merge_runtime_snapshot_response(
    mut response: Value,
    state: &DesktopState,
) -> Result<Value, CommandError> {
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Ok(response);
    }
    let host = response
        .get_mut("result")
        .map(std::mem::take)
        .ok_or_else(|| CommandError::new("DESKTOP_HOST_RESPONSE_INVALID"))?;
    let mut workspaces: Vec<_> = state
        .roots
        .lock()
        .map_err(|_| CommandError::new("ROOT_REGISTRY_UNAVAILABLE"))?
        .values()
        .cloned()
        .collect();
    workspaces.sort_by(|left, right| left.id.cmp(&right.id));
    let node_settings = read_json_config(&state.paths.node_settings_file)
        .ok()
        .flatten()
        .map(|snapshot| snapshot.value);
    let node_version = node_settings
        .as_ref()
        .and_then(|settings| settings.get("nodeVersion"))
        .and_then(Value::as_str);
    let node_path_configured = node_settings
        .as_ref()
        .and_then(|settings| settings.get("nodePath"))
        .and_then(Value::as_str)
        .is_some();
    let host_owned = state
        .supervisor
        .lock()
        .ok()
        .is_some_and(|supervisor| supervisor.ownership_nonce().is_some());
    let host_state = host
        .get("state")
        .or_else(|| host.pointer("/core/state"))
        .and_then(Value::as_str)
        .unwrap_or("attention");
    let ui_state = match host_state {
        "running" | "starting" | "stopped" | "attention" | "external" | "unavailable" => host_state,
        "stopping" => "starting",
        _ => "attention",
    };
    let managed = host_owned && ui_state != "external";
    let public_base = host
        .get("publicBaseUrl")
        .or_else(|| host.pointer("/connection/publicBaseUrl"))
        .and_then(Value::as_str)
        .filter(|url| url.starts_with("https://"));
    let oauth_discovery = public_base.map(|base| {
        format!(
            "{}/.well-known/oauth-authorization-server",
            base.trim_end_matches('/')
        )
    });
    let unified = json!({
        "firstRunRequired": false,
        "instanceName": host.get("instanceName").and_then(Value::as_str).unwrap_or("ToolSpan"),
        "core": {
            "state": ui_state,
            "version": host.get("productVersion")
                .or_else(|| host.pointer("/core/version"))
                .and_then(Value::as_str)
                .unwrap_or(env!("CARGO_PKG_VERSION")),
            "managedByDesktop": managed,
            "uptimeSeconds": host.get("uptimeSeconds")
                .or_else(|| host.pointer("/core/uptimeSeconds"))
                .cloned()
                .unwrap_or(Value::Null),
            "nodeVersion": node_version,
            "nodePathConfigured": node_path_configured
        },
        "connection": {
            "localUrl": host.get("localEndpoint")
                .or_else(|| host.pointer("/connection/localUrl"))
                .and_then(Value::as_str)
                .unwrap_or("http://127.0.0.1:8787/mcp"),
            "publicBaseUrl": public_base,
            "oauthDiscoveryUrl": oauth_discovery,
            "localReady": host.get("localReady")
                .or_else(|| host.pointer("/connection/localReady"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            "publicReady": host.get("publicReady")
                .or_else(|| host.pointer("/connection/publicReady"))
                .cloned()
                .unwrap_or(Value::Null)
        },
        "toolContract": host.get("mcpTools")
            .or_else(|| host.get("toolContract"))
            .cloned()
            .unwrap_or_else(|| json!({"available": 0, "total": 27})),
        "workspaces": workspaces,
        "recentJobs": host.get("recentJobs").cloned().unwrap_or_else(|| json!([])),
        "recentArtifacts": host.get("recentArtifacts").cloned().unwrap_or_else(|| json!([])),
        "statePath": state.paths.app_data_root.join("state"),
        "logPath": state.paths.app_log_root,
        "ownerPasswordConfigured": state.paths.password_file.is_file(),
        "lastUpdatedAt": OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default()
    });
    response["result"] = unified;
    Ok(response)
}

fn load_configured_node(path: &Path) -> Option<PathBuf> {
    read_json_config(path)
        .ok()
        .flatten()
        .and_then(|snapshot| snapshot.value.get("nodePath")?.as_str().map(PathBuf::from))
}

fn validate_node_settings(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Err("settings must be an object".into());
    };
    if object.len() != 2
        || object.get("nodePath").and_then(Value::as_str).is_none()
        || object.get("nodeVersion").and_then(Value::as_str).is_none()
    {
        return Err("settings contain unexpected fields".into());
    }
    Ok(())
}

fn validate_core_config(value: &Value) -> Result<(), String> {
    const KEYS: [&str; 8] = [
        "allowedOrigins",
        "allowedRoots",
        "host",
        "instanceName",
        "ownerPasswordHashFile",
        "port",
        "publicBaseUrl",
        "stateDirectory",
    ];
    let Some(object) = value.as_object() else {
        return Err("config must be an object".into());
    };
    if object.len() != KEYS.len() || object.keys().any(|key| !KEYS.contains(&key.as_str())) {
        return Err("config contains unexpected fields".into());
    }
    let instance = object
        .get("instanceName")
        .and_then(Value::as_str)
        .ok_or_else(|| "instanceName is required".to_owned())?;
    if !valid_instance_name(instance) {
        return Err("invalid instanceName".into());
    }
    if object.get("host").and_then(Value::as_str) != Some("127.0.0.1")
        || object.get("port").and_then(Value::as_u64) != Some(8787)
        || object
            .get("allowedRoots")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
        || object
            .get("ownerPasswordHashFile")
            .and_then(Value::as_str)
            .is_none()
    {
        return Err("invalid local config".into());
    }
    if object.contains_key("ownerPasswordHash") || object.contains_key("password") {
        return Err("password material must not be stored in config".into());
    }
    Ok(())
}

fn validate_instance_name(name: &str) -> Result<(), CommandError> {
    if valid_instance_name(name) {
        Ok(())
    } else {
        Err(CommandError::new("INSTANCE_NAME_INVALID"))
    }
}

fn valid_instance_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || " ._-".contains(character))
}

fn valid_root_name(name: &str) -> bool {
    !name.trim().is_empty() && name.len() <= 128 && !name.chars().any(char::is_control)
}

fn workspace_root(path: PathBuf) -> WorkspaceRoot {
    let path_text = path.to_string_lossy().into_owned();
    let id = format!("root-{}", content_hash(path_text.as_bytes()));
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Workspace")
        .to_owned();
    WorkspaceRoot {
        id,
        name,
        path: path_text,
        access: RootAccess::ReadWrite,
    }
}

fn roots_from_config(config: &Value) -> HashMap<String, WorkspaceRoot> {
    config
        .get("allowedRoots")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(PathBuf::from)
        .map(workspace_root)
        .map(|root| (root.id.clone(), root))
        .collect()
}

fn require_app_path(raw: &str, root: &Path) -> Result<PathBuf, CommandError> {
    let candidate = clean_absolute_path(Path::new(raw))
        .ok_or_else(|| CommandError::new("APP_PATH_OUTSIDE_PRIVATE_DIRECTORY"))?;
    let root = clean_absolute_path(root)
        .ok_or_else(|| CommandError::new("APP_PATH_OUTSIDE_PRIVATE_DIRECTORY"))?;
    if path_is_within(&candidate, &root) {
        Ok(candidate)
    } else {
        Err(CommandError::new("APP_PATH_OUTSIDE_PRIVATE_DIRECTORY"))
    }
}

fn clean_absolute_path(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                clean.push(component)
            }
            Component::CurDir => {}
            Component::ParentDir => return None,
        }
    }
    Some(clean)
}

fn path_is_within(candidate: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        let candidate = candidate.to_string_lossy().to_lowercase();
        let root = root.to_string_lossy().to_lowercase();
        candidate == root
            || candidate
                .strip_prefix(&root)
                .is_some_and(|suffix| suffix.starts_with(['\\', '/']))
    }
    #[cfg(not(windows))]
    {
        candidate == root || candidate.starts_with(root)
    }
}

fn same_path(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => {
            #[cfg(windows)]
            {
                left.to_string_lossy()
                    .eq_ignore_ascii_case(&right.to_string_lossy())
            }
            #[cfg(not(windows))]
            {
                left == right
            }
        }
        _ => false,
    }
}

fn add_root_to_config_if_present(
    state: &DesktopState,
    root: &WorkspaceRoot,
) -> Result<(), CommandError> {
    mutate_roots_if_configured(state, |roots| {
        if !roots.iter().any(|value| value.as_str() == Some(&root.path)) {
            roots.push(Value::String(root.path.clone()));
        }
        Ok(())
    })
}

fn remove_root_from_config_if_present(
    state: &DesktopState,
    root: &WorkspaceRoot,
) -> Result<(), CommandError> {
    mutate_roots_if_configured(state, |roots| {
        roots.retain(|value| value.as_str() != Some(&root.path));
        if roots.is_empty() {
            return Err(CommandError::new("AT_LEAST_ONE_ROOT_REQUIRED"));
        }
        Ok(())
    })
}

fn mutate_roots_if_configured<F>(state: &DesktopState, mutate: F) -> Result<(), CommandError>
where
    F: FnOnce(&mut Vec<Value>) -> Result<(), CommandError>,
{
    let mut known_hash = state
        .config_hash
        .lock()
        .map_err(|_| CommandError::new("CONFIG_WRITE_FAILED"))?;
    let Some(current) = read_json_config(&state.paths.config_file)
        .map_err(|_| CommandError::new("CONFIG_READ_FAILED"))?
    else {
        return Ok(());
    };
    if known_hash.as_deref() != Some(current.hash.as_str()) {
        return Err(CommandError::new("CONFIG_CONFLICT"));
    }
    let mut candidate = current.value;
    let roots = candidate
        .get_mut("allowedRoots")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| CommandError::new("CONFIG_INVALID"))?;
    mutate(roots)?;
    let snapshot = write_json_config(
        &state.paths.config_file,
        known_hash.as_deref(),
        &candidate,
        validate_core_config,
    )
    .map_err(map_config_error)?;
    *known_hash = Some(snapshot.hash);
    Ok(())
}

fn map_config_error(error: ConfigError) -> CommandError {
    match error {
        ConfigError::Conflict => CommandError::new("CONFIG_CONFLICT"),
        _ => CommandError::new("CONFIG_WRITE_FAILED"),
    }
}

pub fn tray_request_id(prefix: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{prefix}-{millis}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_command_errors_serialize_only_the_safe_code() {
        let command_error = CommandError::from(crate::process::HostError::Node(
            crate::node::NodeError::UnsupportedVersion("private-marker".into()),
        ));
        assert_eq!(command_error.code, "DESKTOP_HOST_NODE_UNAVAILABLE");
        assert_eq!(
            command_error.message,
            "The local desktop operation could not be completed."
        );
        let serialized = serde_json::to_string(&command_error).expect("serialize command error");
        assert!(!serialized.contains("private-marker"));
        assert!(!serialized.contains(['/', '\\']));
    }

    #[test]
    fn app_paths_reject_relative_and_parent_escape() {
        let root = if cfg!(windows) {
            Path::new("C:/private/toolspan")
        } else {
            Path::new("/private/toolspan")
        };
        assert!(require_app_path("../state", root).is_err());
        let escaped = if cfg!(windows) {
            "C:/private/toolspan/../outside"
        } else {
            "/private/toolspan/../outside"
        };
        assert!(require_app_path(escaped, root).is_err());
    }

    #[test]
    fn config_validator_rejects_embedded_password_material() {
        let mut config = json!({
            "instanceName": "Desk",
            "host": "127.0.0.1",
            "port": 8787,
            "publicBaseUrl": "http://127.0.0.1:8787",
            "allowedRoots": ["C:/work"],
            "stateDirectory": "C:/private/state",
            "ownerPasswordHashFile": "C:/private/owner.bcrypt",
            "allowedOrigins": ["http://127.0.0.1"]
        });
        assert!(validate_core_config(&config).is_ok());
        config["ownerPasswordHash"] = Value::String("plaintext-or-hash".into());
        assert!(validate_core_config(&config).is_err());
    }

    #[test]
    fn workspace_ids_are_stable_without_exposing_a_secret() {
        let path = if cfg!(windows) {
            PathBuf::from("C:/work/project")
        } else {
            PathBuf::from("/work/project")
        };
        let first = workspace_root(path.clone());
        let second = workspace_root(path);
        assert_eq!(first.id, second.id);
        assert!(first.id.starts_with("root-"));
        assert!(!first.id.contains("project"));
    }

    #[test]
    fn quit_confirmation_never_stops_an_external_process() {
        assert_eq!(quit_decision(false, true), QuitDecision::ExitWithoutStop);
        assert_eq!(quit_decision(false, false), QuitDecision::ExitWithoutStop);
        assert_eq!(quit_decision(true, false), QuitDecision::Cancel);
        assert_eq!(quit_decision(true, true), QuitDecision::StopOwnedAndExit);
    }

    #[test]
    fn stop_and_quit_requires_an_explicitly_successful_host_reply() {
        let success = crate::process::HostReply {
            response: json!({"id": "quit-stop-success", "ok": true, "result": {}}),
            events: Vec::new(),
        };
        let failure = crate::process::HostReply {
            response: json!({
                "id": "quit-stop-failure",
                "ok": false,
                "error": {"code": "SERVICE_ERROR", "message": "private-marker"}
            }),
            events: Vec::new(),
        };
        let malformed = crate::process::HostReply {
            response: json!({"id": "quit-stop-malformed"}),
            events: Vec::new(),
        };

        assert!(validate_runtime_stop_reply(&success).is_ok());
        for reply in [&failure, &malformed] {
            let error = validate_runtime_stop_reply(reply).expect_err("stop must fail closed");
            assert_eq!(error.code, "RUNTIME_STOP_FAILED");
            let serialized = serde_json::to_string(&error).expect("serialize safe error");
            assert!(!serialized.contains("private-marker"));
        }
    }

    #[test]
    fn stop_and_quit_validates_the_reply_before_owned_termination_and_exit() {
        let source = include_str!("commands.rs");
        let function = source
            .split_once("pub(crate) fn confirm_quit_internal")
            .expect("quit function")
            .1
            .split_once("fn write_first_run_files")
            .expect("quit function boundary")
            .0;
        let branch = function
            .split_once("QuitDecision::StopOwnedAndExit =>")
            .expect("stop-and-quit branch")
            .1;
        let validate = branch
            .find("validate_runtime_stop_reply(&reply)")
            .expect("reply validation");
        let terminate = branch
            .find(".stop_owned(&nonce)")
            .expect("exact owned termination");
        let exit = branch.find("app.exit(0)").expect("application exit");

        assert!(validate < terminate);
        assert!(terminate < exit);
    }

    #[test]
    fn confirmed_quit_never_strands_the_process_when_the_graceful_stop_fails() {
        let source = include_str!("commands.rs");
        let function = source
            .split_once("pub(crate) fn confirm_quit_internal")
            .expect("quit function")
            .1
            .split_once("fn write_first_run_files")
            .expect("quit function boundary")
            .0;
        let branch = function
            .split_once("QuitDecision::StopOwnedAndExit =>")
            .expect("stop-and-quit branch")
            .1;

        // The graceful runtime.stop exchange is best-effort: a failed or
        // rejected reply (timeout, crashed host) must still terminate the
        // owned host and exit instead of returning an error.
        assert!(branch.contains("if let Ok(reply) = supervisor.invoke(&stop)"));
        let invoke = branch
            .find("supervisor.invoke(&stop)")
            .expect("graceful stop invoke");
        let terminate = branch
            .find(".stop_owned(&nonce)")
            .expect("exact owned termination");
        let exit = branch.find("app.exit(0)").expect("application exit");
        assert!(invoke < terminate);
        assert!(terminate < exit);
        // Ownership stays optional: the host may already be gone after a
        // failed exchange, and no owned process means a safe direct exit.
        assert!(branch.contains("if let Some(nonce) = supervisor.ownership_nonce()"));
    }

    #[test]
    fn quit_gate_tracks_only_the_latest_unacknowledged_request() {
        let gate = QuitGate::default();
        let first = gate.begin_request();
        assert!(gate.is_unacknowledged(first));

        let second = gate.begin_request();
        assert!(!gate.is_unacknowledged(first), "stale request is inert");
        assert!(gate.is_unacknowledged(second));

        gate.acknowledge();
        assert!(
            !gate.is_unacknowledged(second),
            "acknowledged request is inert"
        );

        let third = gate.begin_request();
        assert!(
            gate.is_unacknowledged(third),
            "a new request re-arms the gate"
        );
    }

    #[test]
    fn first_run_config_failure_restores_the_previous_password_hash() {
        let directory = tempfile::tempdir().expect("temp directory");
        let paths = DesktopPaths {
            config_file: directory.path().join("toolspan.config.json"),
            password_file: directory.path().join("owner.bcrypt"),
            node_settings_file: directory.path().join("node.json"),
            app_data_root: directory.path().join("data"),
            app_log_root: directory.path().join("logs"),
        };
        fs::write(&paths.password_file, "previous-hash\n").expect("old password fixture");
        fs::write(&paths.config_file, "{}\n").expect("external config fixture");
        let candidate = json!({
            "instanceName": "Desk",
            "host": "127.0.0.1",
            "port": 8787,
            "publicBaseUrl": "http://127.0.0.1:8787",
            "allowedRoots": ["C:/work"],
            "stateDirectory": "C:/private/state",
            "ownerPasswordHashFile": "C:/private/owner.bcrypt",
            "allowedOrigins": ["http://127.0.0.1"]
        });
        assert!(write_first_run_files(&paths, None, &candidate, "new-hash").is_err());
        assert_eq!(
            fs::read_to_string(&paths.password_file).expect("restored password"),
            "previous-hash\n"
        );
        assert_eq!(
            fs::read_to_string(&paths.config_file).expect("external config preserved"),
            "{}\n"
        );
    }

    #[test]
    fn password_write_failure_never_creates_the_config() {
        let directory = tempfile::tempdir().expect("temp directory");
        let blocker = directory.path().join("not-a-directory");
        fs::write(&blocker, "block").expect("blocker fixture");
        let paths = DesktopPaths {
            config_file: directory.path().join("toolspan.config.json"),
            password_file: blocker.join("owner.bcrypt"),
            node_settings_file: directory.path().join("node.json"),
            app_data_root: directory.path().join("data"),
            app_log_root: directory.path().join("logs"),
        };
        let candidate = json!({
            "instanceName": "Desk",
            "host": "127.0.0.1",
            "port": 8787,
            "publicBaseUrl": "http://127.0.0.1:8787",
            "allowedRoots": ["C:/work"],
            "stateDirectory": "C:/private/state",
            "ownerPasswordHashFile": "C:/private/owner.bcrypt",
            "allowedOrigins": ["http://127.0.0.1"]
        });
        assert!(write_first_run_files(&paths, None, &candidate, "new-hash").is_err());
        assert!(!paths.config_file.exists());
    }

    #[test]
    fn first_run_contract_contains_safe_local_defaults() {
        let directory = tempfile::tempdir().expect("temp directory");
        let paths = DesktopPaths {
            config_file: directory.path().join("missing-config.json"),
            password_file: directory.path().join("owner.bcrypt"),
            node_settings_file: directory.path().join("node.json"),
            app_data_root: directory.path().join("data"),
            app_log_root: directory.path().join("logs"),
        };
        let resource = directory.path().join("desktop-host").join("main.js");
        let state = DesktopState::new(paths, resource).expect("desktop state");
        let request = DesktopRequest {
            id: "snapshot".into(),
            method: "runtime.getSnapshot".into(),
            params: json!({}),
        };
        let response = first_run_snapshot_response(&request, &state).expect("snapshot response");
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["firstRunRequired"], true);
        assert_eq!(response["result"]["toolContract"]["total"], 27);
        assert_eq!(
            response["result"]["connection"]["publicBaseUrl"],
            Value::Null
        );
        assert!(
            response["result"]["statePath"]
                .as_str()
                .expect("state path")
                .contains("data")
        );
    }

    #[test]
    fn host_snapshot_is_merged_into_the_ui_fixture_shape() {
        let directory = tempfile::tempdir().expect("temp directory");
        let paths = DesktopPaths {
            config_file: directory.path().join("toolspan.config.json"),
            password_file: directory.path().join("owner.bcrypt"),
            node_settings_file: directory.path().join("node.json"),
            app_data_root: directory.path().join("data"),
            app_log_root: directory.path().join("logs"),
        };
        let resource = directory.path().join("desktop-host").join("main.js");
        let state = DesktopState::new(paths, resource).expect("desktop state");
        let host = json!({
            "id": "snapshot",
            "ok": true,
            "result": {
                "state": "running",
                "productVersion": env!("CARGO_PKG_VERSION"),
                "instanceName": "Workstation",
                "localEndpoint": "http://127.0.0.1:8787/mcp",
                "publicBaseUrl": "https://mcp.example.com",
                "mcpTools": {"available": 27, "total": 27},
                "uptimeSeconds": 10,
                "localReady": true,
                "publicReady": true,
                "recentJobs": [],
                "recentArtifacts": []
            }
        });
        let merged = merge_runtime_snapshot_response(host, &state).expect("merged response");
        assert_eq!(merged["result"]["firstRunRequired"], false);
        assert_eq!(merged["result"]["core"]["state"], "running");
        assert_eq!(merged["result"]["connection"]["localReady"], true);
        assert_eq!(merged["result"]["toolContract"]["available"], 27);
        assert!(merged["result"]["state"].is_null());
    }
}
