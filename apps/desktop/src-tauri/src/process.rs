use std::env;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use rand::RngCore;
use serde_json::{Value, json};
use thiserror::Error;
use zeroize::Zeroizing;

use crate::node::{NodeError, first_supported_node, require_regular_file};
use crate::protocol::{
    DESKTOP_PROTOCOL_VERSION, DesktopRequest, MAX_PROTOCOL_MESSAGE_BYTES, ProtocolError, RequestIds,
};

pub const FIXED_HOST_RESOURCE: &str = "desktop-host/main.js";
const HOST_RESPONSE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Error)]
pub enum HostError {
    #[error(transparent)]
    Node(#[from] NodeError),
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error("desktop host resource is not the fixed desktop-host/main.js resource")]
    InvalidHostResource,
    #[error("desktop host could not be started")]
    Spawn,
    #[error("desktop host stdin failed")]
    Write,
    #[error("desktop host exited or closed stdout")]
    Crashed,
    #[error("desktop host response timed out")]
    Timeout,
    #[error("desktop host emitted invalid or oversized protocol output")]
    InvalidOutput,
    #[error("desktop host response id did not match the request")]
    ResponseIdMismatch,
    #[error("desktop host ownership nonce did not match")]
    OwnershipMismatch,
    #[error("an observed external process is never eligible for termination")]
    ExternalProcess,
}

impl HostError {
    pub const fn safe_code(&self) -> &'static str {
        match self {
            Self::Node(_) => "DESKTOP_HOST_NODE_UNAVAILABLE",
            Self::Protocol(_) => "DESKTOP_HOST_PROTOCOL_REJECTED",
            Self::InvalidHostResource => "DESKTOP_HOST_RESOURCE_INVALID",
            Self::Spawn => "DESKTOP_HOST_SPAWN_FAILED",
            Self::Write => "DESKTOP_HOST_WRITE_FAILED",
            Self::Crashed => "DESKTOP_HOST_CRASHED",
            Self::Timeout => "DESKTOP_HOST_TIMEOUT",
            Self::InvalidOutput => "DESKTOP_HOST_OUTPUT_INVALID",
            Self::ResponseIdMismatch => "DESKTOP_HOST_RESPONSE_ID_MISMATCH",
            Self::OwnershipMismatch => "DESKTOP_HOST_OWNERSHIP_MISMATCH",
            Self::ExternalProcess => "DESKTOP_HOST_EXTERNAL_PROCESS",
        }
    }
}

#[derive(Debug, Clone)]
pub struct HostLaunch {
    configured_node: Option<PathBuf>,
    resource_path: PathBuf,
    config_path: PathBuf,
}

impl HostLaunch {
    pub fn new(
        configured_node: Option<PathBuf>,
        resource_path: PathBuf,
        config_path: PathBuf,
    ) -> Result<Self, HostError> {
        if !has_fixed_resource_suffix(&resource_path) {
            return Err(HostError::InvalidHostResource);
        }
        Ok(Self {
            configured_node,
            resource_path,
            config_path,
        })
    }
}

fn has_fixed_resource_suffix(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()) == Some("main.js")
        && path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            == Some("desktop-host")
}

#[derive(Debug)]
pub struct HostReply {
    pub response: Value,
    pub events: Vec<Value>,
}

#[derive(Debug)]
pub struct HostSupervisor {
    launch: HostLaunch,
    child: Option<OwnedHost>,
}

impl HostSupervisor {
    pub fn new(launch: HostLaunch) -> Self {
        Self {
            launch,
            child: None,
        }
    }

    pub fn invoke(&mut self, request: &DesktopRequest) -> Result<HostReply, HostError> {
        request.validate()?;
        if self.child.is_none() {
            self.child = Some(spawn_host(&self.launch)?);
        }

        let result = self
            .child
            .as_mut()
            .expect("child was initialized")
            .exchange(request, HOST_RESPONSE_TIMEOUT);
        if matches!(
            result,
            Err(HostError::Crashed
                | HostError::Timeout
                | HostError::InvalidOutput
                | HostError::ResponseIdMismatch
                | HostError::Write)
        ) {
            self.stop_current_owned();
        }
        result
    }

    pub fn ownership_nonce(&self) -> Option<&str> {
        self.child.as_ref().map(|child| child.nonce.as_str())
    }

    pub fn set_configured_node(&mut self, path: PathBuf) {
        self.stop_current_owned();
        self.launch.configured_node = Some(path);
    }

    pub fn stop_owned(&mut self, expected_nonce: &str) -> Result<(), HostError> {
        let Some(child) = self.child.as_mut() else {
            return Ok(());
        };
        child.stop(expected_nonce)?;
        self.child = None;
        Ok(())
    }

    fn stop_current_owned(&mut self) {
        if let Some(mut child) = self.child.take() {
            let nonce = child.nonce.clone();
            let _ = child.stop(&nonce);
        }
    }
}

impl Drop for HostSupervisor {
    fn drop(&mut self) {
        self.stop_current_owned();
    }
}

#[derive(Debug)]
struct OwnedHost {
    child: Child,
    stdin: ChildStdin,
    output: Receiver<Result<Vec<u8>, ()>>,
    nonce: String,
    ids: RequestIds,
}

impl OwnedHost {
    fn exchange(
        &mut self,
        request: &DesktopRequest,
        timeout: Duration,
    ) -> Result<HostReply, HostError> {
        self.ids.record(&request.id)?;
        let mut encoded =
            Zeroizing::new(serde_json::to_vec(request).map_err(|_| HostError::InvalidOutput)?);
        if encoded.len() > MAX_PROTOCOL_MESSAGE_BYTES {
            return Err(HostError::Protocol(ProtocolError::Oversize));
        }
        encoded.push(b'\n');
        self.stdin
            .write_all(&encoded)
            .and_then(|()| self.stdin.flush())
            .map_err(|_| HostError::Write)?;

        let deadline = Instant::now() + timeout;
        let mut events = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(HostError::Timeout);
            }
            let line = match self.output.recv_timeout(remaining) {
                Ok(Ok(line)) => line,
                Ok(Err(())) | Err(RecvTimeoutError::Disconnected) => {
                    return Err(HostError::Crashed);
                }
                Err(RecvTimeoutError::Timeout) => return Err(HostError::Timeout),
            };
            let value: Value =
                serde_json::from_slice(&line).map_err(|_| HostError::InvalidOutput)?;
            if value.get("event").and_then(Value::as_str).is_some() && value.get("id").is_none() {
                events.push(value);
                continue;
            }
            if value.get("id").and_then(Value::as_str) != Some(request.id.as_str()) {
                return Err(HostError::ResponseIdMismatch);
            }
            return Ok(HostReply {
                response: value,
                events,
            });
        }
    }

    fn stop(&mut self, expected_nonce: &str) -> Result<(), HostError> {
        if expected_nonce != self.nonce {
            return Err(HostError::OwnershipMismatch);
        }
        self.terminate_and_wait()
    }

    fn terminate_and_wait(&mut self) -> Result<(), HostError> {
        match self.child.try_wait() {
            Ok(Some(_)) => Ok(()),
            Ok(None) => {
                self.child.kill().map_err(|_| HostError::Crashed)?;
                self.child.wait().map_err(|_| HostError::Crashed)?;
                Ok(())
            }
            Err(_) => {
                let _ = self.child.kill();
                self.child.wait().map_err(|_| HostError::Crashed)?;
                Ok(())
            }
        }
    }
}

impl Drop for OwnedHost {
    fn drop(&mut self) {
        let _ = self.terminate_and_wait();
    }
}

fn spawn_host(launch: &HostLaunch) -> Result<OwnedHost, HostError> {
    require_regular_file(&launch.resource_path)?;
    let node = first_supported_node(launch.configured_node.as_deref())?;
    let nonce = random_nonce();
    let resource_argument = node_entry_argument(&launch.resource_path);
    let mut command = Command::new(&node.path);
    command
        .arg(resource_argument)
        .env_clear()
        .envs(safe_child_environment())
        .env("TOOLSPAN_CONFIG", &launch.config_path)
        .env("TOOLSPAN_DESKTOP_OWNERSHIP_NONCE", &nonce)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    let mut child = command.spawn().map_err(|_| HostError::Spawn)?;
    let stdin = child.stdin.take().ok_or(HostError::Spawn)?;
    let stdout = child.stdout.take().ok_or(HostError::Spawn)?;
    let stderr = child.stderr.take().ok_or(HostError::Spawn)?;
    let (sender, output) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_bounded_line(&mut reader, MAX_PROTOCOL_MESSAGE_BYTES) {
                Ok(Some(line)) => {
                    if sender.send(Ok(line)).is_err() {
                        break;
                    }
                }
                Ok(None) => {
                    let _ = sender.send(Err(()));
                    break;
                }
                Err(_) => {
                    let _ = sender.send(Err(()));
                    break;
                }
            }
        }
    });
    thread::spawn(move || {
        let mut stderr = stderr;
        let _ = io::copy(&mut stderr, &mut io::sink());
    });

    let mut owned = OwnedHost {
        child,
        stdin,
        output,
        nonce,
        ids: RequestIds::default(),
    };
    let hello = DesktopRequest {
        id: format!("rust-hello-{}", random_nonce()),
        method: "system.hello".into(),
        params: json!({
            "protocolVersion": DESKTOP_PROTOCOL_VERSION,
            "productVersion": env!("CARGO_PKG_VERSION")
        }),
    };
    let reply = owned.exchange(&hello, HOST_RESPONSE_TIMEOUT)?;
    if reply.response.get("ok").and_then(Value::as_bool) != Some(true)
        || reply
            .response
            .pointer("/result/protocolVersion")
            .and_then(Value::as_u64)
            != Some(DESKTOP_PROTOCOL_VERSION)
        || reply
            .response
            .pointer("/result/productVersion")
            .and_then(Value::as_str)
            != Some(env!("CARGO_PKG_VERSION"))
        || !reply
            .response
            .pointer("/result/capabilities")
            .and_then(Value::as_array)
            .is_some_and(|capabilities| {
                capabilities
                    .iter()
                    .any(|capability| capability.as_str() == Some("setup"))
            })
    {
        let nonce = owned.nonce.clone();
        let _ = owned.stop(&nonce);
        return Err(HostError::InvalidOutput);
    }
    Ok(owned)
}

fn node_entry_argument(path: &Path) -> PathBuf {
    dunce::simplified(path).to_path_buf()
}

fn random_nonce() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn safe_child_environment() -> Vec<(String, String)> {
    const ALLOWED: &[&str] = &[
        "APPDATA",
        "HOME",
        "LANG",
        "LOCALAPPDATA",
        "PROGRAMDATA",
        "SystemRoot",
        "TEMP",
        "TMP",
        "TZ",
        "USERPROFILE",
        "WINDIR",
    ];
    ALLOWED
        .iter()
        .filter_map(|name| env::var(name).ok().map(|value| ((*name).to_owned(), value)))
        .collect()
}

fn read_bounded_line<R: BufRead>(reader: &mut R, maximum: usize) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err(io::ErrorKind::UnexpectedEof.into())
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(available.len(), |index| index + 1);
        if line.len().saturating_add(take) > maximum + 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "oversized JSONL line",
            ));
        }
        line.extend_from_slice(&available[..take]);
        reader.consume(take);
        if newline.is_some() {
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(line));
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObservedProcess {
    None,
    Owned { nonce: String },
    External { pid: u32 },
}

impl ObservedProcess {
    pub fn authorize_stop(&self, nonce: &str) -> Result<(), HostError> {
        match self {
            Self::None => Ok(()),
            Self::Owned { nonce: owned } if owned == nonce => Ok(()),
            Self::Owned { .. } => Err(HostError::OwnershipMismatch),
            Self::External { .. } => Err(HostError::ExternalProcess),
        }
    }
}

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    #[cfg(windows)]
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    #[cfg(windows)]
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
    };

    use super::*;

    #[cfg(windows)]
    const LIVE_CHILD_SENTINEL_ENV: &str = "TOOLSPAN_TEST_LIVE_CHILD_SENTINEL";

    #[cfg(windows)]
    #[test]
    fn initial_handshake_error_reaps_the_live_owned_child() {
        if let Some(sentinel) = env::var_os(LIVE_CHILD_SENTINEL_ENV) {
            std::fs::write(sentinel, std::process::id().to_string())
                .expect("write live-child sentinel");
            loop {
                thread::sleep(Duration::from_secs(60));
            }
        }

        let temporary = tempfile::tempdir().expect("temporary directory");
        let sentinel = temporary.path().join("live-child.pid");
        let mut command = Command::new(env::current_exe().expect("current test executable"));
        command
            .args([
                "--exact",
                "process::tests::initial_handshake_error_reaps_the_live_owned_child",
                "--nocapture",
            ])
            .env_clear()
            .env(LIVE_CHILD_SENTINEL_ENV, &sentinel)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_window(&mut command);
        let mut child = command.spawn().expect("spawn live owned-child fixture");
        let fixture_deadline = Instant::now() + Duration::from_secs(5);
        while !sentinel.is_file() {
            if child.try_wait().expect("query child fixture").is_some() {
                panic!("live owned-child fixture exited before its sentinel");
            }
            if Instant::now() >= fixture_deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("live owned-child fixture did not become ready");
            }
            thread::sleep(Duration::from_millis(10));
        }

        let process_handle =
            unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, child.id()) };
        assert!(!process_handle.is_null(), "open exact child process handle");
        let stdin = child.stdin.take().expect("owned child stdin");
        let (_sender, output) = mpsc::channel();
        let request = DesktopRequest {
            id: "initial-handshake-timeout".into(),
            method: "system.hello".into(),
            params: json!({
                "protocolVersion": DESKTOP_PROTOCOL_VERSION,
                "productVersion": env!("CARGO_PKG_VERSION")
            }),
        };
        let failed = (|| -> Result<(), HostError> {
            let mut owned = OwnedHost {
                child,
                stdin,
                output,
                nonce: "test-owned-nonce".into(),
                ids: RequestIds::default(),
            };
            owned.exchange(&request, Duration::from_millis(50))?;
            Ok(())
        })();
        assert!(matches!(failed, Err(HostError::Timeout)));

        let wait_result = unsafe { WaitForSingleObject(process_handle, 1_000) };
        if wait_result != WAIT_OBJECT_0 {
            unsafe {
                TerminateProcess(process_handle, 1);
                WaitForSingleObject(process_handle, 5_000);
            }
        }
        unsafe {
            CloseHandle(process_handle);
        }
        assert_eq!(
            wait_result, WAIT_OBJECT_0,
            "initial handshake failure left its exact owned child alive"
        );
    }

    #[test]
    fn only_the_fixed_resource_suffix_is_accepted() {
        assert!(has_fixed_resource_suffix(Path::new(
            "C:/app/resources/desktop-host/main.js"
        )));
        assert!(!has_fixed_resource_suffix(Path::new(
            "C:/app/resources/desktop-host/other.js"
        )));
        assert!(!has_fixed_resource_suffix(Path::new("C:/tmp/main.js")));
    }

    #[cfg(windows)]
    #[test]
    fn node_entry_argument_converts_windows_extended_paths() {
        assert_eq!(
            node_entry_argument(Path::new(
                r"\\?\C:\Program Files\ToolSpan\desktop-host\main.js"
            )),
            PathBuf::from(r"C:\Program Files\ToolSpan\desktop-host\main.js")
        );
        for unchanged in [
            r"\\?\UNC\server\share\ToolSpan\desktop-host\main.js",
            r"\\?\C:\CON\desktop-host\main.js",
        ] {
            assert_eq!(
                node_entry_argument(Path::new(unchanged)),
                PathBuf::from(unchanged)
            );
        }
        let long = format!(r"\\?\C:\{}\desktop-host\main.js", "a".repeat(240));
        assert_eq!(node_entry_argument(Path::new(&long)), PathBuf::from(long));
    }

    #[test]
    fn external_process_is_never_authorized_for_stop() {
        let process = ObservedProcess::External { pid: 1234 };
        assert!(matches!(
            process.authorize_stop("anything"),
            Err(HostError::ExternalProcess)
        ));
    }

    #[test]
    fn owned_process_requires_the_exact_nonce() {
        let process = ObservedProcess::Owned {
            nonce: "owner".into(),
        };
        assert!(matches!(
            process.authorize_stop("wrong"),
            Err(HostError::OwnershipMismatch)
        ));
        assert!(process.authorize_stop("owner").is_ok());
    }

    #[test]
    fn bounded_jsonl_reader_rejects_oversize_without_allocating_it_all() {
        let bytes = vec![b'x'; 32];
        let mut reader = Cursor::new(bytes);
        assert!(read_bounded_line(&mut reader, 16).is_err());
    }

    #[test]
    fn child_environment_does_not_inherit_credentials() {
        let names: Vec<_> = safe_child_environment()
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert!(!names.iter().any(|name| name.contains("KEY")));
        assert!(!names.iter().any(|name| name.contains("TOKEN")));
        assert!(!names.iter().any(|name| name.contains("SECRET")));
    }

    #[test]
    fn host_errors_expose_only_stable_safe_codes() {
        let cases = [
            (
                HostError::Node(NodeError::UnsupportedVersion("private-marker".into())),
                "DESKTOP_HOST_NODE_UNAVAILABLE",
            ),
            (
                HostError::Protocol(ProtocolError::DuplicateRequestId),
                "DESKTOP_HOST_PROTOCOL_REJECTED",
            ),
            (
                HostError::InvalidHostResource,
                "DESKTOP_HOST_RESOURCE_INVALID",
            ),
            (HostError::Spawn, "DESKTOP_HOST_SPAWN_FAILED"),
            (HostError::Write, "DESKTOP_HOST_WRITE_FAILED"),
            (HostError::Crashed, "DESKTOP_HOST_CRASHED"),
            (HostError::Timeout, "DESKTOP_HOST_TIMEOUT"),
            (HostError::InvalidOutput, "DESKTOP_HOST_OUTPUT_INVALID"),
            (
                HostError::ResponseIdMismatch,
                "DESKTOP_HOST_RESPONSE_ID_MISMATCH",
            ),
            (
                HostError::OwnershipMismatch,
                "DESKTOP_HOST_OWNERSHIP_MISMATCH",
            ),
            (HostError::ExternalProcess, "DESKTOP_HOST_EXTERNAL_PROCESS"),
        ];
        for (error, expected) in cases {
            let code = error.safe_code();
            assert_eq!(code, expected);
            assert!(code.is_ascii());
            assert!(!code.contains("private-marker"));
            assert!(!code.contains(['/', '\\']));
        }
    }
}
