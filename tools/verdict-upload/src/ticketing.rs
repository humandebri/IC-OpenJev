//! Default is offline validation. Remote mutation requires --upload or --warm-only.
use candid::{CandidType, Decode, Encode, Principal};
mod signing;
use ic_agent::Agent;
use ic_laya_core::{hash, hex, Digest, Error};
use serde::Deserialize;
use std::{
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
};
use ticketing_candle::pack::Manifest;
use ticketing_runtime::{Info, QueryLimits, Reply};
type Result<T> = std::result::Result<T, String>;
#[derive(Default)]
struct Args {
    pack: PathBuf,
    url: Option<String>,
    canister: Option<String>,
    pem: Option<PathBuf>,
    expected_legacy: Option<Digest>,
    upload: bool,
    warm_only: bool,
    resume: bool,
    accept_label_drift: bool,
    max_tokens: Option<u32>,
}
fn digest(s: &str) -> Result<Digest> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() != 64 || !s.is_ascii() {
        return Err("digest must contain 64 hex digits".into());
    }
    let mut d = [0; 32];
    for (i, b) in d.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).map_err(|_| "invalid digest")?;
    }
    Ok(d)
}
fn args() -> Result<Args> {
    let mut a = Args::default();
    let mut input = std::env::args().skip(1);
    let mut pack = None;
    let mut check_only = false;
    while let Some(flag) = input.next() {
        match flag.as_str() {
            "--upload" => a.upload = true,
            "--warm-only" => a.warm_only = true,
            "--resume" => a.resume = true,
            "--accept-label-drift" => a.accept_label_drift = true,
            "--check-only" => check_only = true,
            "--pack" => pack = Some(PathBuf::from(input.next().ok_or("--pack value missing")?)),
            "--url" => a.url = Some(input.next().ok_or("--url value missing")?),
            "--canister" => a.canister = Some(input.next().ok_or("--canister value missing")?),
            "--pem" => a.pem = Some(input.next().ok_or("--pem value missing")?.into()),
            "--expected-legacy-model" => {
                a.expected_legacy = Some(digest(&input.next().ok_or("legacy digest missing")?)?)
            }
            "--max-tokens" => {
                a.max_tokens = Some(
                    input
                        .next()
                        .ok_or("token limit missing")?
                        .parse()
                        .map_err(|_| "invalid token limit")?,
                )
            }
            _ => return Err(format!("unknown argument: {flag}")),
        }
    }
    a.pack=pack.ok_or("usage: ticketing-upload --pack DIR [--check-only | --upload | --warm-only]; remote modes require --url --canister --pem --expected-legacy-model --accept-label-drift")?;
    if a.upload && a.warm_only {
        return Err("choose --upload or --warm-only".into());
    }
    if check_only && (a.upload || a.warm_only) {
        return Err("--check-only cannot be combined with a remote operation".into());
    }
    if a.resume && !a.upload {
        return Err("--resume requires --upload".into());
    }
    if a.max_tokens.is_some_and(|n| !(3..=128).contains(&n)) {
        return Err("--max-tokens must be 3..128".into());
    }
    Ok(a)
}
fn validate(a: &Args) -> Result<(Vec<u8>, Manifest, Vec<u8>)> {
    let raw = std::fs::read(a.pack.join("manifest.json")).map_err(|e| e.to_string())?;
    let m = Manifest::parse(&raw, false).map_err(|e| e.to_string())?;
    let tok = std::fs::read(a.pack.join("tokenizer.json")).map_err(|e| e.to_string())?;
    if hash(&tok) != m.tokenizer_sha256 {
        return Err("tokenizer hash mismatch".into());
    }
    let mut f = std::fs::File::open(a.pack.join("model.bin")).map_err(|e| e.to_string())?;
    if f.metadata().map_err(|e| e.to_string())?.len() != m.total_bytes {
        return Err("model length mismatch".into());
    }
    for e in &m.tensors {
        let mut bytes = vec![0; e.length as usize];
        f.read_exact(&mut bytes).map_err(|e| e.to_string())?;
        if hash(&bytes) != e.sha256 {
            return Err(format!("tensor hash mismatch: {}", e.name));
        }
    }
    Ok((raw, m, tok))
}
async fn update<T: CandidType + for<'a> Deserialize<'a>>(
    agent: &Agent,
    id: Principal,
    method: &str,
    args: Vec<u8>,
) -> Result<T> {
    let raw = agent
        .update(&id, method)
        .with_arg(args)
        .call_and_wait()
        .await
        .map_err(|e| format!("{method}: {e}"))?;
    Decode!(&raw,std::result::Result<T,Error>)
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{method}: {e}"))
}
async fn query<T: CandidType + for<'a> Deserialize<'a>>(
    agent: &Agent,
    id: Principal,
    method: &str,
) -> Result<T> {
    let raw = agent
        .query(&id, method)
        .with_arg(Encode!().map_err(|e| e.to_string())?)
        .call()
        .await
        .map_err(|e| format!("{method}: {e}"))?;
    Decode!(&raw, T).map_err(|e| e.to_string())
}
#[derive(CandidType, Deserialize)]
struct LegacyInfo {
    model: Digest,
    warmed: bool,
}
async fn check_legacy(agent: &Agent, id: Principal, expected: Digest) -> Result<()> {
    let i: LegacyInfo = query(agent, id, "info").await?;
    if i.model != expected || !i.warmed {
        return Err("legacy model differs or is not warm; aborting Japanese operation".into());
    }
    Ok(())
}
async fn run(a: Args) -> Result<()> {
    let (manifest, m, tok) = validate(&a)?;
    println!(
        "{}",
        serde_json::json!({"offline_validation":"passed","manifest_sha256":hex(&hash(&manifest)),"checkpoint_sha256":hex(&m.checkpoint_sha256),"model_bytes":m.total_bytes,"tokenizer_bytes":tok.len(),"mode":if a.upload{"upload"}else if a.warm_only{"warm-only"}else{"check-only"}})
    );
    if !a.upload && !a.warm_only {
        return Ok(());
    }
    if !a.accept_label_drift {
        return Err("remote mode requires --accept-label-drift: the INT8 pilot changes one department prediction".into());
    }
    let expected = a
        .expected_legacy
        .ok_or("--expected-legacy-model is required")?;
    let url = a.url.ok_or("--url is required")?;
    let local = url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:");
    if !local && !url.starts_with("https://") {
        return Err("remote endpoint requires HTTPS".into());
    }
    let identity = signing::from_pem_file(a.pem.ok_or("--pem is required")?)?;
    let agent = Agent::builder()
        .with_url(url)
        .with_boxed_identity(identity)
        .build()
        .map_err(|e| e.to_string())?;
    if local {
        agent.fetch_root_key().await.map_err(|e| e.to_string())?;
    }
    let id = Principal::from_text(a.canister.ok_or("--canister is required")?)
        .map_err(|e| e.to_string())?;
    check_legacy(&agent, id, expected).await?;
    let before: Info = query(&agent, id, "ticketing_info").await?;
    let bundle = hash(&manifest);
    let total = m.total_bytes + tok.len() as u64;
    let mut offset = 0;
    if a.warm_only || a.resume {
        if before.model != bundle || before.received > total {
            return Err("existing Japanese upload does not match this pack".into());
        }
        offset = before.received;
    }
    if a.upload {
        if !a.resume {
            let returned = update::<Digest>(
                &agent,
                id,
                "ticketing_begin_upload",
                Encode!(&manifest, &(tok.len() as u64)).map_err(|e| e.to_string())?,
            )
            .await?;
            if returned != bundle {
                return Err("manifest binding mismatch".into());
            }
        }
        let mut model = std::fs::File::open(a.pack.join("model.bin")).map_err(|e| e.to_string())?;
        while offset < total {
            let remaining = if offset < m.total_bytes {
                m.total_bytes - offset
            } else {
                total - offset
            };
            let n = remaining.min(1024 * 1024) as usize;
            let mut bytes = vec![0; n];
            if offset < m.total_bytes {
                model
                    .seek(SeekFrom::Start(offset))
                    .and_then(|_| model.read_exact(&mut bytes))
                    .map_err(|e| e.to_string())?;
            } else {
                let start = (offset - m.total_bytes) as usize;
                bytes.copy_from_slice(&tok[start..start + n]);
            }
            let next = update::<u64>(
                &agent,
                id,
                "ticketing_upload_chunk",
                Encode!(&offset, &bytes).map_err(|e| e.to_string())?,
            )
            .await?;
            if next != offset + n as u64 {
                return Err("unexpected upload acknowledgement".into());
            }
            offset = next;
            if offset % (16 * 1024 * 1024) == 0 || offset == total {
                eprintln!("Japanese upload {offset}/{total}");
            }
        }
    }
    if offset != total {
        return Err("Japanese upload is incomplete".into());
    }
    check_legacy(&agent, id, expected).await?;
    let count = update::<u32>(
        &agent,
        id,
        "ticketing_start_warmup",
        Encode!().map_err(|e| e.to_string())?,
    )
    .await?;
    for i in 0..count {
        let done = update::<bool>(
            &agent,
            id,
            "ticketing_warmup_next",
            Encode!().map_err(|e| e.to_string())?,
        )
        .await?;
        if done != (i + 1 == count) {
            return Err("unexpected warmup progress".into());
        }
        if i % 20 == 0 {
            eprintln!("Japanese warmup {i}/{count}");
        }
    }
    // Re-measure on the installed Wasm. Never install a local-only token limit blindly.
    let mut limit = 0;
    for n in 3..=a.max_tokens.unwrap_or(128) {
        let text = if n == 3 {
            "x".into()
        } else {
            "x ".repeat(n as usize - 3)
        };
        let r = update::<Reply>(
            &agent,
            id,
            "ticketing_benchmark",
            Encode!(&text).map_err(|e| e.to_string())?,
        )
        .await?;
        if r.model != bundle || r.input_tokens != n {
            return Err("calibration model or token count changed".into());
        }
        if r.measured_instructions > 4_500_000_000 {
            break;
        }
        limit = n;
    }
    if limit < 3 {
        return Err("no calibrated query capacity".into());
    }
    update::<()>(
        &agent,
        id,
        "ticketing_set_query_limit",
        Encode!(&limit).map_err(|e| e.to_string())?,
    )
    .await?;
    check_legacy(&agent, id, expected).await?;
    let info: Info = query(&agent, id, "ticketing_info").await?;
    let limits: QueryLimits = query(&agent, id, "ticketing_query_limits").await?;
    if !info.ready || info.model != bundle || limits.max_tokens != limit {
        return Err("Japanese postflight mismatch".into());
    }
    println!(
        "{}",
        serde_json::json!({"state":"ready","ticketing":info,"limits":limits,"legacy_model_preserved":hex(&expected)})
    );
    Ok(())
}
#[tokio::main]
async fn main() {
    let result = match args() {
        Ok(a) => run(a).await,
        Err(e) => Err(e),
    };
    if let Err(e) = result {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_model_digest_requires_exact_bytes() {
        let d = digest(&"ab".repeat(32)).unwrap();
        assert_eq!(d, [171; 32]);
        assert!(digest("ab").is_err());
        assert!(digest(&"zz".repeat(32)).is_err());
    }
}
