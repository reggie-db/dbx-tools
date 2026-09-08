//! Model capability classification and stable class ordering.

use std::cmp::Ordering;

use crate::models::{
    parse_model_name, version_tuple, ModelClass, ModelFamily, ServingEndpointSummary,
};

pub const CHAT_TASK: &str = "llm/v1/chat";
pub const EMBEDDING_TASK: &str = "llm/v1/embeddings";

pub fn supports_tools_by_family(name: &str) -> bool {
    let Some(parsed) = parse_model_name(name) else {
        return false;
    };
    if parsed.family == ModelFamily::Gemini
        || (parsed.family == ModelFamily::Gpt && parsed.model.iter().any(|part| part == "oss"))
    {
        return false;
    }
    matches!(
        parsed.family,
        ModelFamily::Claude
            | ModelFamily::Glm
            | ModelFamily::Gpt
            | ModelFamily::Llama
            | ModelFamily::Qwen
    )
}

pub fn classify_by_family(name: &str) -> Option<(ModelClass, u64)> {
    let parsed = parse_model_name(name)?;
    let version = version_tuple(name);
    let rank =
        u64::from(version[0]) * 1_000_000 + u64::from(version[1]) * 1_000 + u64::from(version[2]);
    let has = |part: &str| parsed.model.iter().any(|candidate| candidate == part);
    let model_class = match parsed.family {
        ModelFamily::Claude if has("opus") => ModelClass::ChatThinking,
        ModelFamily::Claude if has("sonnet") => ModelClass::ChatBalanced,
        ModelFamily::Claude if has("haiku") => ModelClass::ChatFast,
        ModelFamily::Gpt if has("oss") && has("120b") => ModelClass::ChatBalanced,
        ModelFamily::Gpt if has("oss") => ModelClass::ChatFast,
        ModelFamily::Gpt if has("pro") => ModelClass::ChatThinking,
        ModelFamily::Gpt if has("mini") || has("nano") => ModelClass::ChatFast,
        ModelFamily::Gpt => ModelClass::ChatBalanced,
        ModelFamily::Gemini if has("flash") && has("lite") => ModelClass::ChatFast,
        ModelFamily::Gemini if has("pro") => ModelClass::ChatThinking,
        ModelFamily::Gemini => ModelClass::ChatBalanced,
        ModelFamily::Gemma => ModelClass::ChatFast,
        ModelFamily::Llama if has("maverick") || has("405b") => ModelClass::ChatThinking,
        ModelFamily::Llama if has("8b") || has("1b") => ModelClass::ChatFast,
        ModelFamily::Llama => ModelClass::ChatBalanced,
        ModelFamily::Qwen => ModelClass::ChatBalanced,
        _ => return None,
    };
    Some((model_class, rank))
}

pub fn classify_endpoints(
    endpoints: &[ServingEndpointSummary],
) -> Vec<(ModelClass, ServingEndpointSummary)> {
    let mut qualities = endpoints
        .iter()
        .filter(|endpoint| endpoint.task.as_deref() == Some(CHAT_TASK))
        .filter_map(|endpoint| endpoint.profile.as_ref()?.quality)
        .filter(|quality| quality.is_finite())
        .collect::<Vec<_>>();
    qualities.sort_by(f64::total_cmp);
    let low = quantile(&qualities, 1.0 / 3.0);
    let high = quantile(&qualities, 2.0 / 3.0);

    let mut classified = endpoints
        .iter()
        .filter_map(|endpoint| {
            if endpoint.task.as_deref() == Some(EMBEDDING_TASK) {
                return Some((
                    ModelClass::Embedding,
                    SortKey::embedding(),
                    endpoint.clone(),
                ));
            }
            if endpoint.task.as_deref() != Some(CHAT_TASK) {
                return None;
            }
            let quality = endpoint
                .profile
                .as_ref()
                .and_then(|profile| profile.quality)
                .filter(|value| value.is_finite());
            if let Some(quality) = quality {
                let model_class = if quality >= high {
                    ModelClass::ChatThinking
                } else if quality <= low {
                    ModelClass::ChatFast
                } else {
                    ModelClass::ChatBalanced
                };
                let profile = endpoint.profile.as_ref().expect("profile has quality");
                return Some((
                    model_class,
                    SortKey {
                        source: 0,
                        rank: quality,
                        cost: profile.cost.unwrap_or(f64::INFINITY),
                        speed: profile.speed.unwrap_or(0.0),
                        version: version_tuple(&endpoint.name),
                    },
                    endpoint.clone(),
                ));
            }
            let (model_class, rank) = classify_by_family(&endpoint.name)?;
            Some((
                model_class,
                SortKey {
                    source: 1,
                    rank: rank as f64,
                    cost: f64::INFINITY,
                    speed: 0.0,
                    version: version_tuple(&endpoint.name),
                },
                endpoint.clone(),
            ))
        })
        .collect::<Vec<_>>();
    classified.sort_by(|left, right| {
        left.0
            .order()
            .cmp(&right.0.order())
            .then_with(|| left.1.compare(&right.1))
    });
    classified
        .into_iter()
        .map(|(model_class, _, endpoint)| (model_class, endpoint))
        .collect()
}

#[derive(Clone, Copy)]
struct SortKey {
    source: u8,
    rank: f64,
    cost: f64,
    speed: f64,
    version: [u32; 3],
}

impl SortKey {
    fn embedding() -> Self {
        Self {
            source: 0,
            rank: 0.0,
            cost: 0.0,
            speed: 0.0,
            version: [0, 0, 0],
        }
    }

    fn compare(&self, other: &Self) -> Ordering {
        self.source
            .cmp(&other.source)
            .then_with(|| other.rank.total_cmp(&self.rank))
            .then_with(|| self.cost.total_cmp(&other.cost))
            .then_with(|| other.speed.total_cmp(&self.speed))
            .then_with(|| other.version.cmp(&self.version))
    }
}

fn quantile(values: &[f64], probability: f64) -> f64 {
    if values.is_empty() {
        return f64::NAN;
    }
    let index = (values.len() - 1) as f64 * probability;
    let lower = index.floor() as usize;
    let upper = index.ceil() as usize;
    if lower == upper {
        values[lower]
    } else {
        values[lower] + (values[upper] - values[lower]) * (index - lower as f64)
    }
}
