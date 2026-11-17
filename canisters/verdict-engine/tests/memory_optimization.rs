//! Reproducible full-checkpoint memory comparison on disposable PocketIC canisters.
//! No network selector and no existing canister ID are accepted.
//! MEMORY_RUNS='legacy:0:262144,embedding:2:262144,matrices:3:262144'
//! MEMORY_REPEATS=1 (screen) or 15 (final), MEMORY_OUT=artifacts/.../run.json
use candid::{Decode, Encode, Principal};
use ic_laya_core::{hash, schema::TextTokenizer, Result, SpecialTokens};
use pocket_ic::{PocketIc, PocketIcBuilder};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Instant,
};
use verdict_engine::{
    DecideReply, DecideRequest, EngineInfo, ExecutionPricing, InferReply, OptionSpec,
};

// The library's implicit server has a 600-second hard TTL. This long-running
// measurement owns a server with only an idle TTL, and always reaps it on exit.
struct LocalServer {
    child: std::process::Child,
    port: PathBuf,
    url: String,
}
impl LocalServer {
    fn start() -> Self {
        let binary = std::env::var_os("POCKET_IC_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("pocket-ic-server-15.0.0/pocket-ic"));
        let version = std::process::Command::new(&binary)
            .arg("--version")
            .output()
            .expect("set POCKET_IC_BIN to PocketIC 15");
        assert!(
            String::from_utf8_lossy(&version.stdout).contains("15.0."),
            "requires PocketIC 15; found {}",
            String::from_utf8_lossy(&version.stdout)
        );
        let port = std::env::temp_dir().join(format!("openjev-memory-{}.port", std::process::id()));
        let _ = fs::remove_file(&port);
        let child = std::process::Command::new(binary)
            .args([
                "--ip-addr",
                "127.0.0.1",
                "--ttl",
                "120",
                "--log-levels",
                "error",
                "--port-file",
            ])
            .arg(&port)
            .spawn()
            .unwrap();
        let mut server = Self {
            child,
            port,
            url: String::new(),
        };
        for _ in 0..600 {
            if let Ok(port) = fs::read_to_string(&server.port) {
                if let Ok(port) = port.trim().parse::<u16>() {
                    server.url = format!("http://127.0.0.1:{port}");
                    return server;
                }
            }
            assert!(
                server.child.try_wait().unwrap().is_none(),
                "PocketIC exited before startup"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("PocketIC did not start within 30 seconds");
    }
}
impl Drop for LocalServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_file(&self.port);
    }
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn persist(path: &Path, v: &Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(&temporary, serde_json::to_vec_pretty(v).unwrap()).unwrap();
    fs::rename(&temporary, path).unwrap();
}
fn check_run_config(prior: &Value, fresh: &Value) {
    for field in ["wasm_sha256", "mode", "chunk", "stream_names"] {
        assert_eq!(
            prior[field], fresh[field],
            "resume configuration differs: {field}"
        );
    }
}
fn check_resume_configs(previous: &Value, configs: &[(String, Value)]) {
    let names: std::collections::BTreeSet<_> =
        configs.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(
        names.len(),
        configs.len(),
        "duplicate measurement run names"
    );
    for name in previous["runs"].as_object().unwrap().keys() {
        assert!(
            names.iter().any(|n| *n == name.as_str()),
            "resume omitted previous run: {name}"
        );
    }
    for (name, config) in configs {
        if let Some(prior) = previous["runs"].get(name) {
            check_run_config(prior, config);
        }
    }
}
// Preserve completed samples before the first setup checkpoint is written.
fn begin_run(report: &mut Value, name: &str, mut fresh: Value) {
    if let Some(prior) = report["runs"].get(name) {
        check_run_config(prior, &fresh);
        fresh["samples"] = prior["samples"].clone();
    }
    report["runs"][name] = fresh;
}
fn call(pic: &PocketIc, id: Principal, owner: Principal, method: &str, args: Vec<u8>) -> Vec<u8> {
    pic.update_call(id, owner, method, args)
        .unwrap_or_else(|e| panic!("{method}: {e:?}"))
}
fn query(pic: &PocketIc, id: Principal, owner: Principal, method: &str, args: Vec<u8>) -> Vec<u8> {
    pic.query_call(id, owner, method, args)
        .unwrap_or_else(|e| panic!("{method}: {e:?}"))
}
fn stats(pic: &PocketIc, id: Principal, owner: Principal, diag: bool) -> Value {
    let status = pic.canister_status(id, None).unwrap();
    let info = Decode!(
        &query(pic, id, owner, "info", Encode!().unwrap()),
        EngineInfo
    )
    .unwrap();
    let mut value = if diag {
        let raw = Decode!(
            &query(pic, id, owner, "memory_stats", Encode!().unwrap()),
            String
        )
        .unwrap();
        serde_json::from_str(&raw).unwrap()
    } else {
        json!({"heap_bytes":info.heap_bytes})
    };
    value["management_memory_bytes"] =
        json!(status.memory_size.0.to_string().parse::<u64>().unwrap());
    value["model_hash"] = json!(hex(&info.model));
    value["warmed"] = json!(info.warmed);
    value["idle_cycles_burned_per_day"] = json!(status.idle_cycles_burned_per_day.0.to_string());
    value
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
fn decision(v: &Value) -> DecideRequest {
    DecideRequest {
        state: v["state"].as_str().unwrap().into(),
        question: v["question"].as_str().unwrap().into(),
        options: v["options"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| OptionSpec {
                id: o["id"].as_str().unwrap().into(),
                text: o["text"].as_str().unwrap().into(),
            })
            .collect(),
        abstention: v["abstention"].as_bool().unwrap_or(true),
        temperature: 1.0,
    }
}
fn corpus(root: &Path) -> Vec<Value> {
    let tok = hf_tokenizer::HfTokenizer::from_bytes(
        &fs::read(root.join("models/verdict-151m/tokenizer.json")).unwrap(),
        special(),
    )
    .unwrap();
    let mut cases = Vec::new();
    let mut seed = 0x4f50454e4a4556u64;
    for length in [6usize, 14, 20, 30, 39, 40, 41, 48, 64, 128] {
        for classes in [1usize, 2, 4, 25] {
            if classes + 2 > length {
                continue;
            }
            for pattern in ["repeat", "spread"] {
                let mut ids = vec![50281u32];
                ids.extend(std::iter::repeat_n(50368, classes));
                while ids.len() + 1 < length {
                    seed = seed
                        .wrapping_mul(6364136223846793005)
                        .wrapping_add(1442695040888963407);
                    ids.push(if pattern == "repeat" {
                        101
                    } else {
                        5 + ((seed >> 32) % 50270) as u32
                    });
                }
                ids.push(50282);
                cases.push(json!({"name":format!("tokens-{length}-classes-{classes}-{pattern}"),"ids":ids}));
            }
        }
    }
    // Boundary vocabulary IDs and repeated markers are included without reducing the model vocabulary.
    cases.push(json!({"name":"vocabulary-boundaries","ids":[50281,50368,0,50369,0,50282]}));
    for line in fs::read_to_string(root.join("models/verdict-parity/cases.jsonl"))
        .unwrap()
        .lines()
    {
        if cases.iter().filter(|c| c.get("request").is_some()).count() >= 32 {
            break;
        }
        let row: Value = serde_json::from_str(line).unwrap();
        let options: Vec<Value> = row["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|o| o["id"] != "__insufficient_evidence__")
            .map(|o| json!({"id":o["id"],"text":o["description"]}))
            .collect();
        let req = json!({"state":row["text"],"question":row["question"],"options":options});
        let d = decision(&req);
        let mut labels: Vec<String> = d.options.iter().map(|o| o.text.clone()).collect();
        labels.push("insufficient evidence".into());
        let prompt =
            verdict_candle::render_prompt_checked(&d.question, &d.state, &labels, &special())
                .unwrap();
        let mut ids = vec![50281u32];
        ids.extend(tok.encode_piece(&prompt).unwrap());
        ids.push(50282);
        if ids.len() <= 128 {
            cases.push(json!({"name":row["id"],"ids":ids,"request":req}));
        }
    }
    assert_eq!(
        cases.iter().filter(|c| c.get("request").is_some()).count(),
        32
    );
    // Replay the exact prompts recorded on the deployed Tetris demo.
    let game: Value = serde_json::from_slice(
        &fs::read(root.join("artifacts/tetris-prompt-search/production-query-check.json")).unwrap(),
    )
    .unwrap();
    for (i, row) in game["results"].as_array().unwrap().iter().enumerate() {
        let mut ids = vec![50281u32];
        ids.extend(
            tok.encode_piece(row["receipt"]["prompt"].as_str().unwrap())
                .unwrap(),
        );
        ids.push(50282);
        assert_eq!(
            ids.len(),
            row["receipt"]["input_tokens"].as_u64().unwrap() as usize
        );
        let prompt = row["receipt"]["prompt"].as_str().unwrap();
        let (labels, state) = prompt.split_once("<<SEP>>").unwrap();
        let options: Vec<Value> = labels
            .strip_prefix("<<LABEL>>")
            .unwrap()
            .split("<<LABEL>>")
            .enumerate()
            .map(|(i, text)| json!({"id":i.to_string(),"text":text}))
            .collect();
        let req = json!({"state":state,"question":"","options":options,"abstention":false});
        let d = decision(&req);
        let labels = d.options.iter().map(|o| o.text.clone()).collect::<Vec<_>>();
        assert_eq!(
            verdict_candle::render_prompt_checked(&d.question, &d.state, &labels, &special())
                .unwrap(),
            prompt
        );
        cases.push(json!({"name":format!("production-tetris-{i}"),"ids":ids,"request":req,"require_decision_query":true}));
    }
    cases
}
struct Run {
    name: String,
    id: Principal,
    diag: bool,
}
fn stream_names(root: &Path, mode: u8, names_limit: usize) -> Vec<String> {
    let mut names: Vec<String> =
        if mode == 6 || mode == 7 {
            serde_json::from_slice(
                &fs::read(root.join(
                    std::env::var("MEMORY_NAMES_FILE").expect("mode 6 needs MEMORY_NAMES_FILE"),
                ))
                .unwrap(),
            )
            .expect("stream names JSON array")
        } else {
            Vec::new()
        };
    names.truncate(names_limit);
    if mode == 6 || mode == 7 {
        assert!(!names.is_empty(), "streaming selection must not be empty");
    }
    names
}
fn setup(
    pic: &PocketIc,
    root: &Path,
    owner: Principal,
    name: &str,
    mode: u8,
    chunk: u32,
    wasm: &[u8],
    names_limit: usize,
    report: &mut Value,
    out: &Path,
) -> Run {
    let id = pic.create_canister();
    pic.add_cycles(id, 1_000_000_000_000_000);
    pic.install_canister(id, wasm.to_vec(), Encode!(&owner).unwrap(), None);
    let diag = mode != 255;
    let names = stream_names(root, mode, names_limit);
    if diag {
        Decode!(
            &call(
                pic,
                id,
                owner,
                "memory_config",
                Encode!(&mode, &chunk, &names).unwrap()
            ),
            Result<()>
        )
        .unwrap()
        .unwrap();
    }
    Decode!(
        &call(pic, id, owner, "allow_caller", Encode!(&owner).unwrap()),
        Result<()>
    )
    .unwrap()
    .unwrap();
    let manifest = fs::read(root.join("models/verdict-pack/manifest.json")).unwrap();
    let mut bytes = fs::read(root.join("models/verdict-pack/model.bin")).unwrap();
    let tokenizer = fs::read(root.join("models/verdict-151m/tokenizer.json")).unwrap();
    Decode!(
        &call(
            pic,
            id,
            owner,
            "begin_upload",
            Encode!(&manifest, &(tokenizer.len() as u64), &special()).unwrap()
        ),
        Result<[u8; 32]>
    )
    .unwrap()
    .unwrap();
    bytes.extend(tokenizer);
    let started = Instant::now();
    for (i, part) in bytes.chunks(1024 * 1024).enumerate() {
        Decode!(
            &call(
                pic,
                id,
                owner,
                "upload_chunk",
                Encode!(&(i as u64 * 1024 * 1024), &part.to_vec()).unwrap()
            ),
            Result<u64>
        )
        .unwrap()
        .unwrap();
    }
    begin_run(
        report,
        name,
        json!({"mode":mode,"chunk":chunk,"stream_names":names,"wasm_sha256":hex(&hash(wasm)),"upload_seconds":started.elapsed().as_secs_f64(),"stages":[],"cases":[],"samples":[]}),
    );
    report["runs"][name]["stages"]
        .as_array_mut()
        .unwrap()
        .push(json!({"stage":"uploaded","stats":stats(pic,id,owner,diag)}));
    persist(out, report);
    let start = Instant::now();
    Decode!(
        &call(pic, id, owner, "start_warmup", Encode!().unwrap()),
        Result<u64>
    )
    .unwrap()
    .unwrap();
    report["runs"][name]["stages"]
        .as_array_mut()
        .unwrap()
        .push(json!({"stage":"tokenizer","stats":stats(pic,id,owner,diag)}));
    for tensor in 0..200 {
        let before = Instant::now();
        let done = Decode!(
            &call(pic, id, owner, "warmup_next", Encode!().unwrap()),
            Result<bool>
        )
        .unwrap()
        .unwrap();
        report["runs"][name]["stages"].as_array_mut().unwrap().push(json!({"stage":"warmup","tensor":tensor,"seconds":before.elapsed().as_secs_f64(),"stats":stats(pic,id,owner,diag)}));
        if done {
            break;
        }
    }
    report["runs"][name]["warmup_seconds"] = json!(start.elapsed().as_secs_f64());
    println!("WARM {name}: {}", stats(pic, id, owner, diag));
    persist(out, report);
    Run {
        name: name.into(),
        id,
        diag,
    }
}
fn bits(reply: &InferReply) -> Value {
    json!({"logit_bits":reply.logits.iter().map(|x|x.to_bits()).collect::<Vec<_>>(),"model_instructions":reply.measured_instructions,"model":hex(&reply.model),"tokens":reply.input_tokens})
}
fn forward(
    pic: &PocketIc,
    proxy: Principal,
    id: Principal,
    owner: Principal,
    method: &str,
    args: Vec<u8>,
) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend((id.as_slice().len() as u32).to_le_bytes());
    payload.extend((method.len() as u32).to_le_bytes());
    payload.extend(120_015_000_000u64.to_le_bytes());
    payload.extend(id.as_slice());
    payload.extend(method.as_bytes());
    payload.extend(args);
    call(pic, proxy, owner, "forward", payload)
}
fn regular(pic: &PocketIc, run: &Run, owner: Principal, proxy: Principal, case: &Value) -> Value {
    let ids: Vec<u32> = serde_json::from_value(case["ids"].clone()).unwrap();
    let raw = pic.query_call(run.id, owner, "infer_tokens_query", Encode!(&ids).unwrap());
    let result =
        raw.and_then(|b| Decode!(&b, Result<InferReply>).map_err(|e| panic!("decode: {e}")));
    let mut response = match result {
        Ok(Ok(r)) => {
            let mut v = bits(&r);
            v["query"] = json!("ok");
            v
        }
        Ok(Err(e)) => json!({"query":format!("application:{e:?}")}),
        Err(e) => json!({"query":format!("replica:{e:?}")}),
    };
    if response["query"] != "ok" {
        let bytes = forward(
            pic,
            proxy,
            run.id,
            owner,
            "infer_tokens",
            Encode!(&ids).unwrap(),
        );
        let reply = Decode!(&bytes, Result<InferReply>).unwrap().unwrap();
        let v = bits(&reply);
        for (k, v) in v.as_object().unwrap() {
            response[k] = v.clone();
        }
    }
    if let Some(req) = case.get("request") {
        let request = decision(req);
        let raw = pic.query_call(
            run.id,
            Principal::anonymous(),
            "decide_query",
            Encode!(&request).unwrap(),
        );
        let (status, reply) = match raw {
            Ok(bytes) => match Decode!(&bytes, Result<DecideReply>).unwrap() {
                Ok(r) => ("ok".to_string(), Some(r)),
                Err(e) => (format!("application:{e:?}"), None),
            },
            Err(e) => (format!("replica:{e:?}"), None),
        };
        response["decision_query"] = json!(status);
        if case["require_decision_query"] == true {
            assert_eq!(
                status, "ok",
                "required public query failed: {}",
                case["name"]
            );
        }
        let reply = reply.unwrap_or_else(|| {
            Decode!(
                &forward(
                    pic,
                    proxy,
                    run.id,
                    owner,
                    "decide",
                    Encode!(&request).unwrap()
                ),
                Result<DecideReply>
            )
            .unwrap()
            .unwrap()
        });
        response["decision"] = json!({"logit_bits":reply.logits.iter().map(|x|x.to_bits()).collect::<Vec<_>>(),"probability_bits":reply.probabilities.iter().map(|x|x.to_bits()).collect::<Vec<_>>(),"selected":reply.selected,"model_instructions":reply.measured_instructions,"tokens":reply.input_tokens});
    }
    response
}
fn diagnostic(
    pic: &PocketIc,
    run: &Run,
    owner: Principal,
    case: &Value,
    nonce: u64,
    detailed: bool,
) -> Value {
    let ids: Vec<u32> = serde_json::from_value(case["ids"].clone()).unwrap();
    let args = Encode!(&ids, &nonce, &detailed).unwrap();
    let start = Instant::now();
    let raw = pic.query_call(run.id, owner, "memory_probe", args.clone());
    let (bytes, path) = match raw {
        Ok(b) => (b, "query"),
        Err(_) => (
            call(pic, run.id, owner, "memory_probe_update", args),
            "update",
        ),
    };
    let encoded = Decode!(&bytes, Result<String>).unwrap().unwrap();
    let mut result: Value = serde_json::from_str(&encoded).unwrap();
    result["path"] = json!(path);
    result["wall_seconds"] = json!(start.elapsed().as_secs_f64());
    result
}
#[test]
#[ignore = "full real-checkpoint comparison; requires POCKET_IC_BIN and built baseline/bench Wasm"]
fn memory_comparison() {
    let root = root();
    let out = root.join(
        std::env::var("MEMORY_OUT").unwrap_or("artifacts/memory-optimization/screen.json".into()),
    );
    let previous: Option<Value> = if std::env::var_os("MEMORY_RESUME").is_some() && out.exists() {
        Some(serde_json::from_slice(&fs::read(&out).unwrap()).unwrap())
    } else {
        None
    };
    let repeats: usize = std::env::var("MEMORY_REPEATS")
        .unwrap_or("1".into())
        .parse()
        .unwrap();
    let modes=std::env::var("MEMORY_RUNS").unwrap_or("source:255:262144,legacy:0:262144,resident64:1:65536,resident256:1:262144,resident1024:1:1048576,embedding:2:262144,layer0:5:262144,matrices:3:262144,layers:4:262144".into());
    let mut cases = corpus(&root);
    if let Ok(prefix) = std::env::var("MEMORY_CASE_FILTER") {
        cases.retain(|c| c["name"].as_str().unwrap().starts_with(&prefix));
    }
    assert!(!cases.is_empty(), "measurement corpus must not be empty");
    let server = LocalServer::start();
    let pic = PocketIcBuilder::new()
        .with_server_url(server.url.parse().unwrap())
        .with_application_subnet()
        .build();
    let owner = Principal::self_authenticating(b"openjev-memory-local-owner");
    let proxy = pic.create_canister();
    pic.add_cycles(proxy, 10_000_000_000_000_000);
    pic.install_canister(
        proxy,
        wat::parse_str(include_str!("cycles_proxy.wat")).unwrap(),
        vec![],
        None,
    );
    let artifact_dir = root.join(
        std::env::var("MEMORY_ARTIFACT_DIR").unwrap_or("artifacts/memory-optimization".into()),
    );
    // Freeze every image before setup; the upgrade must use this same snapshot.
    let bench = fs::read(artifact_dir.join("bench.wasm")).unwrap();
    let baseline = fs::read(artifact_dir.join("baseline/source.wasm")).unwrap();
    let selected = if std::env::var_os("MEMORY_UPGRADE").is_some() {
        fs::read(artifact_dir.join("selected.wasm")).unwrap()
    } else {
        Vec::new()
    };
    let mut report = json!({"schema":1,"replica":"PocketIC application subnet, disposable local instances","timing_note":"Local execution plus PocketIC transport; not production latency","corpus":cases,"corpus_sha256":hex(&hash(&serde_json::to_vec(&cases).unwrap())),"runs":{}});
    report["artifact_hashes"] = json!({"bench.wasm":hex(&hash(&bench)),
        "baseline/source.wasm":hex(&hash(&baseline)),"selected.wasm":hex(&hash(&selected))});
    let mut hashes = serde_json::Map::new();
    for f in [
        "models/verdict-pack/model.bin",
        "models/verdict-pack/manifest.json",
        "models/verdict-151m/tokenizer.json",
        "artifacts/tetris-prompt-search/production-query-check.json",
    ] {
        hashes.insert(
            f.into(),
            json!(hex(&hash(&fs::read(root.join(f)).unwrap()))),
        );
    }
    report["input_hashes"] = json!(hashes);
    let mut sources = serde_json::Map::new();
    for f in [
        "Cargo.lock",
        "rust-toolchain.toml",
        "crates/modernbert-candle/src/lib.rs",
        "crates/modernbert-candle/src/weights.rs",
        "crates/verdict-candle/src/lib.rs",
        "crates/verdict-candle/src/pack.rs",
        "canisters/verdict-engine/src/lib.rs",
        "canisters/verdict-engine/src/memory.rs",
        "canisters/verdict-engine/tests/memory_optimization.rs",
        "tools/memory_compare.py",
    ] {
        sources.insert(
            f.into(),
            json!(hex(&hash(&fs::read(root.join(f)).unwrap()))),
        );
    }
    report["source_hashes"] = json!(sources);
    report["pocket_ic_version"] =
        json!("15.0.0; default application subnet execution configuration");
    // Validate every requested image and policy before any checkpoint is replaced.
    let configs:Vec<(String,Value)>=modes.split(',').map(|spec|{
        let parts:Vec<_>=spec.split(':').collect();let mode:u8=parts[1].parse().unwrap();
        let limit=parts.get(3).map(|x|x.parse().unwrap()).unwrap_or(usize::MAX);
        (parts[0].into(),json!({"mode":mode,"chunk":parts[2].parse::<u32>().unwrap(),"stream_names":stream_names(&root,mode,limit),"wasm_sha256":hex(&hash(if mode==255{&baseline}else{&bench}))}))
    }).collect();
    if let Some(old) = &previous {
        check_resume_configs(old, &configs);
        assert_eq!(
            old["artifact_hashes"], report["artifact_hashes"],
            "resume artifacts differ"
        );
        assert_eq!(
            old["corpus_sha256"], report["corpus_sha256"],
            "resume corpus differs"
        );
        assert_eq!(
            old["input_hashes"], report["input_hashes"],
            "resume model/tokenizer inputs differ"
        );
        report["runs"] = old["runs"].clone();
        report["resume_note"]=json!("Fresh canisters replay all setup and correctness cases; only matching-Wasm completed nonce samples are reused. Samples retain their session identity.");
    }
    let session = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    report["session_unix_seconds"] = json!(session);
    let mut runs = Vec::new();
    for mode in modes.split(',') {
        let parts: Vec<_> = mode.split(':').collect();
        let mode: u8 = parts[1].parse().unwrap();
        let run = setup(
            &pic,
            &root,
            owner,
            parts[0],
            mode,
            parts[2].parse().unwrap(),
            if mode == 255 { &baseline } else { &bench },
            parts
                .get(3)
                .map(|x| x.parse().unwrap())
                .unwrap_or(usize::MAX),
            &mut report,
            &out,
        );
        let pricing = ExecutionPricing {
            base_cycles: 5_000_000,
            instruction_cycles_numerator: 1,
            instruction_cycles_denominator: 1,
        };
        Decode!(
            &call(
                &pic,
                run.id,
                owner,
                "set_execution_pricing",
                Encode!(&Some(pricing)).unwrap()
            ),
            Result<()>
        )
        .unwrap()
        .unwrap();
        for (i, case) in cases.iter().enumerate() {
            if std::env::var_os("MEMORY_WARM_ONLY").is_some() {
                break;
            }
            let mut row =
                json!({"name":case["name"],"regular":regular(&pic,&run,owner,proxy,case)});
            if run.diag {
                row["diagnostic"] = diagnostic(&pic, &run, owner, case, i as u64, false);
                if std::env::var_os("MEMORY_EXTRA_DIAGNOSTICS").is_some() {
                    if let Some(req) = case.get("request") {
                        let ids = Decode!(
                            &query(
                                &pic,
                                run.id,
                                owner,
                                "memory_tokens",
                                Encode!(&decision(req)).unwrap()
                            ),
                            Result<Vec<u32>>
                        )
                        .unwrap()
                        .unwrap();
                        assert_eq!(json!(ids), case["ids"], "tokenization mismatch");
                        row["token_ids"] = json!(ids);
                    }
                    if [
                        "tokens-6-classes-1-spread",
                        "tokens-40-classes-1-spread",
                        "tokens-128-classes-1-spread",
                    ]
                    .contains(&case["name"].as_str().unwrap())
                    {
                        row["profile"] =
                            diagnostic(&pic, &run, owner, case, 100_000 + i as u64, true);
                    }
                }
            }
            report["runs"][&run.name]["cases"]
                .as_array_mut()
                .unwrap()
                .push(row);
            if i % 10 == 0 {
                println!("CASE {} {i}/{}", run.name, cases.len());
                persist(&out, &report);
            }
        }
        report["runs"][&run.name]["after_update"] = stats(&pic, run.id, owner, run.diag);
        persist(&out, &report);
        runs.push(run);
    }
    for run in &runs {
        report["runs"][&run.name]["stable_sha256_before_samples"] =
            json!(hex(&hash(&pic.get_stable_memory(run.id))));
    }
    persist(&out, &report);
    // Five calls per case in each of three rounds; reverse ordering each round.
    if repeats > 1 {
        assert_eq!(repeats, 15, "final comparison uses exactly 5 x 3 samples");
        for round in 0..3 {
            for (i, case) in cases.iter().enumerate() {
                for repeat in 0..5 {
                    let order: Vec<_> = if (round + i) % 2 == 0 {
                        (0..runs.len()).collect()
                    } else {
                        (0..runs.len()).rev().collect()
                    };
                    for idx in order {
                        let run = &runs[idx];
                        if !run.diag {
                            continue;
                        }
                        if report["runs"][&run.name]["samples"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|s| {
                                s["name"] == case["name"]
                                    && s["round"] == json!(round)
                                    && s["repeat"] == json!(repeat)
                            })
                        {
                            continue;
                        }
                        let nonce = 1_000_000 + (round * cases.len() * 5 + i * 5 + repeat) as u64;
                        let data = diagnostic(&pic, run, owner, case, nonce, false);
                        report["runs"][&run.name]["samples"].as_array_mut().unwrap().push(json!({"name":case["name"],"round":round,"repeat":repeat,"session_unix_seconds":session,"result":data}));
                    }
                }
                persist(&out, &report);
                if i % 10 == 0 {
                    println!("SAMPLE round={round} case={i}");
                }
            }
        }
    }
    for run in &runs {
        let after = hex(&hash(&pic.get_stable_memory(run.id)));
        assert_eq!(
            json!(after),
            report["runs"][&run.name]["stable_sha256_before_samples"],
            "stable state changed during inference"
        );
        report["runs"][&run.name]["stable_sha256_after_samples"] = json!(after);
        report["runs"][&run.name]["after_samples"] = stats(&pic, run.id, owner, run.diag);
    }
    persist(&out, &report);
    if std::env::var_os("MEMORY_UPGRADE").is_some() {
        let run = runs
            .iter()
            .find(|r| !r.diag)
            .expect("upgrade needs the source baseline canister");
        let outsider = Principal::self_authenticating(b"memory-registered-client");
        Decode!(
            &call(
                &pic,
                run.id,
                owner,
                "allow_caller",
                Encode!(&outsider).unwrap()
            ),
            Result<()>
        )
        .unwrap()
        .unwrap();
        let before = Decode!(
            &query(&pic, run.id, owner, "info", Encode!().unwrap()),
            EngineInfo
        )
        .unwrap();
        let pricing = query(&pic, run.id, owner, "cycles_pricing", Encode!().unwrap());
        let controllers = pic.get_controllers(run.id);
        let old_memory = pic.get_stable_memory(run.id);
        let blob_hash = hash(&old_memory[canister_common::BLOB_BASE as usize..]);
        drop(old_memory);
        pic.upgrade_canister(run.id, selected.clone(), Encode!().unwrap(), None)
            .unwrap();
        let after = Decode!(
            &query(&pic, run.id, owner, "info", Encode!().unwrap()),
            EngineInfo
        )
        .unwrap();
        assert!(!after.warmed);
        assert_eq!(before.model, after.model);
        assert_eq!(before.callers, after.callers);
        assert_eq!(
            (
                before.cost_fixed,
                before.cost_per_token,
                before.budget,
                before.max_input_tokens
            ),
            (
                after.cost_fixed,
                after.cost_per_token,
                after.budget,
                after.max_input_tokens
            )
        );
        assert_eq!(
            pricing,
            query(&pic, run.id, owner, "cycles_pricing", Encode!().unwrap())
        );
        assert_eq!(controllers, pic.get_controllers(run.id));
        let denied = Decode!(
            &call(
                &pic,
                run.id,
                outsider,
                "set_cost_model",
                Encode!(&1u64, &1u64, &40_000_000_000u64).unwrap()
            ),
            Result<()>
        )
        .unwrap();
        assert_eq!(denied, Err(ic_laya_core::Error::Unauthorized));
        Decode!(
            &call(&pic, run.id, owner, "start_warmup", Encode!().unwrap()),
            Result<u64>
        )
        .unwrap()
        .unwrap();
        let mut stages = Vec::new();
        let mut warmed = false;
        for tensor in 0..200 {
            let done = Decode!(
                &call(&pic, run.id, owner, "warmup_next", Encode!().unwrap()),
                Result<bool>
            )
            .unwrap()
            .unwrap();
            stages.push(json!({"tensor":tensor,"stats":stats(&pic,run.id,owner,false)}));
            if done {
                warmed = true;
                break;
            }
        }
        assert!(warmed);
        assert_eq!(
            blob_hash,
            hash(&pic.get_stable_memory(run.id)[canister_common::BLOB_BASE as usize..])
        );
        let mut rows = Vec::new();
        let mut worst = 0f64;
        for (i, case) in cases.iter().enumerate() {
            let observed = regular(&pic, run, owner, proxy, case);
            let expected = &report["runs"][&run.name]["cases"][i]["regular"];
            assert_eq!(observed["logit_bits"], expected["logit_bits"]);
            if let Some(prior) = expected.get("decision") {
                for field in ["logit_bits", "probability_bits", "selected", "tokens"] {
                    assert_eq!(observed["decision"][field], prior[field]);
                }
            }
            if expected["decision_query"] == "ok" {
                assert_eq!(observed["decision_query"], "ok");
            }
            if expected["query"] == "ok" {
                assert_eq!(observed["query"], "ok");
            }
            let ratio = observed["model_instructions"].as_u64().unwrap() as f64
                / expected["model_instructions"].as_u64().unwrap() as f64;
            worst = worst.max(ratio - 1.0);
            assert!(
                ratio <= 1.05,
                "normal build instruction gate failed: {} {ratio}",
                case["name"]
            );
            if let Some(prior) = expected.get("decision") {
                assert!(
                    observed["decision"]["model_instructions"].as_u64().unwrap() as f64
                        <= prior["model_instructions"].as_u64().unwrap() as f64 * 1.05
                );
            }
            rows.push(json!({"name":case["name"],"regular":observed}));
            if i % 10 == 0 {
                println!("UPGRADE case={i}/{}", cases.len());
            }
        }
        let ids: Vec<u32> = serde_json::from_value(cases[0]["ids"].clone()).unwrap();
        Decode!(
            &query(
                &pic,
                run.id,
                outsider,
                "infer_tokens_query",
                Encode!(&ids).unwrap()
            ),
            Result<InferReply>
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            Decode!(
                &query(
                    &pic,
                    run.id,
                    Principal::anonymous(),
                    "infer_tokens_query",
                    Encode!(&ids).unwrap()
                ),
                Result<InferReply>
            )
            .unwrap()
            .err(),
            Some(ic_laya_core::Error::Unauthorized)
        );
        report["upgrade"] = json!({"passed":true,"candidate":"selected","wasm_sha256":hex(&hash(&selected)),"blob_sha256_before_after":hex(&blob_hash),"owner_and_callers_preserved":true,"pricing_and_cost_guard_preserved":true,"controllers_preserved":true,"no_reupload":true,"stages":stages,"cases":rows,"worst_instruction_increase_percent":worst*100.0,"after_update":stats(&pic,run.id,owner,false)});
    }
    persist(&out, &report);
    println!("REPORT {}", out.display());
}

#[test]
fn replay_checkpoint_preserves_all_completed_samples() {
    let prior = json!({"wasm_sha256":"fixed","mode":7,"chunk":1048576,"stream_names":["a"],"samples":[{"nonce":123}],"stages":["old"]});
    let mut report = json!({"runs":{"first":prior.clone(),"second":prior.clone()}});
    let mut fresh = prior.clone();
    fresh["samples"] = json!([]);
    fresh["stages"] = json!([]);
    begin_run(&mut report, "first", fresh);
    assert_eq!(report["runs"]["first"]["samples"], prior["samples"]);
    assert_eq!(report["runs"]["second"]["samples"], prior["samples"]);
    let dir = std::env::temp_dir().join(format!("openjev-checkpoint-test-{}", std::process::id()));
    let path = dir.join("checkpoint.json");
    persist(&path, &json!({"old":true}));
    persist(&path, &report);
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&path).unwrap()).unwrap(),
        report
    );
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    fs::remove_dir_all(dir).unwrap();
}
#[test]
#[should_panic(expected = "resume configuration differs")]
fn replay_rejects_a_different_policy_before_replacing_evidence() {
    let prior =
        json!({"wasm_sha256":"fixed","mode":7,"chunk":1048576,"stream_names":["a"],"samples":[1]});
    let mut report = json!({"runs":{"first":prior.clone()}});
    let mut fresh = prior;
    fresh["chunk"] = json!(65536);
    begin_run(&mut report, "first", fresh);
}

#[test]
fn replay_preflights_later_runs_before_any_output_is_changed() {
    let config = json!({"wasm_sha256":"original","mode":7,"chunk":1048576,"stream_names":["a"]});
    let report = json!({"runs":{"first":config.clone(),"second":config.clone()}});
    let mut bad = config.clone();
    bad["wasm_sha256"] = json!("rebuilt");
    let configs = vec![("first".to_owned(), config), ("second".to_owned(), bad)];
    assert!(std::panic::catch_unwind(|| check_resume_configs(&report, &configs)).is_err());
    assert_eq!(report["runs"]["second"]["wasm_sha256"], "original");
}

#[test]
#[should_panic(expected = "resume omitted previous run")]
fn replay_cannot_silently_keep_an_unrequested_old_variant() {
    let config = json!({"wasm_sha256":"fixed","mode":7,"chunk":1048576,"stream_names":[]});
    let previous = json!({"runs":{"first":config.clone(),"second":config.clone()}});
    check_resume_configs(&previous, &[("first".into(), config)]);
}

#[test]
#[ignore = "requires local model/tokenizer and recorded production Tetris fixtures"]
fn production_requests_exercise_public_decision_query() {
    let cases = corpus(&root());
    let witnesses: Vec<_> = cases
        .iter()
        .filter(|c| c["require_decision_query"] == true)
        .collect();
    assert_eq!(witnesses.len(), 3);
    assert_eq!(
        cases.iter().filter(|c| c.get("request").is_some()).count(),
        35
    );
    for case in witnesses {
        assert!(!decision(&case["request"]).abstention);
        assert!(case["ids"].as_array().unwrap().len() <= 52);
    }
}
