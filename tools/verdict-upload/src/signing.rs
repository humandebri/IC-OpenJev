//! Owner PEM loading shared by both uploaders. Never logs key bytes or parse details.
use ic_agent::{identity::{BasicIdentity, Secp256k1Identity}, Identity};
use std::path::Path;

pub fn from_pem_file(path: impl AsRef<Path>) -> Result<Box<dyn Identity>, String> {
    let bytes = std::fs::read(path).map_err(|_| "could not read owner PEM".to_string())?;
    if let Ok(identity) = BasicIdentity::from_pem(&bytes) {
        return Ok(Box::new(identity));
    }
    if let Ok(identity) = Secp256k1Identity::from_pem(&bytes) {
        return Ok(Box::new(identity));
    }
    Err("owner PEM must be an unencrypted Ed25519 or secp256k1 key".into())
}

#[cfg(test)]
#[path = "../../../canisters/test-support/signing.rs"]
mod test_signing;

#[cfg(test)]
mod tests {
    use super::*;
    use k256::pkcs8::{EncodePrivateKey, LineEnding};
    use std::io::Write;

    fn pem_file(pem: &str) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(pem.as_bytes()).unwrap();
        file
    }
    #[test]
    fn ed25519_preserves_the_existing_sender_and_signs() {
        let pem = ed25519_dalek::SigningKey::from_bytes(&[42; 32])
            .to_pkcs8_pem(LineEnding::LF).unwrap();
        let file = pem_file(&pem);
        let identity = from_pem_file(file.path()).unwrap();
        let expected = BasicIdentity::from_raw_key(&[42; 32]);
        assert_eq!(identity.sender().unwrap(), expected.sender().unwrap());
        assert_eq!(identity.sign_arbitrary(b"public test payload").unwrap().signature.unwrap().len(), 64);
    }
    #[test]
    fn both_secp256k1_encodings_preserve_sender_and_sign() {
        let pkcs8_file = pem_file(&test_signing::secp256k1_pkcs8());
        let sec1_file = pem_file(&test_signing::secp256k1_key().to_sec1_pem(LineEnding::LF).unwrap());
        let pkcs8 = from_pem_file(pkcs8_file.path()).unwrap();
        let sec1 = from_pem_file(sec1_file.path()).unwrap();
        assert_eq!(pkcs8.sender().unwrap(), sec1.sender().unwrap());
        assert_ne!(pkcs8.sender().unwrap(), BasicIdentity::from_raw_key(&[42; 32]).sender().unwrap());
        assert_eq!(pkcs8.sign_arbitrary(b"public test payload").unwrap().signature.unwrap().len(), 64);
    }
    #[test]
    fn unsupported_keys_and_missing_files_are_rejected() {
        let mut scalar = [0; 32];
        scalar[31] = 42;
        let pem = p256::SecretKey::from_slice(&scalar).unwrap()
            .to_pkcs8_pem(LineEnding::LF).unwrap();
        let file = pem_file(&pem);
        assert!(from_pem_file(file.path()).is_err());
        let missing = tempfile::tempdir().unwrap();
        assert!(from_pem_file(missing.path().join("missing.pem")).is_err());
    }
}
