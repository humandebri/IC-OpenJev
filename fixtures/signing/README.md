# Signing test keys

Private-key files are not stored in the repository. Tests generate PEM encodings
at runtime and store them only in automatically cleaned temporary directories.

`canisters/test-support/signing.rs` generates the shared secp256k1 identity with
public scalar 42. Uploader tests generate Ed25519 from public seed `[42; 32]` and
an unsupported P-256 key with scalar 42. These identities are public test data,
never deployment credentials. PKCS#8 and SEC1 coverage uses the same secp256k1 key.
