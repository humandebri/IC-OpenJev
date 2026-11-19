//! Additive IT queue heads over the existing, immutable Japanese encoder.
use candid::CandidType;
use ic_laya_core::{Digest, Error, Result};
use serde::{Deserialize, Serialize};

pub const QUEUES: [&str; 4] = ["account", "device", "network", "review"];
pub const PRIORITIES: [&str; 3] = ["low", "normal", "high"];
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Head {
    pub format: String,
    #[serde(default)]
    pub validated: bool,
    pub base_model: Digest,
    pub corpus_sha256: Digest,
    pub queue_weights: Vec<f32>,
    pub queue_bias: Vec<f32>,
    pub priority_weights: Vec<f32>,
    pub priority_bias: Vec<f32>,
    pub queue_threshold: f32,
    pub margin_threshold: f32,
    pub priority_threshold: f32,
}
impl Head {
    pub fn parse(raw: &[u8], base: Digest) -> Result<Self> {
        if raw.is_empty() || raw.len() > 128 * 1024 {
            return Err(Error::TooLong);
        }
        let h: Self = serde_json::from_slice(raw)
            .map_err(|_| Error::Invalid("invalid IT routing head".into()))?;
        h.validate(base)?;
        Ok(h)
    }
    pub fn validate(&self, base: Digest) -> Result<()> {
        if self.base_model != base || base == [0; 32] {
            return Err(Error::BindingMismatch);
        }
        if self.format != "ic-it-routing-head-v1"
            || self.queue_weights.len() != 4 * 512
            || self.queue_bias.len() != 4
            || self.priority_weights.len() != 3 * 512
            || self.priority_bias.len() != 3
        {
            return Err(Error::Invalid("IT routing head shape".into()));
        }
        if self
            .queue_weights
            .iter()
            .chain(&self.queue_bias)
            .chain(&self.priority_weights)
            .chain(&self.priority_bias)
            .any(|x| !x.is_finite())
            || !(0.5..=1.).contains(&self.queue_threshold)
            || !(0.5..=1.).contains(&self.priority_threshold)
            || !(0.0..=1.).contains(&self.margin_threshold)
        {
            return Err(Error::Numeric);
        }
        Ok(())
    }
    pub fn predict(&self, features: &[f32]) -> Result<Prediction> {
        self.validate(self.base_model)?;
        if features.len() != 512 || features.iter().any(|x| !x.is_finite()) {
            return Err(Error::Numeric);
        }
        let classify =
            |weights: &[f32], bias: &[f32], labels: &[&str]| -> Result<crate::Classification> {
                let logits = weights
                    .chunks_exact(512)
                    .zip(bias)
                    .map(|(w, b)| w.iter().zip(features).fold(*b, |s, (a, x)| s + a * x))
                    .collect();
                crate::classification(logits, labels)
            };
        let queue = classify(&self.queue_weights, &self.queue_bias, &QUEUES)?;
        let priority = classify(&self.priority_weights, &self.priority_bias, &PRIORITIES)?;
        let index = QUEUES
            .iter()
            .position(|q| *q == queue.selected)
            .ok_or(Error::Numeric)?;
        let confidence = queue.probabilities[index];
        let runner_up = queue
            .probabilities
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != index)
            .map(|(_, p)| *p)
            .fold(0., f32::max);
        let p_index = PRIORITIES
            .iter()
            .position(|p| *p == priority.selected)
            .ok_or(Error::Numeric)?;
        let mut reasons = Vec::new();
        if !self.validated || self.queue_threshold == 1. {
            reasons.push("validation_failed".into());
        }
        if queue.selected == "review" {
            reasons.push("outside_scope".into());
        }
        if confidence < self.queue_threshold || confidence - runner_up < self.margin_threshold {
            reasons.push("uncertain_queue".into());
        }
        if priority.probabilities[p_index] < self.priority_threshold {
            reasons.push("uncertain_priority".into());
        }
        let decision = if reasons.is_empty() {
            queue.selected.clone()
        } else {
            "review".into()
        };
        Ok(Prediction {
            queue,
            priority,
            decision,
            review_reasons: reasons,
        })
    }
}
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Prediction {
    pub queue: crate::Classification,
    pub priority: crate::Classification,
    /// A suggested destination only. No ticket is created or assigned by this API.
    pub decision: String,
    pub review_reasons: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn head() -> Head {
        Head {
            format: "ic-it-routing-head-v1".into(),
            validated: true,
            base_model: [1; 32],
            corpus_sha256: [2; 32],
            queue_weights: vec![0.; 4 * 512],
            queue_bias: vec![10., 0., 0., 0.],
            priority_weights: vec![0.; 3 * 512],
            priority_bias: vec![0., 10., 0.],
            queue_threshold: 0.8,
            margin_threshold: 0.2,
            priority_threshold: 0.8,
        }
    }
    #[test]
    fn ambiguous_or_outside_scope_requests_never_receive_an_automatic_destination() {
        let mut h = head();
        assert_eq!(h.predict(&[0.; 512]).unwrap().decision, "account");
        h.validated = false;
        assert_eq!(h.predict(&[0.; 512]).unwrap().decision, "review");
        h.queue_threshold = 1.;
        let disabled = h.predict(&[0.; 512]).unwrap();
        assert_eq!(disabled.decision, "review");
        assert_eq!(
            disabled
                .review_reasons
                .iter()
                .filter(|r| *r == "validation_failed")
                .count(),
            1
        );
        h.queue_threshold = 0.8;
        h.validated = true;
        h.queue_bias = vec![0.; 4];
        let p = h.predict(&[0.; 512]).unwrap();
        assert_eq!(p.decision, "review");
        assert!(p.review_reasons.contains(&"uncertain_queue".into()));
        h.queue_bias = vec![0., 0., 0., 10.];
        assert!(h
            .predict(&[0.; 512])
            .unwrap()
            .review_reasons
            .contains(&"outside_scope".into()));
        h.queue_bias = vec![10., 0., 0., 0.];
        h.priority_bias = vec![0.; 3];
        assert!(h
            .predict(&[0.; 512])
            .unwrap()
            .review_reasons
            .contains(&"uncertain_priority".into()));
    }
    #[test]
    fn corrupt_heads_and_cross_model_reuse_are_rejected() {
        let mut h = head();
        assert!(h.validate([3; 32]).is_err());
        h.queue_weights.pop();
        assert!(h.validate([1; 32]).is_err());
        let mut h = head();
        h.queue_threshold = f32::NAN;
        assert!(h.validate([1; 32]).is_err());
        let mut h = head();
        h.priority_bias[0] = f32::INFINITY;
        assert!(h.validate([1; 32]).is_err());
    }
}
