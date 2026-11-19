//! Offline end-to-end IT routing with the exact canister classifier math.
use std::{
    io::{self, BufRead, Write},
    path::Path,
};
use ticketing_candle::{pack, Tokenizer};
use ticketing_runtime::it_routing::Head;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let dir = Path::new(
        args.first()
            .ok_or("usage: it-routing-infer PACK HEAD.json")?,
    );
    let base = ic_laya_core::hash(&std::fs::read(dir.join("manifest.json"))?);
    let head = Head::parse(
        &std::fs::read(args.get(1).ok_or("HEAD.json missing")?)?,
        base,
    )?;
    let model = pack::load_directory(dir, false)?;
    let manifest = pack::Manifest::parse(&std::fs::read(dir.join("manifest.json"))?, false)?;
    let bytes = std::fs::read(dir.join("tokenizer.json"))?;
    if ic_laya_core::hash(&bytes) != manifest.tokenizer_sha256 {
        return Err("tokenizer mismatch".into());
    }
    let tokenizer = Tokenizer::new(&bytes)?;
    let mut out = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let v: serde_json::Value = serde_json::from_str(&line?)?;
        let result = (|| -> ic_laya_core::Result<_> {
            let ids = tokenizer.encode(v["text"].as_str().unwrap_or(""))?;
            if ids.len() > 64 {
                return Err(ic_laya_core::Error::TooLong);
            }
            let start = std::time::Instant::now();
            let features = model.features(&ids)?;
            Ok(
                serde_json::json!({"ids":ids,"result":head.predict(&features)?,"elapsed_ms":start.elapsed().as_secs_f64()*1000.}),
            )
        })();
        let row = match result {
            Ok(v) => v,
            Err(e) => serde_json::json!({"error":e.to_string()}),
        };
        writeln!(out, "{row}")?;
        out.flush()?;
    }
    Ok(())
}
