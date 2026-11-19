//! Optional IT heads live in the last unused 64KiB below the original snapshot.
//! The Japanese model's state format and all existing model bytes stay unchanged.
use candid::CandidType;
use ic_laya_core::{hash, storage, Digest, Error, Result};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use ticketing_runtime::{
    self as runtime,
    it_routing::{Head, Prediction},
};
const HEADER: u64 = 48;
const MAGIC: &[u8; 8] = b"ICITRT01";
const SLOT_A: u64 = 960 * 1024;
const SLOT_B: u64 = 992 * 1024;
const SLOT_BYTES: u64 = 32 * 1024;
#[derive(Clone, Serialize, Deserialize)]
struct State {
    version: u32,
    model: Digest,
    head: Option<Head>,
}
thread_local! { static STATE: RefCell<State> = const { RefCell::new(State { version:1,model:[0;32],head:None }) }; }
fn slot(active: u32) -> u64 {
    if active == 0 {
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
fn decode(active: u32) -> Result<State> {
    let mut h = [0; 16];
    ic_cdk::stable::stable_read(slot(active), &mut h);
    if &h[..8] != storage::MAGIC {
        return Err(Error::Storage);
    }
    let len = u64::from_be_bytes(h[8..].try_into().unwrap());
    if len > SLOT_BYTES - storage::BLOCK_HEADER as u64 {
        return Err(Error::Storage);
    }
    let mut bytes = vec![0; (len + storage::BLOCK_HEADER as u64) as usize];
    ic_cdk::stable::stable_read(slot(active), &mut bytes);
    let state: State = storage::decode(&bytes)?;
    if state.version != 1 {
        return Err(Error::Storage);
    }
    if let Some(h) = &state.head {
        h.validate(h.base_model)?;
    }
    Ok(state)
}
pub(crate) fn persist() -> Result<()> {
    let bytes = STATE.with(|s| storage::encode(&*s.borrow()))?;
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
pub(crate) fn restore() -> Result<()> {
    if let Some((_, active)) = header()? {
        let state = decode(active).or_else(|_| decode(1 - active))?;
        STATE.with(|s| *s.borrow_mut() = state);
    }
    Ok(())
}
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct RoutingInfo {
    pub model: Digest,
    pub base_model: Digest,
    pub ready: bool,
    pub validated: bool,
    pub max_tokens: u32,
    pub target_instructions: u64,
}
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct RoutingReply {
    pub model: Digest,
    pub base_model: Digest,
    pub result: Prediction,
    pub input_tokens: u32,
    pub measured_instructions: u64,
}
#[ic_cdk::query]
fn it_routing_info() -> RoutingInfo {
    let base = runtime::info();
    let limits = runtime::query_limits();
    STATE.with(|s| {
        let s = s.borrow();
        RoutingInfo {
            model: s.model,
            base_model: base.model,
            validated: s.head.as_ref().is_some_and(|h| h.validated),
            ready: base.ready
                && limits.calibrated
                && s.head.as_ref().is_some_and(|h| h.base_model == base.model),
            max_tokens: limits.max_tokens,
            target_instructions: limits.target_instructions,
        }
    })
}
#[ic_cdk::update]
fn it_routing_set_head(raw: Vec<u8>) -> Result<Digest> {
    super::owner()?;
    let head = Head::parse(&raw, runtime::info().model)?;
    let model = hash(&raw);
    let state = State {
        version: 1,
        model,
        head: Some(head),
    };
    if storage::encode(&state)?.len() as u64 > SLOT_BYTES {
        return Err(Error::Capacity);
    }
    STATE.with(|s| *s.borrow_mut() = state);
    Ok(model)
}
#[ic_cdk::query]
fn route_it_ticket(text: String) -> Result<RoutingReply> {
    let start = ic_cdk::api::instruction_counter();
    STATE.with(|s| {
        let s = s.borrow();
        let head = s
            .head
            .as_ref()
            .ok_or(Error::ModelUnavailable("IT routing head required".into()))?;
        let (result, input_tokens) = runtime::route_it(text, head)?;
        Ok(RoutingReply {
            model: s.model,
            base_model: head.base_model,
            result,
            input_tokens,
            measured_instructions: ic_cdk::api::instruction_counter() - start,
        })
    })
}
const _: () = {
    assert!(HEADER >= 48 && HEADER + 16 <= 64);
    assert!(SLOT_A >= 960 * 1024);
    assert!(SLOT_A + SLOT_BYTES <= SLOT_B);
    assert!(SLOT_B + SLOT_BYTES <= canister_common::SNAPSHOT_SLOT_A);
};
