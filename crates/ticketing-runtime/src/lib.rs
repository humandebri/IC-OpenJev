//! Reusable ticket classifier runtime; hosts own Candid hooks and snapshot placement.
use candid::{CandidType, Principal};
use ic_laya_core::{hash, Digest, Error, Result};
use serde::{Deserialize, Serialize};
use std::cell::Cell;
use std::cell::RefCell;
use ticketing_candle::{
    pack::{Builder, Manifest},
    Model, Tokenizer, DEPARTMENTS, PRIORITIES,
};
#[derive(Clone, Serialize, Deserialize)]
struct Upload {
    manifest: Vec<u8>,
    model_bytes: u64,
    tokenizer_bytes: u64,
    received: u64,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct State {
    pub owner: Principal,
    upload: Option<Upload>,
    max_query_tokens: u32,
}
thread_local! {
    static STATE:RefCell<Option<State>>=const{RefCell::new(None)};
    static BUILDER:RefCell<Option<Builder>>=const{RefCell::new(None)};
    static MODEL:RefCell<Option<Model>>=const{RefCell::new(None)};
    static TOKENIZER:RefCell<Option<Tokenizer>>=const{RefCell::new(None)};
    static BASE:Cell<u64>=const{Cell::new(0)};
    static READ_BYTES:Cell<u64>=const{Cell::new(0)};
}
fn read<R>(f: impl FnOnce(&State) -> R) -> R {
    STATE.with(|s| f(s.borrow().as_ref().expect("initialized")))
}
fn mutate<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| f(s.borrow_mut().as_mut().expect("initialized")))
}
fn owner() -> Result<()> {
    if read(|s| s.owner) == ic_cdk::api::msg_caller() {
        Ok(())
    } else {
        Err(Error::Unauthorized)
    }
}
pub fn init(owner: Principal, base: u64) {
    BASE.with(|b| b.set(base));
    if owner == Principal::anonymous() || owner == Principal::management_canister() {
        ic_cdk::trap("anonymous owner");
    }
    STATE.with(|s| {
        *s.borrow_mut() = Some(State {
            owner,
            upload: None,
            max_query_tokens: 0,
        })
    });
}
pub fn snapshot() -> State {
    read(Clone::clone)
}
pub fn restore(mut state: State, base: u64, owner: Principal) -> Result<()> {
    if state.owner != owner {
        return Err(Error::BindingMismatch);
    }
    // A restored pack is unchanged; the Wasm execution cost may have changed.
    state.max_query_tokens = 0;
    BASE.with(|b| b.set(base));
    STATE.with(|s| *s.borrow_mut() = Some(state));
    Ok(())
}
pub fn base() -> u64 {
    BASE.with(Cell::get)
}
pub fn validate_manifest(raw: &[u8]) -> Result<()> {
    Manifest::parse(raw, false).map(|_| ())
}
pub fn reserved() -> bool {
    read(|s| s.upload.is_some())
}
pub fn clear_model() -> Result<()> {
    owner()?;
    let owner = read(|s| s.owner);
    let at = base();
    MODEL.with(|m| *m.borrow_mut() = None);
    TOKENIZER.with(|t| *t.borrow_mut() = None);
    BUILDER.with(|b| *b.borrow_mut() = None);
    init(owner, at);
    modernbert_candle::weights::begin_forward();
    Ok(())
}
/// Host changes the address only immediately before replacing this pack.
pub fn set_base(at: u64) {
    BASE.with(|b| b.set(at));
}
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Info {
    pub model: Digest,
    pub ready: bool,
    pub model_bytes: u64,
    pub received: u64,
    pub heap_bytes: u64,
    pub stable_bytes: u64,
    pub loaded_tensors: u32,
}
fn heap_bytes() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        core::arch::wasm32::memory_size(0) as u64 * 65536
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}
pub fn info() -> Info {
    let (model, model_bytes, received) = read(|s| {
        s.upload
            .as_ref()
            .map(|u| (hash(&u.manifest), u.model_bytes, u.received))
            .unwrap_or(([0; 32], 0, 0))
    });
    Info {
        model,
        ready: MODEL.with(|m| m.borrow().is_some()),
        model_bytes,
        received,
        heap_bytes: heap_bytes(),
        stable_bytes: ic_cdk::stable::stable_size() * 65536,
        loaded_tensors: BUILDER.with(|b| b.borrow().as_ref().map(|b| b.next as u32).unwrap_or(0)),
    }
}
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct QueryLimits {
    pub max_tokens: u32,
    pub target_instructions: u64,
    pub calibrated: bool,
}
pub fn query_limits() -> QueryLimits {
    read(|s| QueryLimits {
        max_tokens: s.max_query_tokens,
        target_instructions: 4_500_000_000,
        calibrated: s.max_query_tokens > 0,
    })
}
/// Set only after local measurements. Uploading a new pack clears this calibration.
pub fn set_query_limit(tokens: u32) -> Result<()> {
    owner()?;
    if !(2..=128).contains(&tokens) {
        return Err(Error::TooLong);
    }
    if !MODEL.with(|m| m.borrow().is_some()) {
        return Err(Error::Transition);
    }
    mutate(|s| s.max_query_tokens = tokens);
    Ok(())
}
pub fn begin_upload(manifest: Vec<u8>, tokenizer_bytes: u64) -> Result<Digest> {
    owner()?;
    let m = Manifest::parse(&manifest, false)?;
    if tokenizer_bytes == 0 || tokenizer_bytes > 32 * 1024 * 1024 {
        return Err(Error::TooLong);
    }
    let bundle = hash(&manifest);
    MODEL.with(|m| *m.borrow_mut() = None);
    TOKENIZER.with(|t| *t.borrow_mut() = None);
    BUILDER.with(|b| *b.borrow_mut() = None);
    modernbert_candle::weights::begin_forward();
    mutate(|s| {
        s.upload = Some(Upload {
            manifest,
            model_bytes: m.total_bytes,
            tokenizer_bytes,
            received: 0,
        });
        s.max_query_tokens = 0;
    });
    Ok(bundle)
}
pub fn upload_chunk(offset: u64, bytes: Vec<u8>) -> Result<u64> {
    owner()?;
    if bytes.is_empty() || bytes.len() > 1024 * 1024 {
        return Err(Error::TooLong);
    }
    mutate(|s| {
        let u = s.upload.as_mut().ok_or(Error::Transition)?;
        let end = offset
            .checked_add(bytes.len() as u64)
            .ok_or(Error::TooLong)?;
        if end > u.model_bytes + u.tokenizer_bytes {
            return Err(Error::TooLong);
        }
        if offset < u.received {
            if end > u.received {
                return Err(Error::IdConflict);
            }
            let mut previous = vec![0; bytes.len()];
            ic_cdk::stable::stable_read(base() + offset, &mut previous);
            return if previous == bytes {
                Ok(u.received)
            } else {
                Err(Error::IdConflict)
            };
        }
        if offset != u.received {
            return Err(Error::NonceGap);
        }
        canister_common::grow_through(base() + end)?;
        ic_cdk::stable::stable_write(base() + offset, &bytes);
        u.received = end;
        Ok(end)
    })
}
fn stable_reader(at: u64, out: &mut [u8]) -> candle_core::Result<()> {
    ic_cdk::stable::stable_read(at, out);
    READ_BYTES.with(|n| n.set(n.get() + out.len() as u64));
    Ok(())
}
pub fn start_warmup() -> Result<u32> {
    owner()?;
    let u = read(|s| s.upload.clone()).ok_or(Error::Transition)?;
    if u.received != u.model_bytes + u.tokenizer_bytes {
        return Err(Error::Transition);
    }
    let builder = Builder::new(&u.manifest, false)?;
    let mut bytes = vec![0; u.tokenizer_bytes as usize];
    ic_cdk::stable::stable_read(base() + u.model_bytes, &mut bytes);
    if hash(&bytes) != builder.manifest.tokenizer_sha256 {
        return Err(Error::BindingMismatch);
    }
    let tok = Tokenizer::new(&bytes)?;
    let count = builder.manifest.tensors.len() as u32;
    MODEL.with(|m| *m.borrow_mut() = None);
    TOKENIZER.with(|t| *t.borrow_mut() = Some(tok));
    BUILDER.with(|b| *b.borrow_mut() = Some(builder));
    modernbert_candle::weights::begin_forward();
    Ok(count)
}
pub fn warmup_next() -> Result<bool> {
    owner()?;
    let done = BUILDER.with(|b| {
        let mut b = b.borrow_mut();
        let b = b.as_mut().ok_or(Error::Transition)?;
        b.push_reader(base(), stable_reader)?;
        Ok::<_, Error>(b.next_entry().is_none())
    })?;
    if done {
        let b = BUILDER
            .with(|b| b.borrow_mut().take())
            .ok_or(Error::Transition)?;
        let model = b.finish()?;
        // Largest dense matrix is 4096*512 INT8 bytes; embedding rows use a separate tiny buffer.
        modernbert_candle::weights::prepare_scratch(4096 * 512);
        MODEL.with(|m| *m.borrow_mut() = Some(model));
    }
    Ok(done)
}
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Classification {
    pub selected: String,
    pub labels: Vec<String>,
    pub probabilities: Vec<f32>,
}
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Reply {
    pub model: Digest,
    pub input_tokens: u32,
    pub department: Classification,
    pub priority: Classification,
    pub measured_instructions: u64,
    pub heap_bytes: u64,
    pub stable_read_bytes: u64,
}
fn classification(logits: Vec<f32>, labels: &[&str]) -> Result<Classification> {
    let max = logits.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let exp = logits.iter().map(|x| (x - max).exp()).collect::<Vec<_>>();
    let sum: f32 = exp.iter().sum();
    if !sum.is_finite() || sum <= 0. {
        return Err(Error::Numeric);
    }
    // Match torch.argmax: the first class wins exact ties, including +/-0.
    let mut best = 0;
    for i in 1..logits.len() {
        if logits[i] > logits[best] {
            best = i;
        }
    }
    Ok(Classification {
        selected: labels[best].into(),
        labels: labels.iter().map(|s| s.to_string()).collect(),
        probabilities: exp.iter().map(|x| x / sum).collect(),
    })
}
fn infer(text: String, limit: usize) -> Result<Reply> {
    let start = ic_cdk::api::instruction_counter();
    if !MODEL.with(|m| m.borrow().is_some()) {
        return Err(Error::ModelUnavailable("warm-up required".into()));
    }
    if limit == 0 {
        return Err(Error::Capacity);
    }
    let ids = TOKENIZER.with(|t| t.borrow().as_ref().ok_or(Error::Transition)?.encode(&text))?;
    if ids.len() > limit {
        return Err(Error::TooLong);
    }
    READ_BYTES.with(|n| n.set(0));
    let (d, p) = MODEL.with(|m| m.borrow().as_ref().ok_or(Error::Transition)?.logits(&ids))?;
    let department = classification(d, &DEPARTMENTS)?;
    let priority = classification(p, &PRIORITIES)?;
    Ok(Reply {
        model: read(|s| hash(&s.upload.as_ref().unwrap().manifest)),
        input_tokens: ids.len() as u32,
        department,
        priority,
        measured_instructions: ic_cdk::api::instruction_counter() - start,
        heap_bytes: heap_bytes(),
        stable_read_bytes: READ_BYTES.with(Cell::get),
    })
}
pub fn classify(text: String) -> Result<Reply> {
    if ic_cdk::api::in_replicated_execution() {
        return Err(Error::Denied(
            "classify requires a non-replicated query".into(),
        ));
    }
    infer(text, read(|s| s.max_query_tokens as usize))
}
/// Owner-only local calibration path with the update instruction budget.
pub fn benchmark(text: String) -> Result<Reply> {
    owner()?;
    infer(text, 128)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restoring_preserves_pack_but_invalidates_the_previous_wasm_calibration() {
        let owner = Principal::self_authenticating(b"test-owner");
        let s = State {
            owner,
            upload: Some(Upload {
                manifest: vec![1, 2],
                model_bytes: 100,
                tokenizer_bytes: 20,
                received: 120,
            }),
            max_query_tokens: 65,
        };
        restore(s.clone(), 64 * 1024 * 1024, owner).unwrap();
        assert!(!query_limits().calibrated);
        assert_eq!(snapshot().upload.unwrap().received, 120);
        assert!(restore(s, 64 * 1024 * 1024, Principal::anonymous()).is_err());
    }
    #[test]
    fn head_selection_matches_first_argmax_and_rejects_nonfinite_scores() {
        let r = classification(vec![-0.0, 0.0, 0.0], &PRIORITIES).unwrap();
        assert_eq!(r.selected, "low");
        assert!(r
            .probabilities
            .iter()
            .all(|p| (*p - 1.0 / 3.0).abs() < 1e-6));
        assert!(classification(vec![f32::NAN, 0.0, 1.0], &PRIORITIES).is_err());
    }
}
