//! Fixed ModernBERT-Ja-130M encoder with the two pilot classification heads.
//! FP32 packs are an offline parity reference only; canisters accept INT8 packs.
#![forbid(unsafe_code)]
pub mod pack;
use candle_core::{Device, Tensor};
use ic_laya_core::{Error, Result};
use modernbert_candle::{Attention, EncoderLayer, Linear, Norm, QuantEmbedding, QuantWeight};
use std::collections::BTreeMap;

pub const DEPARTMENTS: [&str; 4] = ["it", "hr", "finance", "admin"];
pub const PRIORITIES: [&str; 3] = ["low", "normal", "high"];
pub const MAX_TOKENS: usize = 128;
pub const MAX_TEXT_BYTES: usize = 8192;
pub fn model_error(e: impl std::fmt::Display) -> Error {
    Error::ModelUnavailable(e.to_string())
}
type Tensors = BTreeMap<String, Tensor>;
type Quant = BTreeMap<String, QuantWeight>;

/// Exact architecture and source names of the frozen HF checkpoint.
pub fn expected_tensors() -> BTreeMap<String, Vec<usize>> {
    let mut m = BTreeMap::from([
        (
            "encoder.embeddings.tok_embeddings.weight".into(),
            vec![102400, 512],
        ),
        ("encoder.embeddings.norm.weight".into(), vec![512]),
        ("encoder.final_norm.weight".into(), vec![512]),
        ("department.weight".into(), vec![4, 512]),
        ("department.bias".into(), vec![4]),
        ("priority.weight".into(), vec![3, 512]),
        ("priority.bias".into(), vec![3]),
    ]);
    for i in 0..19 {
        let p = format!("encoder.layers.{i}");
        if i > 0 {
            m.insert(format!("{p}.attn_norm.weight"), vec![512]);
        }
        for (name, shape) in [
            ("attn.Wqkv.weight", vec![1536, 512]),
            ("attn.Wo.weight", vec![512, 512]),
            ("mlp_norm.weight", vec![512]),
            ("mlp.Wi.weight", vec![4096, 512]),
            ("mlp.Wo.weight", vec![512, 2048]),
        ] {
            m.insert(format!("{p}.{name}"), shape);
        }
    }
    m
}
pub fn quantized_name(name: &str, shape: &[usize]) -> bool {
    name.starts_with("encoder.") && shape.len() == 2
}
fn take(m: &mut Tensors, name: &str) -> Result<Tensor> {
    m.remove(name)
        .ok_or_else(|| Error::Invalid(format!("missing tensor: {name}")))
}
fn norm(m: &mut Tensors, p: &str) -> Result<Norm> {
    Ok(Norm::new(take(m, &format!("{p}.weight"))?, None, 1e-5))
}
fn linear(m: &mut Tensors, q: &mut Quant, p: &str, biased: bool) -> Result<Linear> {
    let key = format!("{p}.weight");
    let bias = if biased {
        Some(take(m, &format!("{p}.bias"))?)
    } else {
        None
    };
    if let Some(w) = q.remove(&key) {
        return Ok(Linear::new_quantized(w, bias));
    }
    Ok(Linear::new_transposed(
        take(m, &key)?
            .t()
            .and_then(|t| t.contiguous())
            .map_err(model_error)?,
        bias,
    ))
}
enum Embedding {
    F32(Tensor),
    Int8(QuantEmbedding),
}
pub struct Model {
    embedding: Embedding,
    embedding_norm: Norm,
    layers: Vec<EncoderLayer>,
    final_norm: Norm,
    department: Linear,
    priority: Linear,
}
impl Model {
    pub(crate) fn assemble(mut m: Tensors, mut q: Quant) -> Result<Self> {
        let embedding_name = "encoder.embeddings.tok_embeddings.weight";
        let embedding = if let Some(w) = q.remove(embedding_name) {
            Embedding::Int8(QuantEmbedding::from_weight(w).map_err(model_error)?)
        } else {
            Embedding::F32(take(&mut m, embedding_name)?)
        };
        let embedding_norm = norm(&mut m, "encoder.embeddings.norm")?;
        let final_norm = norm(&mut m, "encoder.final_norm")?;
        let mut layers = Vec::new();
        for i in 0..19 {
            let p = format!("encoder.layers.{i}");
            let local = i % 3 != 0;
            layers.push(EncoderLayer::new(
                if i > 0 {
                    Some(norm(&mut m, &format!("{p}.attn_norm"))?)
                } else {
                    None
                },
                Attention::new(
                    linear(&mut m, &mut q, &format!("{p}.attn.Wqkv"), false)?,
                    linear(&mut m, &mut q, &format!("{p}.attn.Wo"), false)?,
                    8,
                ),
                norm(&mut m, &format!("{p}.mlp_norm"))?,
                linear(&mut m, &mut q, &format!("{p}.mlp.Wi"), false)?,
                linear(&mut m, &mut q, &format!("{p}.mlp.Wo"), false)?,
                if local { 10000. } else { 160000. },
                if local { Some(64) } else { None },
            ));
        }
        let department = linear(&mut m, &mut q, "department", true)?;
        let priority = linear(&mut m, &mut q, "priority", true)?;
        if !m.is_empty() || !q.is_empty() {
            return Err(Error::Invalid("unused tensors".into()));
        }
        Ok(Self {
            embedding,
            embedding_norm,
            layers,
            final_norm,
            department,
            priority,
        })
    }
    pub fn logits(&self, ids: &[u32]) -> Result<(Vec<f32>, Vec<f32>)> {
        if !(2..=MAX_TOKENS).contains(&ids.len())
            || ids[0] != 1
            || ids[ids.len() - 1] != 2
            || ids.iter().any(|&x| x >= 102400)
        {
            return Err(Error::TooLong);
        }
        modernbert_candle::weights::begin_forward();
        let run = || -> candle_core::Result<_> {
            let embedded = match &self.embedding {
                Embedding::Int8(q) => q.lookup(ids)?,
                Embedding::F32(t) => t.index_select(&Tensor::new(ids, &Device::Cpu)?, 0)?,
            };
            let mut x = self.embedding_norm.forward(&embedded)?;
            let tables = modernbert_candle::rope_tables(&self.layers, ids.len(), 512, &mut |_| {})?;
            let masks = modernbert_candle::attention_masks(&self.layers, ids.len())?;
            for layer in &self.layers {
                x = layer.forward_cached(
                    &x,
                    modernbert_candle::table_for(&tables, layer.theta()),
                    layer.distance().and_then(|d| masks.get(&d)),
                    &mut |_| {},
                )?;
            }
            let first = self.final_norm.forward(&x)?.narrow(0, 0, 1)?;
            let d = self
                .department
                .forward(&first)?
                .flatten_all()?
                .to_vec1::<f32>()?;
            let p = self
                .priority
                .forward(&first)?
                .flatten_all()?
                .to_vec1::<f32>()?;
            Ok((d, p))
        };
        let (d, p) = run().map_err(model_error)?;
        if d.iter().chain(&p).any(|x| !x.is_finite()) {
            return Err(Error::Numeric);
        }
        Ok((d, p))
    }
}

pub struct Tokenizer(tokenizers::Tokenizer);
impl Tokenizer {
    pub fn new(bytes: &[u8]) -> Result<Self> {
        if bytes.is_empty() || bytes.len() > 32 * 1024 * 1024 {
            return Err(Error::TooLong);
        }
        tokenizers::utils::parallelism::set_parallelism(false);
        let mut t = tokenizers::Tokenizer::from_bytes(bytes).map_err(model_error)?;
        t.with_truncation(None).map_err(model_error)?;
        t.with_padding(None);
        if t.get_vocab_size(true) != 102400
            || t.token_to_id("<s>") != Some(1)
            || t.token_to_id("</s>") != Some(2)
        {
            return Err(Error::Invalid("Japanese tokenizer binding".into()));
        }
        Ok(Self(t))
    }
    pub fn encode(&self, text: &str) -> Result<Vec<u32>> {
        if text.trim().is_empty() || text.len() > MAX_TEXT_BYTES {
            return Err(Error::TooLong);
        }
        let ids = self
            .0
            .encode(text, true)
            .map_err(model_error)?
            .get_ids()
            .to_vec();
        if ids.len() > MAX_TOKENS || ids.first() != Some(&1) || ids.last() != Some(&2) {
            return Err(Error::TooLong);
        }
        Ok(ids)
    }
}
