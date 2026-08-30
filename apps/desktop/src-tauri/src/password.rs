use bcrypt::{DEFAULT_COST, hash};
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

const BCRYPT_MAX_PASSWORD_BYTES: usize = 72;
const MIN_PASSWORD_CHARACTERS: usize = 8;
const MAX_PASSWORD_CHARACTERS: usize = 128;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PasswordError {
    #[error("owner password must contain at least 8 characters")]
    TooShort,
    #[error("owner password must contain at most 128 characters")]
    TooManyCharacters,
    #[error("owner password must be at most 72 UTF-8 bytes")]
    TooLong,
    #[error("owner password hash could not be generated")]
    Hash,
    #[error("owner password hash is not a bcrypt hash")]
    InvalidHash,
}

pub fn hash_owner_password_local(mut password: String) -> Result<String, PasswordError> {
    let protected = Zeroizing::new(std::mem::take(&mut password));
    password.zeroize();
    let characters = protected.chars().count();
    if characters < MIN_PASSWORD_CHARACTERS {
        return Err(PasswordError::TooShort);
    }
    if characters > MAX_PASSWORD_CHARACTERS {
        return Err(PasswordError::TooManyCharacters);
    }
    if protected.len() > BCRYPT_MAX_PASSWORD_BYTES {
        return Err(PasswordError::TooLong);
    }
    hash(protected.as_bytes(), DEFAULT_COST).map_err(|_| PasswordError::Hash)
}

pub fn validate_bcrypt_hash(value: &str) -> Result<(), PasswordError> {
    let bytes = value.as_bytes();
    let prefix_ok = matches!(
        bytes.get(..4),
        Some(b"$2a$") | Some(b"$2b$") | Some(b"$2y$")
    );
    let cost_ok = bytes.get(4..6).is_some_and(|cost| {
        cost.iter().all(u8::is_ascii_digit)
            && bytes.get(6) == Some(&b'$')
            && std::str::from_utf8(cost)
                .ok()
                .and_then(|cost| cost.parse::<u8>().ok())
                .is_some_and(|cost| (4..=31).contains(&cost))
    });
    let alphabet_ok = bytes.get(7..).is_some_and(|tail| {
        tail.len() == 53
            && tail
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'/'))
    });
    if bytes.len() == 60 && prefix_ok && cost_ok && alphabet_ok {
        Ok(())
    } else {
        Err(PasswordError::InvalidHash)
    }
}

#[cfg(test)]
mod tests {
    use bcrypt::verify;

    use super::*;

    #[test]
    fn hashes_locally_with_bcrypt_without_returning_plaintext() {
        let plaintext = "correct horse battery staple";
        let hashed = hash_owner_password_local(plaintext.into()).expect("hash password");
        assert_ne!(hashed, plaintext);
        assert!(!hashed.contains(plaintext));
        assert!(verify(plaintext, &hashed).expect("verify bcrypt"));
        assert_eq!(validate_bcrypt_hash(&hashed), Ok(()));
    }

    #[test]
    fn enforces_the_eight_character_rust_boundary() {
        assert_eq!(
            hash_owner_password_local("x".repeat(7)),
            Err(PasswordError::TooShort)
        );
        assert!(hash_owner_password_local("x".repeat(8)).is_ok());
    }

    #[test]
    fn rejects_bcrypt_truncating_inputs() {
        assert_eq!(
            hash_owner_password_local("x".repeat(73)),
            Err(PasswordError::TooLong)
        );
    }

    #[test]
    fn plaintext_is_not_accepted_as_a_stored_hash() {
        assert_eq!(
            validate_bcrypt_hash("owner-password"),
            Err(PasswordError::InvalidHash)
        );
    }
}
