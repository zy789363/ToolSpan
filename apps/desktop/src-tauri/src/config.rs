use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rand::RngCore;
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

const BACKUP_LIMIT: usize = 3;

#[derive(Debug, Clone)]
pub struct ConfigSnapshot {
    pub value: Value,
    pub hash: String,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("configuration could not be read or written")]
    Io(#[from] io::Error),
    #[error("configuration is not valid JSON")]
    Json(#[from] serde_json::Error),
    #[error("configuration validation failed: {0}")]
    Validation(String),
    #[error("configuration changed outside ToolSpan; reload before saving")]
    Conflict,
    #[error("configuration verification failed after the atomic replace")]
    ReRead,
}

pub fn content_hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn read_json_config(path: &Path) -> Result<Option<ConfigSnapshot>, ConfigError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let value = serde_json::from_slice(&bytes)?;
    Ok(Some(ConfigSnapshot {
        value,
        hash: content_hash(&bytes),
    }))
}

pub fn write_json_config<F>(
    path: &Path,
    expected_hash: Option<&str>,
    candidate: &Value,
    validate: F,
) -> Result<ConfigSnapshot, ConfigError>
where
    F: Fn(&Value) -> Result<(), String>,
{
    validate(candidate).map_err(ConfigError::Validation)?;
    let current = read_json_config(path)?;
    if current.as_ref().map(|snapshot| snapshot.hash.as_str()) != expected_hash {
        return Err(ConfigError::Conflict);
    }

    let mut bytes = serde_json::to_vec_pretty(candidate)?;
    bytes.push(b'\n');
    let backup = current.as_ref().map(|_| create_backup(path)).transpose()?;
    if let Err(error) = atomic_write(path, &bytes) {
        rollback(path, backup.as_deref())?;
        return Err(error.into());
    }

    let verified = match read_json_config(path) {
        Ok(Some(snapshot))
            if snapshot.hash == content_hash(&bytes) && validate(&snapshot.value).is_ok() =>
        {
            snapshot
        }
        _ => {
            rollback(path, backup.as_deref())?;
            return Err(ConfigError::ReRead);
        }
    };
    retain_newest_backups(path, BACKUP_LIMIT)?;
    Ok(verified)
}

pub fn write_private_text(path: &Path, contents: &str) -> Result<(), ConfigError> {
    atomic_write(path, contents.as_bytes())?;
    let reread = fs::read(path)?;
    if reread != contents.as_bytes() {
        return Err(ConfigError::ReRead);
    }
    Ok(())
}

fn atomic_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "path must have a parent directory",
        )
    })?;
    fs::create_dir_all(parent)?;
    let temporary = sibling_path(path, "tmp");
    let result = (|| {
        let mut file = private_create_new(&temporary)?;
        file.write_all(contents)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        atomic_replace(&temporary, path)?;
        sync_parent(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn create_backup(path: &Path) -> io::Result<PathBuf> {
    let backup = sibling_path(path, "backup");
    fs::copy(path, &backup)?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(&backup)?
        .sync_all()?;
    Ok(backup)
}

fn rollback(path: &Path, backup: Option<&Path>) -> io::Result<()> {
    match backup {
        Some(backup) => {
            let bytes = fs::read(backup)?;
            atomic_write(path, &bytes)
        }
        None => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        },
    }
}

fn retain_newest_backups(path: &Path, keep: usize) -> io::Result<()> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return Ok(());
    };
    let prefix = format!("{file_name}.backup.");
    let mut backups = Vec::new();
    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        if entry.file_type()?.is_file() && entry.file_name().to_string_lossy().starts_with(&prefix)
        {
            let modified = entry
                .metadata()?
                .modified()
                .unwrap_or(SystemTime::UNIX_EPOCH);
            backups.push((modified, entry.path()));
        }
    }
    backups.sort_by(|left, right| right.cmp(left));
    for (_, old) in backups.into_iter().skip(keep) {
        fs::remove_file(old)?;
    }
    Ok(())
}

fn sibling_path(path: &Path, kind: &str) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut random = [0_u8; 8];
    rand::rng().fill_bytes(&mut random);
    let random: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default();
    path.with_file_name(format!("{file_name}.{kind}.{timestamp}.{random}"))
}

fn private_create_new(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(unix)]
fn sync_parent(parent: &Path) -> io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent(_parent: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn valid(value: &Value) -> Result<(), String> {
        value
            .get("instanceName")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .map(|_| ())
            .ok_or_else(|| "instanceName is required".into())
    }

    #[test]
    fn hash_conflict_never_overwrites_external_change() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("toolspan.config.json");
        let first = write_json_config(&path, None, &json!({"instanceName":"one"}), valid)
            .expect("first write");
        fs::write(&path, b"{\"instanceName\":\"external\"}\n").expect("external edit");

        assert!(matches!(
            write_json_config(
                &path,
                Some(&first.hash),
                &json!({"instanceName":"ours"}),
                valid
            ),
            Err(ConfigError::Conflict)
        ));
        assert!(
            fs::read_to_string(path)
                .expect("read result")
                .contains("external")
        );
    }

    #[test]
    fn newest_three_backups_are_retained() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("toolspan.config.json");
        let mut snapshot = write_json_config(&path, None, &json!({"instanceName":"zero"}), valid)
            .expect("initial write");
        for index in 1..=5 {
            snapshot = write_json_config(
                &path,
                Some(&snapshot.hash),
                &json!({"instanceName": format!("value-{index}")}),
                valid,
            )
            .expect("update");
        }
        let backups = fs::read_dir(directory.path())
            .expect("read directory")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".backup."))
            .count();
        assert_eq!(backups, BACKUP_LIMIT);
        assert_eq!(
            read_json_config(&path)
                .expect("read config")
                .expect("config exists")
                .value["instanceName"],
            "value-5"
        );
    }

    #[test]
    fn invalid_candidate_is_rejected_before_any_write() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("toolspan.config.json");
        assert!(matches!(
            write_json_config(&path, None, &json!({}), valid),
            Err(ConfigError::Validation(_))
        ));
        assert!(!path.exists());
    }
}
