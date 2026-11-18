//! Local-only full-length probe for comparison with the deployed generic query.
//! Uses the same pack, tokenizer and checked prompt; does not apply the 5B query budget.
use std::io::{self, BufRead, Write};
use std::path::Path;
use hf_tokenizer::HfTokenizer;
use ic_laya_core::engine::InferenceBackend;
use ic_laya_core::{schema::TextTokenizer, SpecialTokens};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct OptionSpec { id: String, text: String }
#[derive(Deserialize)]
struct Request { state: String, question: String, options: Vec<OptionSpec>, temperature: f32, abstention: bool }

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::args().nth(1).unwrap_or_else(|| ".".into());
    let root = Path::new(&root);
    let tokenizer = HfTokenizer::from_bytes(
        &std::fs::read(root.join("models/verdict-151m/tokenizer.json"))?,
        SpecialTokens { cls: 50281, sep: 50282, mask: 50284, pad: 50283,
            literals: vec!["[CLS]".into(), "[SEP]".into(), "[MASK]".into(), "[PAD]".into()] },
    ).map_err(|e| format!("tokenizer: {e:?}"))?;
    let model = verdict_candle::pack::load_directory(&root.join("models/verdict-pack"))
        .map_err(|e| format!("model: {e:?}"))?;
    for line in io::stdin().lock().lines() {
        let request: Request = serde_json::from_str(&line?)?;
        if request.abstention || request.options.is_empty() || request.options.len() > 24
            || !request.temperature.is_finite() || request.temperature <= 0.0 {
            return Err("unsupported request".into());
        }
        let started = std::time::Instant::now();
        let labels: Vec<String> = request.options.iter().map(|o| o.text.clone()).collect();
        let prompt = verdict_candle::render_prompt_checked(&request.question, &request.state, &labels, &tokenizer.special_tokens())
            .map_err(|e| format!("prompt: {e:?}"))?;
        let mut tokens = vec![50281];
        tokens.extend(tokenizer.encode_piece(&prompt).map_err(|e| format!("tokens: {e:?}"))?);
        tokens.push(50282);
        if tokens.len() > 128 { return Err("comparison input exceeds 128 tokens; refusing truncation".into()); }
        let logits = model.logits(&tokens).map_err(|e| format!("inference: {e:?}"))?;
        if logits.len() != labels.len() { return Err("class count mismatch".into()); }
        let scaled: Vec<f32> = logits.iter().map(|value| value / request.temperature).collect();
        let maximum = scaled.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        let weights: Vec<f32> = scaled.iter().map(|value| (value - maximum).exp()).collect();
        let sum: f32 = weights.iter().sum();
        let probabilities: Vec<f32> = weights.iter().map(|value| value / sum).collect();
        let best = probabilities.iter().enumerate().fold((0usize, f32::NEG_INFINITY), |a, (i, p)| if *p > a.1 { (i, *p) } else { a });
        let ids: Vec<String> = request.options.iter().map(|option| option.id.clone()).collect();
        println!("{}", json!({ "ids": ids, "selected": request.options[best.0].id, "probabilities": probabilities,
            "logits": logits, "input_tokens": tokens.len(), "model": model.bundle_id(),
            "native_milliseconds": started.elapsed().as_secs_f64() * 1000.0 }));
        io::stdout().flush()?;
    }
    Ok(())
}
