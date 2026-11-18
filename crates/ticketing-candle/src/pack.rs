//! Content-addressed, bounded, sequential pack loading shared by native and Wasm.
use crate::{expected_tensors, model_error, quantized_name, Model, Quant, Tensors};
use candle_core::{DType, Device, Tensor};
use ic_laya_core::{hash, Digest, Error, Result};
use modernbert_candle::{
    weights::{Reader, StableWeight},
    QuantWeight,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

pub const FORMAT: &str = "ic-ticketing-ja-pack-v1";
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub name: String,
    pub shape: Vec<usize>,
    pub encoding: String,
    pub offset: u64,
    pub length: u64,
    pub sha256: Digest,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub format: String,
    pub source_repo: String,
    pub source_revision: String,
    pub checkpoint_sha256: Digest,
    pub tokenizer_sha256: Digest,
    pub config_sha256: Digest,
    pub reference_f32: bool,
    pub total_bytes: u64,
    pub tensors: Vec<Entry>,
}
impl Manifest {
    pub fn parse(raw: &[u8], allow_reference: bool) -> Result<Self> {
        if raw.len() > 256 * 1024 {
            return Err(Error::TooLong);
        }
        let m: Self = serde_json::from_slice(raw).map_err(model_error)?;
        if m.format != FORMAT
            || m.source_repo != "sbintuitions/modernbert-ja-130m"
            || m.source_revision != "28c180b16463ba6f3fa79b48756fbf21586fe23e"
            || (m.reference_f32 && !allow_reference)
        {
            return Err(Error::Invalid("unsupported ticketing pack".into()));
        }
        let expected = expected_tensors();
        let mut pos = 0;
        if m.tensors.len() != expected.len() {
            return Err(Error::Invalid("tensor count".into()));
        }
        // Sorted exact names prevent duplicate tensors, aliases and arbitrary layouts.
        for (e, (name, shape)) in m.tensors.iter().zip(expected) {
            let n = shape.iter().product::<usize>() as u64;
            let quant = quantized_name(&name, &shape) && !m.reference_f32;
            let length = if quant {
                n + 4 * shape[0] as u64
            } else {
                n * 4
            };
            if e.name != name
                || e.shape != shape
                || e.offset != pos
                || e.length != length
                || e.encoding != if quant { "i8_row_symmetric" } else { "f32_le" }
            {
                return Err(Error::Invalid(format!("tensor contract: {name}")));
            }
            pos += length;
        }
        if pos != m.total_bytes {
            return Err(Error::Invalid("pack length".into()));
        }
        Ok(m)
    }
}
pub struct Builder {
    pub manifest: Manifest,
    pub next: usize,
    m: Tensors,
    q: Quant,
}
impl Builder {
    pub fn new(raw: &[u8], allow_reference: bool) -> Result<Self> {
        Ok(Self {
            manifest: Manifest::parse(raw, allow_reference)?,
            next: 0,
            m: Tensors::new(),
            q: Quant::new(),
        })
    }
    pub fn next_entry(&self) -> Option<&Entry> {
        self.manifest.tensors.get(self.next)
    }
    pub fn push(&mut self, bytes: &[u8]) -> Result<()> {
        let e = self.next_entry().ok_or(Error::Transition)?.clone();
        if bytes.len() as u64 != e.length || hash(bytes) != e.sha256 {
            return Err(Error::Invalid("tensor integrity".into()));
        }
        if e.encoding == "f32_le" {
            if bytes
                .chunks_exact(4)
                .any(|b| !f32::from_le_bytes(b.try_into().unwrap()).is_finite())
            {
                return Err(Error::Numeric);
            }
            self.m.insert(
                e.name,
                Tensor::from_raw_buffer(bytes, DType::F32, &e.shape, &Device::Cpu)
                    .map_err(model_error)?,
            );
        } else {
            let n = e.shape[0] * e.shape[1];
            let w = bytes[..n].iter().map(|&b| b as i8).collect::<Vec<_>>();
            if w.contains(&i8::MIN) {
                return Err(Error::Numeric);
            }
            let scales = read_scales(&bytes[n..])?;
            self.q.insert(
                e.name,
                QuantWeight {
                    stable: None,
                    w,
                    scales,
                    out_features: e.shape[0],
                    in_features: e.shape[1],
                    block_size: e.shape[1],
                },
            );
        }
        self.next += 1;
        Ok(())
    }
    /// Validate each tensor in bounded buffers; only row scales stay resident.
    pub fn push_reader(&mut self, base: u64, reader: Reader) -> Result<()> {
        let e = self.next_entry().ok_or(Error::Transition)?.clone();
        if e.encoding == "f32_le" {
            if e.length > 64 * 1024 {
                return Err(Error::Invalid("reference pack cannot stream".into()));
            }
            let mut bytes = vec![0; e.length as usize];
            reader(base + e.offset, &mut bytes).map_err(model_error)?;
            return self.push(&bytes);
        }
        let n = e.shape[0] * e.shape[1];
        let mut digest = Sha256::new();
        let mut buffer = vec![0; (256 * 1024).min(n)];
        for at in (0..n).step_by(buffer.len()) {
            let len = buffer.len().min(n - at);
            reader(base + e.offset + at as u64, &mut buffer[..len]).map_err(model_error)?;
            if buffer[..len].contains(&128) {
                return Err(Error::Numeric);
            }
            digest.update(&buffer[..len]);
        }
        let mut scales = vec![0; 4 * e.shape[0]];
        reader(base + e.offset + n as u64, &mut scales).map_err(model_error)?;
        digest.update(&scales);
        let actual: Digest = digest.finalize().into();
        if actual != e.sha256 {
            return Err(Error::Invalid("tensor integrity".into()));
        }
        let scales = read_scales(&scales)?;
        self.q.insert(
            e.name,
            QuantWeight {
                stable: Some(StableWeight {
                    offset: base + e.offset,
                    window_offset: base + e.offset,
                    window_length: n,
                    reader,
                }),
                w: Vec::new(),
                scales,
                out_features: e.shape[0],
                in_features: e.shape[1],
                block_size: e.shape[1],
            },
        );
        self.next += 1;
        Ok(())
    }
    pub fn finish(self) -> Result<Model> {
        if self.next != self.manifest.tensors.len() {
            return Err(Error::Transition);
        }
        Model::assemble(self.m, self.q)
    }
}
fn read_scales(raw: &[u8]) -> Result<Vec<f32>> {
    let v = raw
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect::<Vec<_>>();
    if v.iter().any(|x| !x.is_finite() || *x <= 0.) {
        return Err(Error::Numeric);
    }
    Ok(v)
}
#[cfg(not(target_arch = "wasm32"))]
pub fn load_directory(dir: &std::path::Path, allow_reference: bool) -> Result<Model> {
    use std::io::Read;
    let mut b = Builder::new(
        &std::fs::read(dir.join("manifest.json")).map_err(model_error)?,
        allow_reference,
    )?;
    let mut f = std::fs::File::open(dir.join("model.bin")).map_err(model_error)?;
    if f.metadata().map_err(model_error)?.len() != b.manifest.total_bytes {
        return Err(Error::Invalid("file length".into()));
    }
    while let Some(e) = b.next_entry() {
        let mut bytes = vec![0; e.length as usize];
        f.read_exact(&mut bytes).map_err(model_error)?;
        b.push(&bytes)?;
    }
    b.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn manifest() -> Manifest {
        let mut pos = 0;
        let tensors = expected_tensors()
            .into_iter()
            .map(|(name, shape)| {
                let quant = quantized_name(&name, &shape);
                let n = shape.iter().product::<usize>() as u64;
                let length = if quant {
                    n + 4 * shape[0] as u64
                } else {
                    n * 4
                };
                let e = Entry {
                    name,
                    shape,
                    encoding: if quant { "i8_row_symmetric" } else { "f32_le" }.into(),
                    offset: pos,
                    length,
                    sha256: [0; 32],
                };
                pos += length;
                e
            })
            .collect();
        Manifest {
            format: FORMAT.into(),
            source_repo: "sbintuitions/modernbert-ja-130m".into(),
            source_revision: "28c180b16463ba6f3fa79b48756fbf21586fe23e".into(),
            checkpoint_sha256: [1; 32],
            tokenizer_sha256: [2; 32],
            config_sha256: [3; 32],
            reference_f32: false,
            total_bytes: pos,
            tensors,
        }
    }
    fn raw(m: &Manifest) -> Vec<u8> {
        serde_json::to_vec(m).unwrap()
    }
    #[test]
    fn rejects_shape_offset_duplicate_and_reference_packs() {
        let m = manifest();
        assert!(Manifest::parse(&raw(&m), false).is_ok());
        let mut wrong = m.clone();
        wrong.tensors[3].shape[0] += 1;
        assert!(Manifest::parse(&raw(&wrong), false).is_err());
        let mut wrong = m.clone();
        wrong.tensors[3].offset += 1;
        assert!(Manifest::parse(&raw(&wrong), false).is_err());
        let mut wrong = m.clone();
        wrong.tensors[3].name = wrong.tensors[2].name.clone();
        assert!(Manifest::parse(&raw(&wrong), false).is_err());
        let mut wrong = m;
        wrong.reference_f32 = true;
        assert!(Manifest::parse(&raw(&wrong), false).is_err());
    }
    #[test]
    fn corrupt_nonfinite_or_incomplete_tensors_cannot_be_activated() {
        let mut m = manifest();
        let mut bytes = vec![0; m.tensors[0].length as usize];
        m.tensors[0].sha256 = hash(&bytes);
        let mut b = Builder::new(&raw(&m), false).unwrap();
        bytes[0] = 1;
        assert!(b.push(&bytes).is_err());
        assert_eq!(b.next, 0);
        let mut bytes = vec![0; m.tensors[0].length as usize];
        bytes[..4].copy_from_slice(&f32::NAN.to_le_bytes());
        m.tensors[0].sha256 = hash(&bytes);
        let mut b = Builder::new(&raw(&m), false).unwrap();
        assert!(b.push(&bytes).is_err());
        assert_eq!(b.next, 0);
        assert!(b.finish().is_err());
    }
}
