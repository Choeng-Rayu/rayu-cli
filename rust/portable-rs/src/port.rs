//! The Rust port of `rayu/src/core/portable/`.
//!
//! The recorded original runs on Node, so the Node path is the one ported:
//! `hashContent`/`hashPair` are SHA-256, and `djb2Hash` walks UTF-16 code units
//! exactly as `charCodeAt` does.

#![forbid(unsafe_code)]

use sha2::{Digest, Sha256};

/// Port of `djb2Hash` (`rayu/src/core/portable/hash.ts:36`).
///
/// JS `charCodeAt` indexes UTF-16 code units, and `| 0` keeps the accumulator a
/// signed 32-bit integer, so the port hashes `encode_utf16()` with wrapping
/// `i32` arithmetic.
pub fn djb2_hash(str: String) -> Result<f64, String> {
    let mut hash: i32 = 0;
    for unit in str.encode_utf16() {
        hash = (hash << 5).wrapping_sub(hash).wrapping_add(i32::from(unit));
    }
    Ok(f64::from(hash))
}

/// Port of `hashContent` (`rayu/src/core/portable/hash.ts:48`), Node path.
pub fn hash_content(content: String) -> Result<String, String> {
    let digest = Sha256::digest(content.as_bytes());
    Ok(hex_lower(&digest))
}

/// Port of `hashPair` (`rayu/src/core/portable/hash.ts:61`), Node path.
///
/// The Node fallback feeds a NUL separator between the two updates.
pub fn hash_pair(a: String, b: String) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(a.as_bytes());
    hasher.update([0u8]);
    hasher.update(b.as_bytes());
    Ok(hex_lower(&hasher.finalize()))
}

fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        // Writing into a String cannot fail.
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn djb2_matches_recorded_values() {
        assert_eq!(djb2_hash("a".to_string()).unwrap(), 97.0);
        assert_eq!(djb2_hash("abc".to_string()).unwrap(), 96_354.0);
        assert_eq!(
            djb2_hash("Hello World".to_string()).unwrap(),
            -862_545_276.0
        );
        assert_eq!(djb2_hash("a..b".to_string()).unwrap(), 2_935_457.0);
    }

    #[test]
    fn hash_content_is_sha256_hex() {
        assert_eq!(
            hash_content("abHello World".to_string()).unwrap(),
            "83a7687a125ed10400bbe6d5692e0defb56c19e2ce019ce603cff93829988c40"
        );
    }

    #[test]
    fn hash_pair_uses_nul_separator() {
        assert_eq!(
            hash_pair("HELLO".to_string(), "key_name-1".to_string()).unwrap(),
            "9209e9c172096110b1aa7e61dae9dbdf2125248b865a74b0f88309c5f428807c"
        );
        assert_ne!(
            hash_pair("ab".to_string(), "c".to_string()).unwrap(),
            hash_pair("a".to_string(), "bc".to_string()).unwrap()
        );
    }
}
