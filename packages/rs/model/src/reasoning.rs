//! Reasoning-effort inference for Databricks-hosted model families.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::models::{parse_model_name, ModelFamily};

static O_SERIES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[-_./])o(?:1|3|4)(?:[-_./]|$)").expect("valid o-series pattern")
});

/// Reasoning effort accepted by a model endpoint.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    /// Disable explicit reasoning.
    None,
    /// Use the smallest available reasoning budget.
    Minimal,
    /// Use a low reasoning budget.
    Low,
    /// Use a medium reasoning budget.
    Medium,
    /// Use a high reasoning budget.
    High,
    /// Use an extra-high reasoning budget.
    Xhigh,
    /// Use the largest available reasoning budget.
    Max,
}

impl ReasoningEffort {
    /// Return the provider wire value for this reasoning effort.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

const STANDARD: &[ReasoningEffort] = &[
    ReasoningEffort::Low,
    ReasoningEffort::Medium,
    ReasoningEffort::High,
];
const GPT_5_6: &[ReasoningEffort] = &[
    ReasoningEffort::None,
    ReasoningEffort::Low,
    ReasoningEffort::Medium,
    ReasoningEffort::High,
    ReasoningEffort::Xhigh,
    ReasoningEffort::Max,
];
const GPT_5_5_PRO: &[ReasoningEffort] = &[
    ReasoningEffort::Medium,
    ReasoningEffort::High,
    ReasoningEffort::Xhigh,
];
const CLAUDE: &[ReasoningEffort] = &[
    ReasoningEffort::None,
    ReasoningEffort::Minimal,
    ReasoningEffort::Low,
    ReasoningEffort::Medium,
    ReasoningEffort::High,
    ReasoningEffort::Xhigh,
    ReasoningEffort::Max,
];
const GEMINI: &[ReasoningEffort] = &[
    ReasoningEffort::Minimal,
    ReasoningEffort::Low,
    ReasoningEffort::Medium,
    ReasoningEffort::High,
];

/// Infer the accepted reasoning efforts from a model or service name.
#[uniffi::export]
pub fn reasoning_efforts_by_family(name: &str) -> Vec<ReasoningEffort> {
    let normalized = name.to_ascii_lowercase();
    let parsed = parse_model_name(name);
    if let Some(parsed) = parsed.as_ref() {
        if parsed.family == ModelFamily::Gpt && !parsed.version.is_empty() {
            let major = parsed.version[0];
            let minor = parsed.version.get(1).copied().unwrap_or(0);
            if major >= 5 {
                if (major, minor) == (5, 5) && parsed.model.iter().any(|part| part == "pro") {
                    return GPT_5_5_PRO.to_vec();
                }
                return if (major, minor) == (5, 6) {
                    GPT_5_6.to_vec()
                } else {
                    STANDARD.to_vec()
                };
            }
        }
        if parsed.family == ModelFamily::Gpt && parsed.model.iter().any(|part| part == "oss") {
            return STANDARD.to_vec();
        }
        if parsed.family == ModelFamily::Claude
            && (
                parsed.version.first().copied().unwrap_or(0),
                parsed.version.get(1).copied().unwrap_or(0),
            ) >= (3, 7)
        {
            return CLAUDE.to_vec();
        }
        if parsed.family == ModelFamily::Gemini {
            return GEMINI.to_vec();
        }
    }
    if normalized.contains("codex") {
        return STANDARD.to_vec();
    }
    if O_SERIES.is_match(&normalized) {
        return STANDARD.to_vec();
    }
    Vec::new()
}

/// Infer provider wire values accepted by a model or service name.
#[uniffi::export]
pub fn reasoning_effort_names_by_family(name: &str) -> Vec<String> {
    reasoning_efforts_by_family(name)
        .into_iter()
        .map(|effort| effort.as_str().to_owned())
        .collect()
}

/// Return the Chat Completions effort required when function tools are present.
#[uniffi::export]
pub fn chat_tool_reasoning_effort(name: &str) -> Option<ReasoningEffort> {
    let parsed = parse_model_name(name)?;
    if parsed.family != ModelFamily::Gpt {
        return None;
    }
    let major = parsed.version.first().copied().unwrap_or(0);
    let minor = parsed.version.get(1).copied().unwrap_or(0);
    ((major, minor) == (5, 6)).then_some(ReasoningEffort::None)
}

/// Return the richest inferred effort list across model identities.
pub fn reasoning_efforts_for_names<'a>(
    names: impl IntoIterator<Item = &'a str>,
) -> Vec<ReasoningEffort> {
    names
        .into_iter()
        .map(reasoning_efforts_by_family)
        .max_by_key(Vec::len)
        .unwrap_or_default()
}
