//! Independent Japanese model storage and API. The legacy v4 snapshot stays byte
//! compatible, including rollback to the legacy-only Wasm. This module owns only
//! previously unused bytes 32..48, 64KiB..960KiB, and its separate model region.
use super::owner;
use candid::{CandidType, Principal};
use ic_laya_core::{storage, Digest, Error, Result};
pub use runtime::{
    Info as TicketingInfo, QueryLimits as TicketingQueryLimits, Reply as TicketReply,
};
use serde::{Deserialize, Serialize};
use ticketing_runtime as runtime;

const HEADER: u64 = 32;
const MAGIC: &[u8; 8] = b"ICTKMT01";
const SLOT_A: u64 = 64 * 1024;
const SLOT_B: u64 = 512 * 1024;
const SLOT_BYTES: u64 = 448 * 1024;
pub const LEGACY_HEADROOM_BYTES: u64 = 16 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
struct Metadata {
    version: u32,
    base: u64,
    state: runtime::State,
}
fn slot(n: u32) -> u64 {
    if n == 0 {
        SLOT_A
    } else {
        SLOT_B
    }
}
fn header() -> Result<Option<(u32, u32)>> {
    if ic_cdk::stable::stable_size() == 0 {
        return Ok(None);
    }
    let mut b = [0; 16];
    ic_cdk::stable::stable_read(HEADER, &mut b);
    if b == [0; 16] {
        return Ok(None);
    }
    if &b[..8] != MAGIC {
        return Err(Error::Storage);
    }
    let generation = u32::from_be_bytes(b[8..12].try_into().unwrap());
    let active = u32::from_be_bytes(b[12..].try_into().unwrap());
    if active > 1 {
        return Err(Error::Storage);
    }
    Ok(Some((generation, active)))
}
fn decode_slot(n: u32) -> Result<Metadata> {
    let mut h = [0; 16];
    ic_cdk::stable::stable_read(slot(n), &mut h);
    if &h[..8] != storage::MAGIC {
        return Err(Error::Storage);
    }
    let len = u64::from_be_bytes(h[8..].try_into().unwrap());
    if len > SLOT_BYTES - storage::BLOCK_HEADER as u64 {
        return Err(Error::Storage);
    }
    let total = len + storage::BLOCK_HEADER as u64;
    if slot(n) + total > ic_cdk::stable::stable_size() * 65536 {
        return Err(Error::Storage);
    }
    let mut bytes = vec![0; total as usize];
    ic_cdk::stable::stable_read(slot(n), &mut bytes);
    storage::decode(&bytes)
}
pub(crate) fn persist() -> Result<()> {
    let bytes = storage::encode(&Metadata {
        version: 1,
        base: runtime::base(),
        state: runtime::snapshot(),
    })?;
    if bytes.len() as u64 > SLOT_BYTES {
        return Err(Error::Capacity);
    }
    let (generation, active) = header()?.unwrap_or((0, 1));
    let next = 1 - active;
    canister_common::grow_through(slot(next) + bytes.len() as u64)?;
    ic_cdk::stable::stable_write(slot(next), &bytes);
    let mut h = [0; 16];
    h[..8].copy_from_slice(MAGIC);
    h[8..12].copy_from_slice(&generation.wrapping_add(1).to_be_bytes());
    h[12..].copy_from_slice(&next.to_be_bytes());
    ic_cdk::stable::stable_write(HEADER, &h);
    Ok(())
}
fn reset_at_legacy_end(owner: Principal, legacy_bytes: u64) {
    let capacity = (legacy_bytes + LEGACY_HEADROOM_BYTES).div_ceil(65536) * 65536;
    runtime::init(owner, canister_common::BLOB_BASE + capacity);
}
pub(crate) fn init(owner: Principal) {
    reset_at_legacy_end(owner, 0);
}
pub(crate) fn restore(owner: Principal, legacy_bytes: u64) -> Result<()> {
    match header()? {
        None => reset_at_legacy_end(owner, legacy_bytes),
        Some((_, active)) => {
            let m = decode_slot(active).or_else(|_| decode_slot(1 - active))?;
            if m.version != 1
                || m.base < canister_common::BLOB_BASE + LEGACY_HEADROOM_BYTES
                || m.base
                    > canister_common::BLOB_BASE
                        + 2 * 1024 * 1024 * 1024
                        + 32 * 1024 * 1024
                        + LEGACY_HEADROOM_BYTES
                        + 65536
                || !m.base.is_multiple_of(65536)
            {
                return Err(Error::Storage);
            }
            runtime::restore(m.state, m.base, owner)?;
            match guard_legacy_upload(legacy_bytes) {
                Ok(()) => {}
                // A legacy-only rollback cannot enforce the Japanese reservation.
                // Its new primary upload may already have overwritten these bytes.
                // Preserve that primary upload and make Japanese re-upload possible.
                Err(Error::Capacity) => reset_at_legacy_end(owner, legacy_bytes),
                Err(error) => return Err(error),
            }
        }
    }
    Ok(())
}
pub(crate) fn guard_legacy_upload(total: u64) -> Result<()> {
    if runtime::reserved() && total > runtime::base() - canister_common::BLOB_BASE {
        Err(Error::Capacity)
    } else {
        Ok(())
    }
}
#[derive(CandidType, Serialize, Deserialize)]
pub struct TicketingStorage {
    pub model_base: u64,
    pub legacy_slot_bytes: u64,
    pub reserved: bool,
}
#[ic_cdk::query]
fn ticketing_storage() -> TicketingStorage {
    TicketingStorage {
        model_base: runtime::base(),
        legacy_slot_bytes: runtime::base() - canister_common::BLOB_BASE,
        reserved: runtime::reserved(),
    }
}
#[ic_cdk::query]
fn ticketing_info() -> TicketingInfo {
    runtime::info()
}
#[ic_cdk::query]
fn ticketing_query_limits() -> TicketingQueryLimits {
    runtime::query_limits()
}
#[ic_cdk::query]
fn classify_ticket(text: String) -> Result<TicketReply> {
    runtime::classify(text)
}
#[ic_cdk::update]
fn ticketing_begin_upload(manifest: Vec<u8>, tokenizer_bytes: u64) -> Result<Digest> {
    owner()?;
    // Validate before changing the address or the active Japanese model.
    ticketing_candle_manifest(&manifest)?;
    if tokenizer_bytes == 0 || tokenizer_bytes > 32 * 1024 * 1024 {
        return Err(Error::TooLong);
    }
    let legacy = super::read(|s| {
        s.upload
            .as_ref()
            .map(|u| u.model_length + u.tokenizer_length)
            .unwrap_or(0)
    });
    let capacity = (legacy + LEGACY_HEADROOM_BYTES).div_ceil(65536) * 65536;
    runtime::set_base(canister_common::BLOB_BASE + capacity);
    runtime::begin_upload(manifest, tokenizer_bytes)
}
fn ticketing_candle_manifest(raw: &[u8]) -> Result<()> {
    runtime::validate_manifest(raw)
}
#[ic_cdk::update]
fn ticketing_upload_chunk(offset: u64, bytes: Vec<u8>) -> Result<u64> {
    owner()?;
    runtime::upload_chunk(offset, bytes)
}
#[ic_cdk::update]
fn ticketing_start_warmup() -> Result<u32> {
    owner()?;
    runtime::start_warmup()
}
#[ic_cdk::update]
fn ticketing_warmup_next() -> Result<bool> {
    owner()?;
    runtime::warmup_next()
}
#[ic_cdk::update]
fn ticketing_set_query_limit(tokens: u32) -> Result<()> {
    owner()?;
    runtime::set_query_limit(tokens)
}
#[ic_cdk::update]
fn ticketing_benchmark(text: String) -> Result<TicketReply> {
    owner()?;
    runtime::benchmark(text)
}
#[ic_cdk::update]
fn ticketing_clear_model() -> Result<()> {
    owner()?;
    runtime::clear_model()
}

const _: () = {
    assert!(HEADER >= 16 && HEADER + 16 < SLOT_A);
    assert!(SLOT_A + SLOT_BYTES <= SLOT_B);
    assert!(SLOT_B + SLOT_BYTES <= canister_common::SNAPSHOT_SLOT_A);
};
