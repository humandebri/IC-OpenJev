//! Public, deterministic test identities. Generate encodings only at runtime;
//! never use these identities for deployment or commit their encoded key bytes.
use k256::pkcs8::{EncodePrivateKey, LineEnding};

pub fn secp256k1_key() -> k256::SecretKey {
    let mut scalar = [0; 32];
    scalar[31] = 42;
    k256::SecretKey::from_slice(&scalar).unwrap()
}

pub fn secp256k1_pkcs8() -> String {
    secp256k1_key()
        .to_pkcs8_pem(LineEnding::LF)
        .unwrap()
        .to_string()
}
