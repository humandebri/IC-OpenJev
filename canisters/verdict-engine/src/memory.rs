//! Loading policy. Production policy is fixed; experimental switches exist only
//! in the explicitly enabled memory-bench build and never alter the stable schema.
#[cfg(feature = "memory-bench")]
use super::*;
#[cfg(feature = "memory-bench")]
use modernbert_candle::weights;
const DEFAULT_STREAM_NAMES: &[&str] = &[
    "encoder.0.qkv.weight",
    "encoder.0.wi.weight",
    "encoder.1.qkv.weight",
    "encoder.1.wi.weight",
    "encoder.10.qkv.weight",
    "encoder.10.wi.weight",
    "encoder.11.qkv.weight",
    "encoder.11.wi.weight",
    "encoder.12.qkv.weight",
    "encoder.12.wi.weight",
    "encoder.13.qkv.weight",
    "encoder.13.wi.weight",
    "encoder.14.qkv.weight",
    "encoder.14.wi.weight",
    "encoder.15.qkv.weight",
    "encoder.15.wi.weight",
    "encoder.16.qkv.weight",
    "encoder.16.wi.weight",
];
#[derive(Clone)]
pub(crate) struct Policy {
    pub mode: u8,
    pub chunk: usize,
    pub names: Vec<String>,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            // Measured against the frozen 151M pack: on-demand embeddings and
            // these 18 dense matrices, with a pre-initialized reusable window.
            // Do not enlarge this set without repeating the per-input 5% gate.
            mode: 7,
            chunk: 1024 * 1024,
            names: DEFAULT_STREAM_NAMES
                .iter()
                .map(|name| (*name).to_owned())
                .collect(),
        }
    }
}
#[cfg(feature = "memory-bench")]
thread_local! {static POLICY:RefCell<Policy>=RefCell::new(Policy::default());}
pub(crate) fn policy() -> Policy {
    #[cfg(feature = "memory-bench")]
    {
        POLICY.with(|p| p.borrow().clone())
    }
    #[cfg(not(feature = "memory-bench"))]
    {
        Policy::default()
    }
}
pub(crate) fn streamed(p: &Policy, name: &str) -> bool {
    if name == "embeddings.weight" {
        return p.mode >= 2;
    }
    match p.mode {
        3 | 4 => true,
        5 => name.starts_with("encoder.0."),
        6 | 7 => p.names.iter().any(|x| x == name),
        _ => false,
    }
}
pub(crate) fn read_pack(at: u64, bytes: &mut [u8]) -> candle_core::Result<()> {
    #[cfg(feature = "memory-bench")]
    let start = ic_cdk::api::instruction_counter();
    if at
        .checked_add(bytes.len() as u64)
        .is_none_or(|end| end > ic_cdk::stable::stable_size() * 65536)
    {
        return Err(candle_core::Error::Msg(
            "pack read outside stable memory".into(),
        ));
    }
    ic_cdk::stable::stable_read(at, bytes);
    #[cfg(feature = "memory-bench")]
    weights::record_read(
        bytes.len() as u64,
        ic_cdk::api::instruction_counter().saturating_sub(start),
    );
    Ok(())
}
pub(crate) fn window(
    p: &Policy,
    m: &verdict_candle::pack::Manifest,
    name: &str,
) -> Option<(u64, usize)> {
    if p.mode != 4 || !name.starts_with("encoder.") {
        return None;
    }
    let prefix = name.rsplit_once('.').map(|x| x.0)?;
    // encoder.<layer>.<matrix>.weight -> group by encoder.<layer>.
    let mut parts = prefix.split('.');
    let group = format!("{}.{}.", parts.next()?, parts.next()?);
    let entries: Vec<_> = m
        .tensors
        .iter()
        .filter(|e| e.name.starts_with(&group))
        .collect();
    let first = entries.iter().map(|e| e.offset).min()?;
    let last = entries.iter().map(|e| e.offset + e.length).max()?;
    Some((canister_common::BLOB_BASE + first, (last - first) as usize))
}

#[cfg(feature = "memory-bench")]
mod bench {
    use super::*;
    use serde_json::json;
    #[ic_cdk::update]
    fn memory_config(mode: u8, chunk: u32, names: Vec<String>) -> Result<()> {
        owner()?;
        if mode > 7 || !(4096..=1024 * 1024).contains(&chunk) {
            return Err(Error::Invalid("memory policy".into()));
        }
        if MODEL.with(|m| m.borrow().is_some()) || BUILDER.with(|b| b.borrow().is_some()) {
            return Err(Error::Transition);
        }
        POLICY.with(|p| {
            *p.borrow_mut() = Policy {
                mode,
                chunk: chunk as usize,
                names,
            }
        });
        Ok(())
    }
    #[ic_cdk::query]
    fn memory_stats() -> String {
        let p = policy();
        let io = weights::metrics();
        let metadata = read(|s| {
            s.upload
                .as_ref()
                .and_then(|u| verdict_candle::pack::Manifest::parse(&u.manifest).ok())
        });
        let mut resident = 0u64;
        let mut streamed_bytes = 0u64;
        let loaded = if MODEL.with(|m| m.borrow().is_some()) {
            usize::MAX
        } else {
            BUILDER.with(|b| b.borrow().as_ref().map(|b| b.next).unwrap_or(0))
        };
        if let Some(m) = metadata {
            for e in m.tensors.into_iter().take(loaded) {
                if e.encoding == verdict_candle::pack::Encoding::I8RowSymmetric
                    && streamed(&p, &e.name)
                {
                    let n = (e.shape[0] * e.shape[1]) as u64;
                    streamed_bytes += n;
                    resident += e.length - n;
                } else {
                    resident += e.length;
                }
            }
        }
        json!({"heap_bytes":heap_bytes(),"stable_bytes":ic_cdk::stable::stable_size()*65536,
            "scratch_capacity":weights::scratch_capacity(),"weight_resident_payload_bytes":resident,
            "tokenizer_initialized":TOKENIZER.with(|t|t.borrow().is_some()),
            "tokenizer_json_bytes":read(|s|s.upload.as_ref().map(|u|u.tokenizer_length)),
            "tokenizer_initialization_heap_growth_bytes":TOKENIZER_GROWTH.with(|x|x.get()),
            "weight_streamed_payload_bytes":streamed_bytes,"mode":p.mode,"chunk":p.chunk,"stream_names":p.names,"io":io,
            "note":"payload sizes exclude allocator metadata; heap_bytes is allocated linear memory, not live allocations"}).to_string()
    }
    fn probe(ids: Vec<u32>, nonce: u64, detailed: bool) -> Result<String> {
        owner()?;
        if ids.is_empty() || ids.len() > read(|s| s.max_input_tokens) as usize {
            return Err(Error::TooLong);
        }
        let entry = ic_cdk::api::instruction_counter();
        let mut phases = Vec::new();
        let mut last = entry;
        let result = MODEL.with(|cell| {
            let m = cell.borrow();
            let m = m.as_ref().ok_or(Error::Transition)?;
            m.logits_profiled(
                &ids,
                &mut |name| {
                    let now = ic_cdk::api::instruction_counter();
                    phases.push(json!({"name":name,"instructions":now-last}));
                    last = now;
                },
                detailed,
            )
        })?;
        let io = weights::metrics();
        let encoded=json!({"nonce":nonce,"ids":ids,"logit_bits":result.iter().map(|x|x.to_bits()).collect::<Vec<_>>(),
            "phases":phases,"io":io,"heap_bytes":heap_bytes(),"scratch_capacity":weights::scratch_capacity(),
            "handler_to_result_instructions":ic_cdk::api::instruction_counter().saturating_sub(entry),
            "counter_boundary":"after model result, before JSON/Candid reply encoding",
            "instructions_through_argument_decode":ic_cdk::api::instruction_counter()}).to_string();
        Ok(encoded)
    }
    #[ic_cdk::query]
    fn memory_probe(ids: Vec<u32>, nonce: u64, detailed: bool) -> Result<String> {
        billing::query_only()?;
        probe(ids, nonce, detailed)
    }
    #[ic_cdk::update]
    fn memory_probe_update(ids: Vec<u32>, nonce: u64, detailed: bool) -> Result<String> {
        probe(ids, nonce, detailed)
    }
    #[ic_cdk::query]
    fn memory_tokens(req: DecideRequest) -> Result<Vec<u32>> {
        owner()?;
        decision_ids(&req)
    }
    #[ic_cdk::query]
    fn memory_decide(req: DecideRequest, nonce: u64) -> Result<String> {
        owner()?;
        billing::query_only()?;
        let ids = decision_ids(&req)?;
        let reply = decide_once(req, UPDATE_BUDGET)?;
        Ok(json!({"nonce":nonce,"token_ids":ids,"logit_bits":reply.logits.iter().map(|x|x.to_bits()).collect::<Vec<_>>(),
            "probability_bits":reply.probabilities.iter().map(|x|x.to_bits()).collect::<Vec<_>>(),"selected":reply.selected,
            "model_instructions":reply.measured_instructions,"io":weights::metrics(),"heap_bytes":heap_bytes()}).to_string())
    }
    fn decision_ids(req: &DecideRequest) -> Result<Vec<u32>> {
        use ic_laya_core::schema::TextTokenizer;
        let mut labels: Vec<String> = req.options.iter().map(|o| o.text.clone()).collect();
        if req.abstention {
            labels.push(ABSTENTION_DESC.into());
        }
        TOKENIZER.with(|t| {
            MODEL.with(|m| {
                let t = t.borrow();
                let t = t.as_ref().ok_or(Error::Transition)?;
                let m = m.borrow();
                let m = m.as_ref().ok_or(Error::Transition)?;
                let prompt = verdict_candle::render_prompt_checked(
                    &req.question,
                    &req.state,
                    &labels,
                    &t.special_tokens(),
                )?;
                let mut ids = vec![m.config.cls_token_id];
                ids.extend(t.encode_piece(&prompt)?);
                ids.push(m.config.sep_token_id);
                Ok(ids)
            })
        })
    }
}

#[cfg(feature = "memory-bench")]
thread_local! {static TOKENIZER_GROWTH:std::cell::Cell<u64>=const{std::cell::Cell::new(0)};}
#[cfg(feature = "memory-bench")]
pub(crate) fn tokenizer_growth(before: u64) {
    TOKENIZER_GROWTH.with(|x| x.set(heap_bytes().saturating_sub(before)));
}
