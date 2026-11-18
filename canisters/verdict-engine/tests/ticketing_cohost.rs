//! Exact live-module upgrade, independent model uploads, cohost queries, rollback.
use candid::{CandidType, Decode, Encode, Principal};
use ic_agent::{identity::BasicIdentity, Identity};
use ic_laya_core::{
    hash, hex, CompiledSchema, Error, OptionDef, Primitive, Result, Schema, SpecialTokens,
};
use pocket_ic::{PocketIc, PocketIcBuilder};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Instant,
};
use verdict_engine::{
    DecideReply, DecideRequest, EngineInfo, ExecutionPricing, OptionSpec, QueryLimits, TicketReply,
    TicketingInfo, TicketingQueryLimits, TicketingStorage,
};
#[path = "../../test-support/pocket_server.rs"]
mod pocket_server;
const PREP: &str = "build/ticketing-cohost-prep-20261118";
// Public fixture seed [42;32], scoped to a disposable local test canister.
const TEST_OWNER_PEM:&str="-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEICoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioq\n-----END PRIVATE KEY-----\n";
struct TestKey(PathBuf);
impl Drop for TestKey {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}
fn raw(pic: &PocketIc, id: Principal, caller: Principal, method: &str, args: Vec<u8>) -> Vec<u8> {
    pic.update_call(id, caller, method, args)
        .unwrap_or_else(|e| panic!("{method}: {e:?}"))
}
fn update<T: CandidType + for<'a> Deserialize<'a>>(
    pic: &PocketIc,
    id: Principal,
    owner: Principal,
    method: &str,
    args: Vec<u8>,
) -> T {
    Decode!(&raw(pic, id, owner, method, args), Result<T>)
        .unwrap()
        .unwrap_or_else(|e| panic!("{method}: {e:?}"))
}
fn query<T: CandidType + for<'a> Deserialize<'a>>(
    pic: &PocketIc,
    id: Principal,
    method: &str,
    args: Vec<u8>,
) -> T {
    let b = pic
        .query_call(id, Principal::anonymous(), method, args)
        .unwrap_or_else(|e| panic!("{method}: {e:?}"));
    Decode!(&b, T).unwrap()
}
fn warm(pic: &PocketIc, id: Principal, owner: Principal, jp: bool) {
    let prefix = if jp { "ticketing_" } else { "" };
    let count = if jp {
        update::<u32>(
            pic,
            id,
            owner,
            &format!("{prefix}start_warmup"),
            Encode!().unwrap(),
        ) as u64
    } else {
        update::<u64>(pic, id, owner, "start_warmup", Encode!().unwrap())
    };
    for i in 0..count {
        let done = update::<bool>(
            pic,
            id,
            owner,
            &format!("{prefix}warmup_next"),
            Encode!().unwrap(),
        );
        assert_eq!(done, i + 1 == count);
    }
}
fn upload(
    pic: &PocketIc,
    id: Principal,
    owner: Principal,
    method: &str,
    bytes: &[u8],
    mut offset: u64,
) -> u64 {
    for chunk in bytes.chunks(1024 * 1024) {
        let end = update::<u64>(
            pic,
            id,
            owner,
            method,
            Encode!(&offset, &chunk.to_vec()).unwrap(),
        );
        assert_eq!(end, offset + chunk.len() as u64);
        offset = end;
    }
    offset
}
fn special() -> SpecialTokens {
    SpecialTokens {
        cls: 50281,
        sep: 50282,
        mask: 50284,
        pad: 50283,
        literals: vec![
            "[CLS]".into(),
            "[SEP]".into(),
            "[MASK]".into(),
            "[PAD]".into(),
        ],
    }
}
fn request() -> DecideRequest {
    DecideRequest {
        state: "Freeze my stolen card.".into(),
        question: "Choose the request.".into(),
        options: vec![
            OptionSpec {
                id: "freeze".into(),
                text: "Freeze card".into(),
            },
            OptionSpec {
                id: "balance".into(),
                text: "Check balance".into(),
            },
        ],
        abstention: false,
        temperature: 1.,
    }
}
fn legacy(pic: &PocketIc, id: Principal) -> DecideReply {
    query::<Result<DecideReply>>(pic, id, "decide_query", Encode!(&request()).unwrap()).unwrap()
}
fn same_legacy(a: &DecideReply, b: &DecideReply) {
    assert_eq!(a.model, b.model);
    assert_eq!(a.selected, b.selected);
    assert_eq!(a.logits, b.logits);
    assert_eq!(a.probabilities, b.probabilities);
}
fn legacy_boundary(
    pic: &PocketIc,
    id: Principal,
    owner: Principal,
    class_token: u32,
) -> verdict_engine::InferReply {
    // 25 candidates + CLS/SEP exactly fill the live 52-token query policy.
    let mut ids = vec![50281u32];
    for _ in 0..25 {
        ids.extend([class_token, 42]);
    }
    ids.push(50282);
    let raw = pic
        .query_call(id, owner, "infer_tokens_query", Encode!(&ids).unwrap())
        .unwrap();
    let reply = Decode!(&raw, Result<verdict_engine::InferReply>)
        .unwrap()
        .unwrap();
    assert_eq!(reply.input_tokens, 52);
    assert!(reply.measured_instructions < 5_000_000_000);
    reply
}
fn schema(n: usize) -> Schema {
    Schema {
        id: format!("cohost-{n}"),
        version: 1,
        primitive: Primitive::Choice,
        instructions: "Choose the request.".into(),
        options: vec![
            OptionDef {
                id: "freeze".into(),
                text: "Freeze card".into(),
            },
            OptionDef {
                id: "balance".into(),
                text: "Check balance".into(),
            },
        ],
    }
}
fn assert_preserved(pic: &PocketIc, id: Principal, owner: Principal, before: &EngineInfo) {
    let after: EngineInfo = query(pic, id, "info", Encode!().unwrap());
    assert_eq!(after.model, before.model);
    assert_eq!(after.model_bytes, before.model_bytes);
    assert_eq!(after.callers, 1);
    assert_eq!(after.cost_per_token, 92_000_000);
    assert_eq!(after.cost_fixed, 170_000_000);
    let limits: QueryLimits = query(pic, id, "query_limits", Encode!().unwrap());
    assert_eq!(limits.max_tokens, 52);
    let extra = Decode!(
        &raw(
            pic,
            id,
            owner,
            "register_schema",
            Encode!(&schema(64), &0u32).unwrap()
        ),
        Result<CompiledSchema>
    )
    .unwrap();
    assert!(
        matches!(extra, Err(Error::Capacity)),
        "64 existing schemas must survive"
    );
    update::<CompiledSchema>(
        pic,
        id,
        owner,
        "register_schema",
        Encode!(&schema(0), &0u32).unwrap(),
    );
}
fn save(p: &Path, r: &Value) {
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(r).unwrap()).unwrap();
    fs::rename(tmp, p).unwrap();
}

#[test]
#[ignore = "full real models; freeze production-reference.wasm and build cohost candidate first"]
fn cohost_upgrade_and_rollback() {
    let root = root();
    let out = root.join(
        std::env::var("COHOST_OUT").unwrap_or("artifacts/ticketing-ja/cohost/local.json".into()),
    );
    fs::create_dir_all(out.parent().unwrap()).unwrap();
    fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&out)
        .unwrap();
    let mut report = json!({"state":"running","mainnet_mutations":false,"precision_policy":"label drift accepted by user; original precision report preserved"});
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run(&root, &out, &mut report)
    }));
    if let Err(e) = result {
        report["state"] = json!("failed");
        report["failure"] = json!(e
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or("panic".into()));
        save(&out, &report);
        std::panic::resume_unwind(e);
    }
    report["state"] = json!("passed");
    save(&out, &report);
}
fn run(root: &Path, out: &Path, report: &mut Value) {
    let mut sources = serde_json::Map::new();
    for path in [
        "Cargo.lock",
        "canisters/verdict-engine/src/lib.rs",
        "canisters/verdict-engine/src/ticketing.rs",
        "crates/ticketing-runtime/src/lib.rs",
        "crates/ticketing-candle/src/lib.rs",
        "crates/verdict-simd/src/lib.rs",
        "tools/verdict-upload/src/ticketing.rs",
        "canisters/verdict-engine/tests/ticketing_cohost.rs",
    ] {
        sources.insert(
            path.into(),
            json!(hex(&hash(&fs::read(root.join(path)).unwrap()))),
        );
    }
    report["source_hashes"] = json!(sources);
    let prep = root.join(PREP);
    let old = fs::read(prep.join("production-reference.wasm")).unwrap();
    let candidate = fs::read(root.join("build/verdict-engine.wasm")).unwrap();
    let status: Value =
        serde_json::from_slice(&fs::read(prep.join("mainnet-before-status.json")).unwrap())
            .unwrap();
    assert_eq!(
        format!("0x{}", hex(&hash(&old))),
        status["module_hash"].as_str().unwrap(),
        "baseline must be exact live Wasm"
    );
    let pack = root.join("models/verdict-pack");
    let old_manifest = fs::read(pack.join("manifest.json")).unwrap();
    let old_bytes = fs::read(pack.join("model.bin")).unwrap();
    let old_tok = fs::read(root.join("models/verdict-151m/tokenizer.json")).unwrap();
    let jp = root.join("models/ticketing-ja/optimized-seed29-v1/int8");
    let jp_manifest = fs::read(jp.join("manifest.json")).unwrap();
    let jp_bytes = fs::read(jp.join("model.bin")).unwrap();
    let jp_tok = fs::read(jp.join("tokenizer.json")).unwrap();
    let native: Value = serde_json::from_slice(
        &fs::read(root.join("artifacts/ticketing-ja/cohost/native.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        hex(&hash(&jp_manifest)),
        native["packs"]["int8"]["manifest_sha256"].as_str().unwrap()
    );
    report["hashes"] = json!({"live_reference_wasm":hex(&hash(&old)),"candidate_wasm":hex(&hash(&candidate)),"legacy_manifest":hex(&hash(&old_manifest)),"ticketing_manifest":hex(&hash(&jp_manifest))});
    report["candidate_wasm_bytes"] = json!(candidate.len());
    save(out, report);
    let server = pocket_server::Server::start();
    let mut pic = PocketIcBuilder::new()
        .with_server_url(server.url.parse().unwrap())
        .with_application_subnet()
        .build();
    let owner = BasicIdentity::from_raw_key(&[42; 32]).sender().unwrap();
    let caller = Principal::self_authenticating(b"cohost-client");
    let id = pic.create_canister();
    pic.add_cycles(id, 10_000_000_000_000_000);
    pic.install_canister(id, old.clone(), Encode!(&owner).unwrap(), None);
    update::<[u8; 32]>(
        &pic,
        id,
        owner,
        "begin_upload",
        Encode!(&old_manifest, &(old_tok.len() as u64), &special()).unwrap(),
    );
    let end = upload(&pic, id, owner, "upload_chunk", &old_bytes, 0);
    upload(&pic, id, owner, "upload_chunk", &old_tok, end);
    warm(&pic, id, owner, false);
    update::<()>(
        &pic,
        id,
        owner,
        "set_cost_model",
        Encode!(&170_000_000u64, &92_000_000u64, &40_000_000_000u64).unwrap(),
    );
    update::<()>(&pic, id, owner, "allow_caller", Encode!(&caller).unwrap());
    for n in 0..64 {
        update::<CompiledSchema>(
            &pic,
            id,
            owner,
            "register_schema",
            Encode!(&schema(n), &0u32).unwrap(),
        );
    }
    let pricing = Some(ExecutionPricing {
        base_cycles: 5_000_000,
        instruction_cycles_numerator: 4,
        instruction_cycles_denominator: 1,
    });
    update::<()>(
        &pic,
        id,
        owner,
        "set_execution_pricing",
        Encode!(&pricing).unwrap(),
    );
    let before: EngineInfo = query(&pic, id, "info", Encode!().unwrap());
    let original = legacy(&pic, id);
    let class_token = verdict_candle::pack::Manifest::parse(&old_manifest)
        .unwrap()
        .config
        .class_token_id;
    let old_boundary = legacy_boundary(&pic, id, owner, class_token);
    report["legacy_before"] = serde_json::to_value(&before).unwrap();
    report["legacy_reply"] = serde_json::to_value(&original).unwrap();
    save(out, report);
    eprintln!("Legacy live module loaded; upgrading to dual-model candidate");
    pic.upgrade_canister(id, candidate.clone(), Encode!().unwrap(), None)
        .unwrap();
    warm(&pic, id, owner, false);
    assert_preserved(&pic, id, owner, &before);
    same_legacy(&original, &legacy(&pic, id));
    let quote = query::<Result<verdict_engine::CyclesPricing>>(
        &pic,
        id,
        "cycles_pricing",
        Encode!().unwrap(),
    )
    .unwrap();
    assert_eq!(quote.execution.base_cycles, 5_000_000);
    let unauthorized = Decode!(
        &raw(
            &pic,
            id,
            Principal::anonymous(),
            "ticketing_begin_upload",
            Encode!(&jp_manifest, &(jp_tok.len() as u64)).unwrap()
        ),
        Result<[u8; 32]>
    )
    .unwrap();
    assert!(matches!(unauthorized, Err(Error::Unauthorized)));
    update::<[u8; 32]>(
        &pic,
        id,
        owner,
        "ticketing_begin_upload",
        Encode!(&jp_manifest, &(jp_tok.len() as u64)).unwrap(),
    );
    let first = 1024 * 1024;
    let next = upload(
        &pic,
        id,
        owner,
        "ticketing_upload_chunk",
        &jp_bytes[..first],
        0,
    );
    same_legacy(&original, &legacy(&pic, id));
    // A valid larger primary manifest must be refused before clearing either model.
    let mut larger = verdict_candle::pack::Manifest::parse(&old_manifest).unwrap();
    larger.config.vocab_size = 250000;
    let mut pos = 0;
    for e in &mut larger.tensors {
        if e.name == "embeddings.weight" {
            e.shape[0] = 250000;
        }
        e.offset = pos;
        let n = e.shape.iter().product::<usize>() as u64;
        e.length = if e.encoding == verdict_candle::pack::Encoding::I8RowSymmetric {
            n + 4 * e.shape[0] as u64
        } else {
            n * 4
        };
        pos += e.length;
    }
    larger.total_bytes = pos;
    larger.validate().unwrap();
    let larger = serde_json::to_vec(&larger).unwrap();
    let collision = Decode!(
        &raw(
            &pic,
            id,
            owner,
            "begin_upload",
            Encode!(&larger, &(old_tok.len() as u64), &special()).unwrap()
        ),
        Result<[u8; 32]>
    )
    .unwrap();
    assert!(matches!(collision, Err(Error::Capacity)));
    same_legacy(&original, &legacy(&pic, id));
    pic.upgrade_canister(id, candidate.clone(), Encode!().unwrap(), None)
        .unwrap();
    let resumed: TicketingInfo = query(&pic, id, "ticketing_info", Encode!().unwrap());
    assert_eq!(resumed.received, next);
    warm(&pic, id, owner, false);
    same_legacy(&original, &legacy(&pic, id));
    // Exercise the actual signed HTTP upload CLI, resuming the partial upload.
    let key = TestKey(
        std::env::temp_dir().join(format!("cohost-public-test-key-{}.pem", std::process::id())),
    );
    fs::write(&key.0, TEST_OWNER_PEM).unwrap();
    let gateway = pic.make_live(None);
    let output = std::process::Command::new(root.join("target/release/ticketing-upload"))
        .arg("--pack")
        .arg(&jp)
        .args([
            "--url",
            gateway.as_str(),
            "--canister",
            &id.to_text(),
            "--pem",
        ])
        .arg(&key.0)
        .args([
            "--expected-legacy-model",
            &hex(&before.model),
            "--upload",
            "--resume",
            "--max-tokens",
            "65",
            "--accept-label-drift",
        ])
        .output()
        .unwrap();
    pic.stop_live();
    report["upload_cli"] = json!({"success":output.status.success(),"stdout":String::from_utf8_lossy(&output.stdout),"stderr":String::from_utf8_lossy(&output.stderr),"binary_sha256":hex(&hash(&fs::read(root.join("target/release/ticketing-upload")).unwrap()))});
    save(out, report);
    assert!(
        output.status.success(),
        "upload CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    same_legacy(&original, &legacy(&pic, id));
    report["both_loaded"] = json!({"legacy":query::<EngineInfo>(&pic,id,"info",Encode!().unwrap()),"ticketing":query::<TicketingInfo>(&pic,id,"ticketing_info",Encode!().unwrap())});
    let new_boundary = legacy_boundary(&pic, id, owner, class_token);
    assert_eq!(old_boundary.logits, new_boundary.logits);
    assert!(new_boundary.measured_instructions <= old_boundary.measured_instructions * 105 / 100);
    report["legacy_52_token_query"] = json!({"before":old_boundary.measured_instructions,"cohost":new_boundary.measured_instructions,"logits_bit_identical":true});
    save(out, report);
    eprintln!("Both models loaded; calibrating every input length");
    let mut limit = 0;
    let mut probes = Vec::new();
    for n in 3..=128 {
        let text = if n == 3 {
            "x".into()
        } else {
            "x ".repeat(n - 3)
        };
        let r = update::<TicketReply>(
            &pic,
            id,
            owner,
            "ticketing_benchmark",
            Encode!(&text).unwrap(),
        );
        assert_eq!(r.input_tokens, n as u32);
        probes.push(json!({"tokens":n,"instructions":r.measured_instructions}));
        if r.measured_instructions > 4_500_000_000 {
            break;
        }
        limit = n;
    }
    assert!(limit >= 18);
    report["query_limit"] = json!(limit);
    report["calibration"] = json!(probes);
    update::<()>(
        &pic,
        id,
        owner,
        "ticketing_set_query_limit",
        Encode!(&(limit as u32)).unwrap(),
    );
    save(out, report);
    let mut predictions = Vec::new();
    for (i, row) in native["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["split"] == "validation" || r["split"] == "test")
        .enumerate()
    {
        let text = row["text"].as_str().unwrap().to_string();
        let start = Instant::now();
        let reply =
            query::<Result<TicketReply>>(&pic, id, "classify_ticket", Encode!(&text).unwrap())
                .unwrap();
        assert!(reply.measured_instructions <= 4_500_000_000);
        for (task, labels, selected) in [
            (
                "department",
                ["it", "hr", "finance", "admin"].as_slice(),
                reply.department.selected.as_str(),
            ),
            (
                "priority",
                ["low", "normal", "high"].as_slice(),
                reply.priority.selected.as_str(),
            ),
        ] {
            let logits = row["int8"][task].as_array().unwrap();
            let best = (0..logits.len())
                .max_by(|&a, &b| {
                    logits[a]
                        .as_f64()
                        .unwrap()
                        .total_cmp(&logits[b].as_f64().unwrap())
                })
                .unwrap();
            assert_eq!(selected, labels[best]);
        }
        predictions.push(
            json!({"id":row["id"],"reply":reply,"wall_seconds":start.elapsed().as_secs_f64()}),
        );
        if i % 12 == 0 {
            same_legacy(&original, &legacy(&pic, id));
        }
    }
    assert_eq!(predictions.len(), 72);
    report["ticketing_predictions"] = json!(predictions);
    save(out, report);
    let denied = Decode!(
        &raw(
            &pic,
            id,
            Principal::anonymous(),
            "ticketing_clear_model",
            Encode!().unwrap()
        ),
        Result<()>
    )
    .unwrap();
    assert!(matches!(denied, Err(Error::Unauthorized)));
    // Upgrades reset Japanese calibration while preserving both independent packs.
    pic.upgrade_canister(id, candidate.clone(), Encode!().unwrap(), None)
        .unwrap();
    assert_eq!(
        query::<TicketingQueryLimits>(&pic, id, "ticketing_query_limits", Encode!().unwrap())
            .max_tokens,
        0
    );
    warm(&pic, id, owner, false);
    warm(&pic, id, owner, true);
    assert_preserved(&pic, id, owner, &before);
    same_legacy(&original, &legacy(&pic, id));
    let text = "接続できません".to_string();
    assert!(matches!(
        query::<Result<TicketReply>>(&pic, id, "classify_ticket", Encode!(&text).unwrap()),
        Err(Error::Capacity)
    ));
    update::<()>(
        &pic,
        id,
        owner,
        "ticketing_set_query_limit",
        Encode!(&(limit as u32)).unwrap(),
    );
    let jp_before =
        query::<Result<TicketReply>>(&pic, id, "classify_ticket", Encode!(&text).unwrap()).unwrap();
    eprintln!("Rolling back to exact live Wasm, then forward to candidate again");
    pic.upgrade_canister(id, old.clone(), Encode!().unwrap(), None)
        .unwrap();
    warm(&pic, id, owner, false);
    assert_preserved(&pic, id, owner, &before);
    same_legacy(&original, &legacy(&pic, id));
    pic.upgrade_canister(id, candidate.clone(), Encode!().unwrap(), None)
        .unwrap();
    warm(&pic, id, owner, false);
    warm(&pic, id, owner, true);
    assert_preserved(&pic, id, owner, &before);
    same_legacy(&original, &legacy(&pic, id));
    update::<()>(
        &pic,
        id,
        owner,
        "ticketing_set_query_limit",
        Encode!(&(limit as u32)).unwrap(),
    );
    let jp_after =
        query::<Result<TicketReply>>(&pic, id, "classify_ticket", Encode!(&text).unwrap()).unwrap();
    assert_eq!(jp_before.model, jp_after.model);
    assert_eq!(
        jp_before.department.probabilities,
        jp_after.department.probabilities
    );
    assert_eq!(
        jp_before.priority.probabilities,
        jp_after.priority.probabilities
    );
    report["after_rollback_and_forward"] = json!({"legacy":query::<EngineInfo>(&pic,id,"info",Encode!().unwrap()),"ticketing":query::<TicketingInfo>(&pic,id,"ticketing_info",Encode!().unwrap())});
    // The old Wasm does not know about Japanese storage reservations. Exercise
    // a real overlapping write there, then ensure forward upgrade remains usable.
    let storage: TicketingStorage = query(&pic, id, "ticketing_storage", Encode!().unwrap());
    assert!(storage.reserved);
    pic.upgrade_canister(id, old, Encode!().unwrap(), None)
        .unwrap();
    update::<[u8; 32]>(
        &pic,
        id,
        owner,
        "begin_upload",
        Encode!(&larger, &(old_tok.len() as u64), &special()).unwrap(),
    );
    let overwritten = 65536usize;
    let partial = vec![0; storage.legacy_slot_bytes as usize + overwritten];
    let received = upload(&pic, id, owner, "upload_chunk", &partial, 0);
    pic.upgrade_canister(id, candidate, Encode!().unwrap(), None)
        .unwrap();
    let invalidated: TicketingInfo = query(&pic, id, "ticketing_info", Encode!().unwrap());
    assert_eq!(invalidated.model, [0; 32]);
    assert!(!invalidated.ready);
    assert_eq!(
        query::<TicketingQueryLimits>(&pic, id, "ticketing_query_limits", Encode!().unwrap())
            .max_tokens,
        0
    );
    assert!(!query::<TicketingStorage>(&pic, id, "ticketing_storage", Encode!().unwrap()).reserved);
    let pending: EngineInfo = query(&pic, id, "info", Encode!().unwrap());
    assert_eq!(pending.callers, 1);
    assert!(!pending.upload_complete);
    // Cancel the intentionally incomplete primary replacement and restore the
    // original bytes, then independently re-upload the Japanese model.
    update::<[u8; 32]>(
        &pic,
        id,
        owner,
        "begin_upload",
        Encode!(&old_manifest, &(old_tok.len() as u64), &special()).unwrap(),
    );
    let end = upload(&pic, id, owner, "upload_chunk", &old_bytes, 0);
    upload(&pic, id, owner, "upload_chunk", &old_tok, end);
    warm(&pic, id, owner, false);
    assert_preserved(&pic, id, owner, &before);
    same_legacy(&original, &legacy(&pic, id));
    update::<[u8; 32]>(
        &pic,
        id,
        owner,
        "ticketing_begin_upload",
        Encode!(&jp_manifest, &(jp_tok.len() as u64)).unwrap(),
    );
    let end = upload(&pic, id, owner, "ticketing_upload_chunk", &jp_bytes, 0);
    upload(&pic, id, owner, "ticketing_upload_chunk", &jp_tok, end);
    warm(&pic, id, owner, true);
    update::<()>(
        &pic,
        id,
        owner,
        "ticketing_set_query_limit",
        Encode!(&(limit as u32)).unwrap(),
    );
    let recovered =
        query::<Result<TicketReply>>(&pic, id, "classify_ticket", Encode!(&text).unwrap()).unwrap();
    assert_eq!(recovered.model, jp_before.model);
    assert_eq!(
        recovered.department.probabilities,
        jp_before.department.probabilities
    );
    assert_eq!(
        recovered.priority.probabilities,
        jp_before.priority.probabilities
    );
    same_legacy(&original, &legacy(&pic, id));
    report["rollback_overlap_recovery"] = json!({"passed":true,"overwritten_japanese_bytes":overwritten,"primary_received_before_recovery":received,"invalidated_ticketing":invalidated,"recovered_ticketing_model":hex(&recovered.model)});
    report["checks"] = json!([
        "exact production module baseline",
        "legacy API outputs bit-identical",
        "caller, 64 schemas, pricing and cost model preserved",
        "partial Japanese upload survives upgrade",
        "overlapping primary upload refused without clearing legacy model",
        "72 Japanese predictions match native INT8",
        "Japanese upload does not interrupt warm legacy queries",
        "upgrade resets Japanese calibration",
        "exact live Wasm rollback and roll-forward preserve both packs",
        "legacy upload overlapping Japanese bytes during rollback does not block forward upgrade",
        "invalidated Japanese model can be re-uploaded after primary recovery"
    ]);
}
