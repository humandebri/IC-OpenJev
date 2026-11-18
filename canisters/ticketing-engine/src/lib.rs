//! Standalone host for the reusable Japanese ticket classifier runtime.
use candid::Principal;
use ic_laya_core::{Digest, Result};
use ticketing_runtime as runtime;
pub use ticketing_runtime::{Classification, Info, QueryLimits, Reply};
#[cfg(target_arch = "wasm32")]
#[path = "../../decision-engine/src/getrandom_ic.rs"]
mod getrandom_ic;
#[ic_cdk::init]
fn init(owner: Principal) {
    runtime::init(owner, canister_common::BLOB_BASE);
}
#[ic_cdk::pre_upgrade]
fn pre_upgrade() {
    canister_common::persist_or_trap(&runtime::snapshot());
}
#[ic_cdk::post_upgrade]
fn post_upgrade() {
    let state: runtime::State =
        canister_common::restore().unwrap_or_else(|e| ic_cdk::trap(e.to_string()));
    let owner = state.owner;
    runtime::restore(state, canister_common::BLOB_BASE, owner)
        .unwrap_or_else(|e| ic_cdk::trap(e.to_string()));
}
#[ic_cdk::query]
fn info() -> Info {
    runtime::info()
}
#[ic_cdk::query]
fn query_limits() -> QueryLimits {
    runtime::query_limits()
}
#[ic_cdk::query]
fn classify(text: String) -> Result<Reply> {
    runtime::classify(text)
}
#[ic_cdk::update]
fn set_query_limit(tokens: u32) -> Result<()> {
    runtime::set_query_limit(tokens)
}
#[ic_cdk::update]
fn begin_upload(manifest: Vec<u8>, tokenizer_bytes: u64) -> Result<Digest> {
    runtime::begin_upload(manifest, tokenizer_bytes)
}
#[ic_cdk::update]
fn upload_chunk(offset: u64, bytes: Vec<u8>) -> Result<u64> {
    runtime::upload_chunk(offset, bytes)
}
#[ic_cdk::update]
fn start_warmup() -> Result<u32> {
    runtime::start_warmup()
}
#[ic_cdk::update]
fn warmup_next() -> Result<bool> {
    runtime::warmup_next()
}
#[ic_cdk::update]
fn benchmark(text: String) -> Result<Reply> {
    runtime::benchmark(text)
}
ic_cdk::export_candid!();
pub fn candid_interface() -> String {
    __export_service()
}
