use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use semver::Version;
use serde::Serialize;
use thiserror::Error;

const NODE_VERSION_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_VERSION_OUTPUT_BYTES: usize = 256;
const NODE_VERSION_ENVIRONMENT_ALLOWLIST: &[&str] = &[];
#[cfg(windows)]
const WINDOWS_WHERE_ENVIRONMENT_ALLOWLIST: &[&str] = &["PATH", "PATHEXT", "SystemRoot"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatedNode {
    pub path: PathBuf,
    pub version: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum NodeError {
    #[error("the selected Node executable is not a regular file")]
    NotRegularFile,
    #[error("the selected executable did not report a valid Node version")]
    InvalidVersionOutput,
    #[error("Node {0} is unsupported; use ^22.17 or ^24")]
    UnsupportedVersion(String),
    #[error("Node version validation timed out")]
    VersionTimeout,
    #[error("could not execute the selected Node file")]
    Execute,
}

pub fn is_supported_node_version(raw: &str) -> Result<Version, NodeError> {
    let raw = raw.trim();
    let raw = raw.strip_prefix('v').unwrap_or(raw);
    let version = Version::parse(raw).map_err(|_| NodeError::InvalidVersionOutput)?;
    if !version.pre.is_empty() {
        return Err(NodeError::UnsupportedVersion(version.to_string()));
    }
    let supported = (version.major == 22 && version.minor >= 17) || version.major == 24;
    if !supported {
        return Err(NodeError::UnsupportedVersion(version.to_string()));
    }
    Ok(version)
}

pub fn require_regular_file(path: &Path) -> Result<(), NodeError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| NodeError::NotRegularFile)?;
    if !metadata.file_type().is_file() {
        return Err(NodeError::NotRegularFile);
    }
    Ok(())
}

pub fn validate_node_executable(path: &Path) -> Result<ValidatedNode, NodeError> {
    require_regular_file(path)?;
    let mut command = Command::new(path);
    command
        .env_clear()
        .envs(allowlisted_environment(NODE_VERSION_ENVIRONMENT_ALLOWLIST))
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    let mut child = command.spawn().map_err(|_| NodeError::Execute)?;
    let deadline = Instant::now() + NODE_VERSION_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child.wait_with_output().map_err(|_| NodeError::Execute)?;
                if !status.success() || output.stdout.len() > MAX_VERSION_OUTPUT_BYTES {
                    return Err(NodeError::InvalidVersionOutput);
                }
                let raw = std::str::from_utf8(&output.stdout)
                    .map_err(|_| NodeError::InvalidVersionOutput)?;
                let version = is_supported_node_version(raw)?;
                return Ok(ValidatedNode {
                    path: path.to_path_buf(),
                    version: version.to_string(),
                });
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(NodeError::VersionTimeout);
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(NodeError::Execute);
            }
        }
    }
}

pub fn discover_node(configured: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = configured {
        candidates.push(path.to_path_buf());
    }
    candidates.extend(path_candidates());
    #[cfg(windows)]
    candidates.extend(where_candidates());
    candidates.extend(common_install_candidates());

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|candidate| {
            let key = normalized_key(candidate);
            seen.insert(key)
        })
        .collect()
}

pub fn first_supported_node(configured: Option<&Path>) -> Result<ValidatedNode, NodeError> {
    let mut last_error = NodeError::NotRegularFile;
    for candidate in discover_node(configured) {
        match validate_node_executable(&candidate) {
            Ok(node) => return Ok(node),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

fn path_candidates() -> Vec<PathBuf> {
    let Some(path) = env::var_os("PATH") else {
        return Vec::new();
    };
    env::split_paths(&path)
        .map(|directory| directory.join(node_filename()))
        .collect()
}

#[cfg(windows)]
fn where_candidates() -> Vec<PathBuf> {
    let mut command = Command::new("where.exe");
    command
        .env_clear()
        .envs(allowlisted_environment(WINDOWS_WHERE_ENVIRONMENT_ALLOWLIST))
        .arg("node.exe")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped());
    hide_window(&mut command);
    let Ok(output) = command.output() else {
        return Vec::new();
    };
    if !output.status.success() || output.stdout.len() > 16 * 1024 {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .collect()
}

fn common_install_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = env::var_os(variable) {
            paths.push(PathBuf::from(root).join("nodejs").join(node_filename()));
        }
    }
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        paths.push(
            PathBuf::from(local)
                .join("Programs")
                .join("nodejs")
                .join(node_filename()),
        );
    }
    paths
}

fn allowlisted_environment(names: &[&str]) -> Vec<(OsString, OsString)> {
    names
        .iter()
        .filter_map(|name| env::var_os(name).map(|value| (OsString::from(name), value)))
        .collect()
}

fn node_filename() -> OsString {
    if cfg!(windows) {
        OsString::from("node.exe")
    } else {
        OsString::from("node")
    }
}

fn normalized_key(path: &Path) -> OsString {
    #[cfg(windows)]
    {
        OsString::from(path.to_string_lossy().to_lowercase())
    }
    #[cfg(not(windows))]
    {
        path.as_os_str().to_os_string()
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
    use super::*;

    #[test]
    fn accepts_only_the_frozen_node_ranges() {
        for accepted in ["v22.17.0", "22.99.1", "v24.0.0", "24.12.3"] {
            assert!(is_supported_node_version(accepted).is_ok(), "{accepted}");
        }
        for rejected in ["v22.16.9", "v23.0.0", "v25.0.0", "v24.0.0-rc.1", "not-node"] {
            assert!(is_supported_node_version(rejected).is_err(), "{rejected}");
        }
    }

    #[test]
    fn manual_selection_requires_a_regular_non_symlink_file() {
        let directory = tempfile::tempdir().expect("temp directory");
        let file = directory.path().join("node.exe");
        fs::write(&file, b"test").expect("write fixture");
        assert_eq!(require_regular_file(&file), Ok(()));
        assert_eq!(
            require_regular_file(directory.path()),
            Err(NodeError::NotRegularFile)
        );
    }

    #[test]
    fn configured_path_is_considered_first_and_duplicates_are_removed() {
        let configured = PathBuf::from("C:/explicit/node.exe");
        let discovered = discover_node(Some(&configured));
        assert_eq!(discovered.first(), Some(&configured));
        let unique: HashSet<_> = discovered.iter().map(|path| normalized_key(path)).collect();
        assert_eq!(unique.len(), discovered.len());
    }

    #[test]
    fn child_environment_allowlists_exclude_credentials() {
        assert!(NODE_VERSION_ENVIRONMENT_ALLOWLIST.is_empty());
        #[cfg(windows)]
        assert_eq!(
            WINDOWS_WHERE_ENVIRONMENT_ALLOWLIST,
            ["PATH", "PATHEXT", "SystemRoot"]
        );

        #[cfg(windows)]
        let names = NODE_VERSION_ENVIRONMENT_ALLOWLIST
            .iter()
            .chain(WINDOWS_WHERE_ENVIRONMENT_ALLOWLIST.iter());
        #[cfg(not(windows))]
        let names = NODE_VERSION_ENVIRONMENT_ALLOWLIST.iter();
        for name in names {
            let upper = name.to_ascii_uppercase();
            assert!(
                !["KEY", "TOKEN", "SECRET", "CREDENTIAL", "PASSWORD"]
                    .iter()
                    .any(|marker| upper.contains(marker))
            );
        }
    }
}
