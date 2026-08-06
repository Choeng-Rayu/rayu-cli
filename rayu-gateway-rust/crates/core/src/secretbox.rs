//! Opens the AES-256-GCM envelopes the backend writes for provider API keys.
//!
//! This is the read half of `rayu-backend/src/common/secretBox.ts`: the backend
//! seals a key when an admin saves it, and the gateway -- the only component that
//! actually calls an upstream -- opens it. The master key lives ONLY in
//! `RAYU_PROVIDER_SECRET` and must be the SAME value in both processes; it is
//! never stored beside the ciphertext.
//!
//! Envelope: `"v1:" + base64( iv(12) ‖ authTag(16) ‖ ciphertext )`
//!
//! GCM is authenticated, so a tampered or truncated row fails to open rather
//! than decrypting to attacker-chosen bytes. A failure here must mark the key
//! unusable -- never fall back to another value, which would send the wrong
//! credential upstream.
//!
//! # I1 -- zeroization
//!
//! [`Opener::open`] hands back a [`Zeroizing<String>`], so a decrypted key is
//! wiped from memory when the last holder drops it. The Go original returns a
//! plain `string` that lives until the GC reclaims it.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine as _;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const VERSION: &str = "v1";
const IV_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
/// Mirrors the backend: a short master key is refused rather than stretched, so
/// a weak secret cannot hide behind a hash.
const MIN_SECRET_LEN: usize = 32;

/// The environment variable holding the master key.
pub const SECRET_ENV: &str = "RAYU_PROVIDER_SECRET";

/// Returned when `RAYU_PROVIDER_SECRET` is missing or too short.
///
/// The text matches Go's `ErrNoMasterKey` plus its wrapper, because `main` logs
/// it verbatim and the runbooks quote it.
pub fn no_master_key_message() -> String {
    format!(
        "{SECRET_ENV} is not set (or is shorter than 32 chars) — generate one with \
         `openssl rand -base64 48` and set the SAME value on rayu-backend and rayu-gateway"
    )
}

/// Errors from opening one envelope. Deliberately vague about content: an error
/// must never echo ciphertext or key material into a log.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OpenError {
    #[error("malformed secret envelope (missing version)")]
    MissingVersion,
    #[error("unsupported secret envelope version {0:?}")]
    UnsupportedVersion(String),
    #[error("malformed secret envelope (bad base64)")]
    BadBase64,
    #[error("malformed secret envelope (too short)")]
    TooShort,
    #[error(
        "could not decrypt provider key (wrong RAYU_PROVIDER_SECRET, \
         or the stored value was tampered with)"
    )]
    Undecryptable,
}

/// Returned when the master secret itself is unusable.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{}", no_master_key_message())]
pub struct NoMasterKey;

/// Decrypts envelopes with a fixed master key.
///
/// Deriving the AES key once (rather than per envelope) keeps a config refresh
/// that opens many keys cheap.
pub struct Opener {
    key: Zeroizing<[u8; 32]>,
}

impl std::fmt::Debug for Opener {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never render the derived key, not even in a panic message.
        f.write_str("Opener { key: <redacted> }")
    }
}

impl Opener {
    /// Derives the AES key from the master secret.
    ///
    /// A missing/short secret is reported so the caller can log an actionable
    /// startup error instead of failing mysteriously on the first request.
    pub fn new(secret: &str) -> Result<Self, NoMasterKey> {
        let s = secret.trim();
        if s.len() < MIN_SECRET_LEN {
            return Err(NoMasterKey);
        }
        let digest = Sha256::digest(s.as_bytes());
        let mut key = [0u8; 32];
        key.copy_from_slice(&digest);
        Ok(Self {
            key: Zeroizing::new(key),
        })
    }

    /// Builds an opener from `RAYU_PROVIDER_SECRET`.
    pub fn from_env() -> Result<Self, NoMasterKey> {
        Self::new(&std::env::var(SECRET_ENV).unwrap_or_default())
    }

    /// Decrypts one envelope.
    pub fn open(&self, envelope: &str) -> Result<Zeroizing<String>, OpenError> {
        let raw = envelope.trim();
        let sep = raw.find(':').ok_or(OpenError::MissingVersion)?;
        let version = &raw[..sep];
        if version != VERSION {
            return Err(OpenError::UnsupportedVersion(version.to_string()));
        }
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&raw[sep + 1..])
            .map_err(|_| OpenError::BadBase64)?;
        if decoded.len() <= IV_BYTES + TAG_BYTES {
            return Err(OpenError::TooShort);
        }

        let iv = &decoded[..IV_BYTES];
        let tag = &decoded[IV_BYTES..IV_BYTES + TAG_BYTES];
        let ciphertext = &decoded[IV_BYTES + TAG_BYTES..];

        // The envelope stores the tag separately (matching Node's getAuthTag
        // API); both Go's and this crate's GCM expect it appended, so re-join.
        let mut sealed = Zeroizing::new(Vec::with_capacity(ciphertext.len() + TAG_BYTES));
        sealed.extend_from_slice(ciphertext);
        sealed.extend_from_slice(tag);

        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(self.key.as_ref()));
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(iv),
                Payload {
                    msg: sealed.as_ref(),
                    aad: &[],
                },
            )
            .map_err(|_| OpenError::Undecryptable)?;

        let plaintext = Zeroizing::new(plaintext);
        let text = std::str::from_utf8(plaintext.as_ref())
            .map_err(|_| OpenError::Undecryptable)?
            .to_string();
        Ok(Zeroizing::new(text))
    }
}

/// Renders a key for logs/health output without revealing it.
///
/// Kept in the same shape the backend stores in `maskedKey`, so operators see one
/// format: `<unset>`, `***(5)`, or `sk-pro…6789(44)`.
pub fn mask(k: &str) -> String {
    let bytes = k.as_bytes();
    match bytes.len() {
        0 => "<unset>".to_string(),
        n if n <= 12 => format!("***({n})"),
        n => format!(
            "{}…{}({})",
            String::from_utf8_lossy(&bytes[..6]),
            String::from_utf8_lossy(&bytes[n - 4..]),
            n
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The master key used to produce the fixtures below.
    const FIXTURE_SECRET: &str = "cross-language-master-secret-0123456789abcdef";

    /// Envelopes produced by the BACKEND (`rayu-backend`
    /// `src/common/secretBox.ts` `encryptSecret`) with `FIXTURE_SECRET`, copied
    /// verbatim from the Go gateway's own test fixtures.
    ///
    /// They are the whole point of this module: the Rust gateway must open what
    /// the backend sealed and what the Go gateway can already open. If any
    /// implementation drifts, these fail -- far better than discovering it when a
    /// provider key silently stops working in production.
    const NODE_FIXTURES: &[(&str, &str)] = &[
        (
            "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
            "v1:Kl1MyTDp5jqyuKhrb/3B2L+OGOutakNlCGhZ3YBWCgxYaviBtxjobVq/0+jY73HwwAxUm56JaAsIEzlq5fI0spQaVMM8uLo4",
        ),
        (
            "short-but-ok-key",
            "v1:4tXBqQZ4hocNfKK18Koz//3JLD6/7twRZbki0et/7uDl2qOW1Izc8BIdYUo=",
        ),
        (
            "sk-ant-api03-XYZ_123-abc",
            "v1:2u4FADWFfKTU8AEUIrKXde8C+7N+GI75mQn+y0hvkC1wp3CgYt9ENII8xGizOfmbdiAq3w==",
        ),
    ];

    #[test]
    fn opens_envelopes_sealed_by_the_backend() {
        let opener = Opener::new(FIXTURE_SECRET).expect("fixture secret is long enough");
        for (plain, sealed) in NODE_FIXTURES {
            let got = opener
                .open(sealed)
                .unwrap_or_else(|e| panic!("open failed for {}…: {e}", &sealed[..16]));
            assert_eq!(got.as_str(), *plain);
        }
    }

    #[test]
    fn wrong_master_key_fails_and_leaks_nothing() {
        let opener = Opener::new("a-different-master-secret-0123456789abcdef").unwrap();
        let err = opener.open(NODE_FIXTURES[0].1).unwrap_err();
        assert_eq!(err, OpenError::Undecryptable);
        let text = err.to_string();
        assert!(text.contains(SECRET_ENV), "error should name {SECRET_ENV}");
        assert!(!text.contains(NODE_FIXTURES[0].0), "leaked plaintext");
        assert!(!text.contains(NODE_FIXTURES[0].1), "leaked ciphertext");
    }

    #[test]
    fn tampered_envelope_is_rejected() {
        let opener = Opener::new(FIXTURE_SECRET).unwrap();
        let sealed = NODE_FIXTURES[0].1;
        let mut body: Vec<u8> = sealed.as_bytes()[3..].to_vec();
        let last = body.len() - 2;
        body[last] = if body[last] == b'A' { b'B' } else { b'A' };
        let tampered = format!("v1:{}", String::from_utf8(body).unwrap());
        assert!(
            opener.open(&tampered).is_err(),
            "tampered ciphertext must not open (GCM auth tag)"
        );
    }

    #[test]
    fn malformed_envelopes_are_rejected() {
        let opener = Opener::new(FIXTURE_SECRET).unwrap();
        let cases = [
            ("", OpenError::MissingVersion),
            ("no-separator", OpenError::MissingVersion),
            ("v1:", OpenError::TooShort),
            ("v1:AAAA", OpenError::TooShort),
            (
                "v2:AAAABBBBCCCCDDDD",
                OpenError::UnsupportedVersion("v2".into()),
            ),
            ("v1:!!!not-base64!!!", OpenError::BadBase64),
        ];
        for (bad, want) in cases {
            let got = opener.open(bad).unwrap_err();
            assert_eq!(got, want, "open({bad:?})");
        }
    }

    #[test]
    fn new_opener_refuses_a_weak_secret() {
        for secret in ["", "   ", "too-short-secret"] {
            assert!(
                Opener::new(secret).is_err(),
                "a short master key must not be stretched: {secret:?}"
            );
        }
        // The error tells the operator exactly what to do.
        let msg = Opener::new("short").unwrap_err().to_string();
        assert!(msg.contains("openssl rand"), "{msg}");
        assert!(msg.contains(SECRET_ENV), "{msg}");
    }

    #[test]
    fn secret_exactly_at_the_minimum_is_accepted() {
        let secret = "x".repeat(MIN_SECRET_LEN);
        assert!(Opener::new(&secret).is_ok());
        let short = "x".repeat(MIN_SECRET_LEN - 1);
        assert!(Opener::new(&short).is_err());
    }

    #[test]
    fn mask_never_reveals_the_key() {
        const KEY: &str = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
        let masked = mask(KEY);
        assert_ne!(masked, KEY);
        assert!(!masked.contains("ghijklmnopqrst"), "{masked}");
        assert_eq!(mask(""), "<unset>");
        assert_eq!(mask("short"), "***(5)");
        // Exactly 12 bytes still takes the fully-masked branch.
        assert_eq!(mask("123456789012"), "***(12)");
        assert_eq!(mask("1234567890123"), "123456…0123(13)");
        assert_eq!(masked, "sk-pro…6789(44)");
    }

    #[test]
    fn opener_debug_does_not_render_the_key() {
        let opener = Opener::new(FIXTURE_SECRET).unwrap();
        assert_eq!(format!("{opener:?}"), "Opener { key: <redacted> }");
    }
}
