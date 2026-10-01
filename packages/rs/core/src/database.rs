use sha2::{Digest, Sha256};

/// Derive PostgreSQL's signed 64-bit advisory-lock id from canonical key parts.
#[uniffi::export]
pub fn advisory_lock_id(canonical_parts: Vec<String>) -> i64 {
    let mut digest = Sha256::new();
    for (index, part) in canonical_parts.iter().enumerate() {
        if index > 0 {
            digest.update([0]);
        }
        digest.update(part.as_bytes());
    }
    let bytes: [u8; 8] = digest.finalize()[..8]
        .try_into()
        .expect("fixed SHA-256 prefix");
    i64::from_be_bytes(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_published_advisory_lock_ids() {
        assert_eq!(
            advisory_lock_id(vec!["string:14:schema-install".into()]),
            8_391_191_540_082_855_336
        );
        assert_eq!(
            advisory_lock_id(vec![
                "string:14:schema-install".into(),
                "string:2:v2".into()
            ]),
            -6_627_415_645_816_226_415
        );
    }
}
