use std::{
    io::{self, BufRead, Write},
    path::Path,
};
use ticketing_candle::{pack, Tokenizer};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let dir = Path::new(
        args.first()
            .ok_or("usage: ticketing-infer PACK [--reference-f32] [--features]")?,
    );
    let allow = args.iter().skip(1).any(|s| s == "--reference-f32");
    let features = args.iter().skip(1).any(|s| s == "--features");
    let model = pack::load_directory(dir, allow)?;
    let manifest = pack::Manifest::parse(&std::fs::read(dir.join("manifest.json"))?, allow)?;
    let bytes = std::fs::read(dir.join("tokenizer.json"))?;
    if ic_laya_core::hash(&bytes) != manifest.tokenizer_sha256 {
        return Err("tokenizer digest mismatch".into());
    }
    let tok = Tokenizer::new(&bytes)?;
    let mut out = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let v: serde_json::Value = serde_json::from_str(&line?)?;
        let result = (|| -> ic_laya_core::Result<_> {
            let ids = tok.encode(v["text"].as_str().unwrap_or(""))?;
            let start = std::time::Instant::now();
            if features {
                let values = model.features(&ids)?;
                return Ok(serde_json::json!({"ids":ids,"features":values}));
            }
            let (d, p) = model.logits(&ids)?;
            Ok(
                serde_json::json!({"ids":ids,"department":d,"priority":p,"elapsed_ms":start.elapsed().as_secs_f64()*1000.}),
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
