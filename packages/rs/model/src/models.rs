//! Model contracts and provider-neutral model-name parsing.

use std::{collections::BTreeMap, sync::LazyLock};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::reasoning::ReasoningEffort;

static TOKEN_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[a-z0-9]+").expect("valid model token pattern"));
static VERSION_SEPARATOR_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^a-zA-Z0-9]+").expect("valid version separator pattern"));
static VERSION_PART_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d+").expect("valid version pattern"));

/// Recognized foundation-model family.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelFamily {
    /// BGE embedding models.
    Bge,
    /// Anthropic Claude models.
    Claude,
    /// DeepSeek models.
    Deepseek,
    /// Google Gemini models.
    Gemini,
    /// Google Gemma models.
    Gemma,
    /// GLM models.
    Glm,
    /// OpenAI GPT models.
    Gpt,
    /// xAI Grok models.
    Grok,
    /// GTE embedding models.
    Gte,
    /// Databricks Inkling embedding models.
    Inkling,
    /// Moonshot Kimi models.
    Kimi,
    /// Meta Llama models.
    Llama,
    /// Alibaba Qwen models.
    Qwen,
}

impl ModelFamily {
    /// Return the normalized family token.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bge => "bge",
            Self::Claude => "claude",
            Self::Deepseek => "deepseek",
            Self::Gemini => "gemini",
            Self::Gemma => "gemma",
            Self::Glm => "glm",
            Self::Gpt => "gpt",
            Self::Grok => "grok",
            Self::Gte => "gte",
            Self::Inkling => "inkling",
            Self::Kimi => "kimi",
            Self::Llama => "llama",
            Self::Qwen => "qwen",
        }
    }

    /// Return whether model names in this family carry comparable versions.
    pub fn is_versioned(self) -> bool {
        !matches!(self, Self::Bge | Self::Gte | Self::Inkling)
    }
}

/// Intent-oriented class used to select a Model Serving endpoint.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelClass {
    /// Higher-quality chat models suited to deliberate reasoning.
    ChatThinking,
    /// General-purpose chat models balancing quality and latency.
    ChatBalanced,
    /// Low-latency chat models.
    ChatFast,
    /// Text embedding models.
    Embedding,
}

impl ModelClass {
    /// Model classes in fallback preference order.
    pub const ORDER: [Self; 4] = [
        Self::ChatThinking,
        Self::ChatBalanced,
        Self::ChatFast,
        Self::Embedding,
    ];

    /// Return this class's position in the fallback order.
    pub fn order(self) -> usize {
        Self::ORDER
            .iter()
            .position(|candidate| *candidate == self)
            .unwrap_or(Self::ORDER.len())
    }
}

/// Structured components parsed from a model or endpoint name.
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedModelName {
    /// Trimmed source name.
    pub source: String,
    /// Recognized model family.
    pub family: ModelFamily,
    /// Numeric version components.
    pub version: Vec<u32>,
    /// Remaining model variant tokens.
    pub model: Vec<String>,
}

/// Databricks AI Gateway profile scores for an endpoint.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProfile {
    /// Relative model quality score.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<f64>,
    /// Relative model speed score.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    /// Relative model cost score.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
}

/// Lifecycle status associated with a model.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    /// Whether Databricks lists the model as retired or deprecated.
    #[serde(default)]
    pub deprecated: bool,
}

/// Normalized metadata for a Databricks Model Serving endpoint.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServingEndpointSummary {
    /// Model Serving endpoint name used for invocation.
    pub name: String,
    /// Human-readable endpoint or model name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Endpoint task, such as chat or embeddings.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    /// Endpoint readiness state.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// Endpoint description supplied by Databricks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Whether the endpoint supports tool calling.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_tools: Option<bool>,
    /// AI Gateway model profile scores.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<ModelProfile>,
    /// Intent-oriented endpoint class.
    #[serde(rename = "class", skip_serializing_if = "Option::is_none")]
    pub model_class: Option<ModelClass>,
    /// Provider names mapped to provider-specific model names.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub service_names: BTreeMap<String, String>,
    /// Foundation model name reported by the served entity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_service_name: Option<String>,
    /// Reasoning effort values accepted by the endpoint.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reasoning_efforts: Vec<ReasoningEffort>,
    /// Retirement status for the served model.
    #[serde(default)]
    pub status: ModelStatus,
}

/// Filters and ranking controls for a model catalogue query.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModelQuery {
    /// Optional fuzzy model-name search.
    pub search: Option<String>,
    /// Requested model-class ceiling, or the exact embedding class.
    pub model_class: Option<ModelClass>,
    /// Whether candidates must support tool calling.
    pub requires_tools: bool,
    /// Whether retired models remain eligible.
    pub include_deprecated: bool,
    /// Maximum number of results.
    pub limit: Option<usize>,
    /// Maximum fuzzy-match distance.
    pub threshold: Option<f64>,
}

/// Model Serving endpoint plus its classification and search score.
#[derive(Clone, Debug, PartialEq)]
pub struct RankedModel {
    /// Matching endpoint metadata.
    pub endpoint: ServingEndpointSummary,
    /// Intent-oriented endpoint class.
    pub model_class: ModelClass,
    /// Fuzzy-match distance, where lower values are closer.
    pub score: Option<f64>,
}

/// Result of resolving a requested model name.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedModel {
    /// Resolved endpoint name or the original request when unmatched.
    pub model_id: String,
    /// Whether the request matched a known endpoint.
    pub matched: bool,
    /// Fuzzy-match distance when available.
    pub score: Option<f64>,
}

/// Parse a model or endpoint name into family, version, and variant tokens.
pub fn parse_model_name(value: &str) -> Option<ParsedModelName> {
    let source = value.trim();
    if source.is_empty() {
        return None;
    }
    let tokens = TOKEN_PATTERN
        .find_iter(&source.to_ascii_lowercase())
        .map(|matched| matched.as_str().to_owned())
        .collect::<Vec<_>>();
    let (family_index, family, embedded_version) = find_model_family(&tokens)?;
    let remainder = &tokens[family_index + 1..];
    let (version, model) = match family {
        ModelFamily::Qwen => parse_qwen_parts(embedded_version, remainder),
        ModelFamily::Claude => parse_claude_parts(remainder),
        ModelFamily::Deepseek => parse_prefixed_version(remainder, 'v'),
        ModelFamily::Kimi => parse_prefixed_version(remainder, 'k'),
        _ => parse_leading_version(remainder),
    };
    Some(ParsedModelName {
        source: source.to_owned(),
        family,
        version,
        model,
    })
}

/// Normalize a model name into tokens suitable for fuzzy catalogue search.
pub fn model_search_query(value: &str) -> Option<String> {
    let parsed = parse_model_name(value)?;
    Some(
        std::iter::once(parsed.family.as_str().to_owned())
            .chain(parsed.version.into_iter().map(|part| part.to_string()))
            .chain(parsed.model)
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// Return whether a model requires Databricks' native Responses endpoint.
pub fn is_responses_only(value: &str) -> bool {
    if value.to_ascii_lowercase().contains("codex") {
        return true;
    }
    let Some(parsed) = parse_model_name(value) else {
        return false;
    };
    if parsed.family != ModelFamily::Gpt
        || parsed.model.iter().any(|part| part == "oss")
        || parsed.version.is_empty()
    {
        return false;
    }
    let major = parsed.version[0];
    let minor = parsed.version.get(1).copied().unwrap_or(0);
    major > 5 || (major == 5 && minor >= 4)
}

/// Derive provider-specific model names from a model identity.
pub fn model_service_names(value: &str) -> BTreeMap<String, String> {
    let Some(parsed) = parse_model_name(value) else {
        return BTreeMap::new();
    };
    let version = parsed
        .version
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>();
    let dotted_version = version.join(".");
    let mut names = BTreeMap::new();
    let entry = match parsed.family {
        ModelFamily::Gpt if !parsed.model.iter().any(|part| part == "oss") => {
            ("openai", joined_name("gpt", &dotted_version, &parsed.model))
        }
        ModelFamily::Claude => {
            let mut parts = vec!["claude".to_owned()];
            if let Some(first) = parsed.model.first() {
                parts.push(first.clone());
            }
            parts.extend(version);
            parts.extend(parsed.model.into_iter().skip(1));
            ("anthropic", parts.join("-"))
        }
        ModelFamily::Gemini => (
            "google",
            joined_name("gemini", &dotted_version, &parsed.model),
        ),
        ModelFamily::Gemma => (
            "google",
            joined_name("gemma", &dotted_version, &parsed.model),
        ),
        ModelFamily::Glm => ("zhipu", joined_name("glm", &dotted_version, &parsed.model)),
        ModelFamily::Grok => ("xai", joined_name("grok", &dotted_version, &parsed.model)),
        ModelFamily::Llama => ("meta", joined_name("llama", &dotted_version, &parsed.model)),
        ModelFamily::Qwen if !parsed.version.is_empty() => {
            let suffix = if parsed.model.is_empty() {
                String::new()
            } else {
                format!("-{}", parsed.model.join("-"))
            };
            ("alibaba", format!("qwen{dotted_version}{suffix}"))
        }
        ModelFamily::Deepseek if !parsed.version.is_empty() => (
            "deepseek",
            joined_name(
                &format!("deepseek-v{}", parsed.version[0]),
                "",
                &parsed.model,
            ),
        ),
        ModelFamily::Kimi if !parsed.version.is_empty() => (
            "moonshot",
            joined_name(&format!("kimi-k{}", parsed.version[0]), "", &parsed.model),
        ),
        _ => return names,
    };
    if !entry.1.is_empty() {
        names.insert(entry.0.to_owned(), entry.1);
    }
    names
}

/// Extract up to three numeric version components from a model name.
pub fn version_tuple(name: &str) -> [u32; 3] {
    let Some(start) = name.find(|character: char| character.is_ascii_digit()) else {
        return [0, 0, 0];
    };
    let mut numbers = VERSION_SEPARATOR_PATTERN
        .split(&name[start..])
        .filter_map(|part| {
            VERSION_PART_PATTERN
                .find(part)
                .and_then(|digits| digits.as_str().parse().ok())
        });
    [
        numbers.next().unwrap_or(0),
        numbers.next().unwrap_or(0),
        numbers.next().unwrap_or(0),
    ]
}

fn joined_name(prefix: &str, version: &str, model: &[String]) -> String {
    std::iter::once(prefix)
        .chain((!version.is_empty()).then_some(version))
        .chain(model.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join("-")
}

fn find_model_family(tokens: &[String]) -> Option<(usize, ModelFamily, Vec<u32>)> {
    let mut exact = None;
    for (index, token) in tokens.iter().enumerate() {
        if let Some(compact) = token.strip_prefix("qwen") {
            if !compact.is_empty() && compact.chars().all(|character| character.is_ascii_digit()) {
                let version = if compact.len() == 2 {
                    compact
                        .chars()
                        .map(|character| character.to_digit(10).expect("digit"))
                        .collect()
                } else {
                    vec![compact.parse().ok()?]
                };
                return Some((index, ModelFamily::Qwen, version));
            }
        }
        if let Some(family) = family_from_token(token) {
            exact = Some((index, family, Vec::new()));
        }
    }
    exact
}

fn family_from_token(token: &str) -> Option<ModelFamily> {
    Some(match token {
        "bge" => ModelFamily::Bge,
        "claude" => ModelFamily::Claude,
        "deepseek" => ModelFamily::Deepseek,
        "gemini" => ModelFamily::Gemini,
        "gemma" => ModelFamily::Gemma,
        "glm" => ModelFamily::Glm,
        "gpt" => ModelFamily::Gpt,
        "grok" => ModelFamily::Grok,
        "gte" => ModelFamily::Gte,
        "inkling" => ModelFamily::Inkling,
        "kimi" => ModelFamily::Kimi,
        "llama" => ModelFamily::Llama,
        "qwen" => ModelFamily::Qwen,
        _ => return None,
    })
}

fn parse_qwen_parts(embedded_version: Vec<u32>, remainder: &[String]) -> (Vec<u32>, Vec<String>) {
    if embedded_version.is_empty() {
        return parse_leading_version(remainder);
    }
    if embedded_version.len() == 1
        && remainder
            .first()
            .is_some_and(|part| part.chars().all(|character| character.is_ascii_digit()))
    {
        let mut version = embedded_version;
        version.push(remainder[0].parse().expect("numeric Qwen version"));
        return (version, remainder[1..].to_vec());
    }
    (embedded_version, remainder.to_vec())
}

fn parse_claude_parts(remainder: &[String]) -> (Vec<u32>, Vec<String>) {
    let Some(start) = remainder
        .iter()
        .position(|part| part.chars().all(|character| character.is_ascii_digit()))
    else {
        return (Vec::new(), remainder.to_vec());
    };
    let (version, suffix) = take_version(&remainder[start..]);
    (
        version,
        remainder[..start].iter().cloned().chain(suffix).collect(),
    )
}

fn parse_prefixed_version(remainder: &[String], prefix: char) -> (Vec<u32>, Vec<String>) {
    let Some(first) = remainder.first() else {
        return (Vec::new(), Vec::new());
    };
    if let Some(version) = first
        .strip_prefix(prefix)
        .and_then(|value| value.parse().ok())
    {
        return (vec![version], remainder[1..].to_vec());
    }
    parse_leading_version(remainder)
}

fn parse_leading_version(remainder: &[String]) -> (Vec<u32>, Vec<String>) {
    let (version, model) = take_version(remainder);
    (version, model.collect())
}

fn take_version(parts: &[String]) -> (Vec<u32>, impl Iterator<Item = String> + use<'_>) {
    let count = parts
        .iter()
        .take(2)
        .take_while(|part| part.chars().all(|character| character.is_ascii_digit()))
        .count();
    (
        parts[..count]
            .iter()
            .map(|part| part.parse().expect("numeric model version"))
            .collect(),
        parts[count..].iter().cloned(),
    )
}
