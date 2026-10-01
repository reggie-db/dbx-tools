//! Fuzzy model search, ranking, and resolution.

use std::{cmp::Ordering, collections::BTreeMap, sync::LazyLock};

use difflib_fast::ratio;
use regex::Regex;

use crate::{
    classify::{classify_endpoints, supports_tools_by_family},
    models::{
        parse_model_name, version_tuple, ModelClass, ModelFamily, ModelQuery, RankedModel,
        ResolvedModel, ServingEndpointSummary,
    },
};

/// Default maximum distance accepted by fuzzy model matching.
pub const DEFAULT_FUZZY_THRESHOLD: f64 = 0.4;

static SEARCH_TOKEN_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[a-zA-Z0-9]+").expect("valid search token pattern"));
static NAME_SEGMENT_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[a-z0-9]+").expect("valid name segment pattern"));

/// Search Model Serving endpoints by exact name or fuzzy token distance.
pub fn search_serving_endpoints(
    input: &str,
    endpoints: &[ServingEndpointSummary],
    threshold: f64,
) -> Vec<(ServingEndpointSummary, f64)> {
    if let Some(endpoint) = endpoints.iter().find(|endpoint| endpoint.name == input) {
        return vec![(endpoint.clone(), 0.0)];
    }
    let input = input.to_ascii_lowercase();
    let tokens = SEARCH_TOKEN_PATTERN
        .find_iter(&input)
        .map(|matched| matched.as_str())
        .collect::<Vec<_>>();
    if tokens.is_empty() {
        return Vec::new();
    }
    let mut matches = endpoints
        .iter()
        .filter_map(|endpoint| {
            let name = endpoint.name.to_ascii_lowercase();
            let score = tokens
                .iter()
                .map(|token| token_distance(token, &name))
                .sum::<f64>()
                / tokens.len() as f64;
            (score <= threshold).then(|| (endpoint.clone(), score))
        })
        .collect::<Vec<_>>();
    matches.sort_by(|left, right| {
        left.1
            .total_cmp(&right.1)
            .then_with(|| left.0.name.cmp(&right.0.name))
    });
    matches
}

/// Filter, classify, rank, and limit endpoints for a model query.
pub fn lookup_models(endpoints: &[ServingEndpointSummary], query: &ModelQuery) -> Vec<RankedModel> {
    let summaries = endpoints
        .iter()
        .filter(|endpoint| query.include_deprecated.unwrap_or(false) || !endpoint.status.deprecated)
        .cloned()
        .collect::<Vec<_>>();
    let eligible = eligible_classes(query.model_class);
    let mut candidates = classify_endpoints(&summaries)
        .into_iter()
        .filter(|(model_class, endpoint)| {
            eligible.contains(model_class)
                && (!query.requires_tools.unwrap_or(false) || endpoint_supports_tools(endpoint))
        })
        .map(|(model_class, endpoint)| RankedModel {
            endpoint,
            model_class,
            score: None,
        })
        .collect::<Vec<_>>();

    let search = query.search.as_deref().map(str::trim).unwrap_or_default();
    if !search.is_empty() {
        let threshold = query.threshold.unwrap_or(DEFAULT_FUZZY_THRESHOLD);
        let scores = search_serving_endpoints(
            search,
            &candidates
                .iter()
                .map(|candidate| candidate.endpoint.clone())
                .collect::<Vec<_>>(),
            threshold,
        );
        candidates.retain_mut(|candidate| {
            let Some((_, score)) = scores
                .iter()
                .find(|(endpoint, _)| endpoint.name == candidate.endpoint.name)
            else {
                return false;
            };
            candidate.score = Some(*score);
            true
        });
        if search.eq_ignore_ascii_case("gpt") {
            candidates.retain(|candidate| {
                !parse_model_name(&candidate.endpoint.name).is_some_and(|parsed| {
                    parsed.family == ModelFamily::Gpt
                        && parsed.model.iter().any(|part| part == "oss")
                })
            });
        }
        let versioned_family_search = parse_model_name(search)
            .is_some_and(|parsed| parsed.family.is_versioned() && parsed.source == search);
        candidates.sort_by(|left, right| compare_ranked(left, right, versioned_family_search));
    }

    if let Some(limit) = query.limit {
        candidates.truncate(limit as usize);
    }
    candidates
}

/// Rank model endpoints through the generated UniFFI surface.
#[uniffi::export]
pub fn rank_models(endpoints: Vec<ServingEndpointSummary>, query: ModelQuery) -> Vec<RankedModel> {
    lookup_models(&endpoints, &query)
}

/// Resolve a search string to the highest-ranked endpoint name.
pub fn rank_model_id(
    endpoints: &[ServingEndpointSummary],
    search: &str,
    threshold: f64,
) -> ResolvedModel {
    if let Some(endpoint) = endpoints.iter().find(|endpoint| endpoint.name == search) {
        return ResolvedModel {
            model_id: endpoint.name.clone(),
            matched: true,
            score: Some(0.0),
        };
    }
    let ranked = lookup_models(
        endpoints,
        &ModelQuery {
            search: Some(search.to_owned()),
            limit: Some(1),
            threshold: Some(threshold),
            ..Default::default()
        },
    );
    let Some(top) = ranked.first() else {
        return ResolvedModel {
            model_id: search.to_owned(),
            matched: false,
            score: None,
        };
    };
    ResolvedModel {
        model_id: top.endpoint.name.clone(),
        matched: true,
        score: top.score,
    }
}

/// Build one same-family fallback candidate for each lower model version.
///
/// Exact variant tokens are preferred across versions. When a version does not
/// offer that variant, live AI Gateway profile scores select its highest-quality
/// endpoint without relying on provider-specific variant names.
pub fn same_family_fallbacks(
    endpoints: &[ServingEndpointSummary],
    selected: &ServingEndpointSummary,
    limit: usize,
) -> Vec<ServingEndpointSummary> {
    if limit == 0 {
        return Vec::new();
    }
    let selected_name = endpoint_model_identity(selected);
    let Some(selected_model) = parse_model_name(selected_name) else {
        return Vec::new();
    };
    if !selected_model.family.is_versioned() || selected_model.version.is_empty() {
        return Vec::new();
    }
    let selected_version = normalized_version(&selected_model.version);
    let mut versions = BTreeMap::<[u32; 3], Vec<(&ServingEndpointSummary, Vec<String>)>>::new();
    for endpoint in endpoints {
        if endpoint.name == selected.name
            || endpoint.status.deprecated
            || endpoint.task.as_deref() != Some(crate::classify::CHAT_TASK)
            || endpoint
                .state
                .as_deref()
                .is_some_and(|state| !state.eq_ignore_ascii_case("READY"))
        {
            continue;
        }
        let identity = endpoint_model_identity(endpoint);
        let Some(model) = parse_model_name(identity) else {
            continue;
        };
        let version = normalized_version(&model.version);
        if model.family != selected_model.family
            || model.version.is_empty()
            || version >= selected_version
        {
            continue;
        }
        versions
            .entry(version)
            .or_default()
            .push((endpoint, model.model));
    }

    versions
        .into_iter()
        .rev()
        .filter_map(|(_, mut candidates)| {
            candidates.sort_by(|left, right| {
                compare_fallback_candidate(
                    &selected_model.model,
                    left.0,
                    &left.1,
                    right.0,
                    &right.1,
                )
            });
            candidates
                .into_iter()
                .next()
                .map(|(endpoint, _)| endpoint.clone())
        })
        .take(limit)
        .collect()
}

fn token_distance(token: &str, name: &str) -> f64 {
    if name.contains(token) {
        return 0.0;
    }
    1.0 - NAME_SEGMENT_PATTERN
        .find_iter(name)
        .map(|segment| ratio(token, segment.as_str()))
        .fold(0.0, f64::max)
}

fn eligible_classes(model_class: Option<ModelClass>) -> Vec<ModelClass> {
    match model_class {
        Some(ModelClass::Embedding) => vec![ModelClass::Embedding],
        Some(model_class) => ModelClass::ORDER
            .into_iter()
            .skip(model_class.order())
            .filter(|candidate| *candidate != ModelClass::Embedding)
            .collect(),
        None => ModelClass::ORDER
            .into_iter()
            .filter(|candidate| *candidate != ModelClass::Embedding)
            .collect(),
    }
}

fn endpoint_supports_tools(endpoint: &ServingEndpointSummary) -> bool {
    endpoint
        .supports_tools
        .unwrap_or_else(|| supports_tools_by_family(&endpoint.name))
}

fn compare_ranked(left: &RankedModel, right: &RankedModel, versioned: bool) -> Ordering {
    let left_score = (left.score.unwrap_or(0.0) * 1000.0).round() as i64;
    let right_score = (right.score.unwrap_or(0.0) * 1000.0).round() as i64;
    left_score.cmp(&right_score).then_with(|| {
        compare_model_preference(
            &left.endpoint,
            left.model_class,
            &right.endpoint,
            right.model_class,
            versioned,
        )
    })
}

/// Compare equally matched models by version, preferred variant, and class.
pub(crate) fn compare_model_preference(
    left_endpoint: &ServingEndpointSummary,
    left_class: ModelClass,
    right_endpoint: &ServingEndpointSummary,
    right_class: ModelClass,
    versioned: bool,
) -> Ordering {
    (if versioned {
        version_tuple(&right_endpoint.name).cmp(&version_tuple(&left_endpoint.name))
    } else {
        Ordering::Equal
    })
    .then_with(|| {
        model_variant_rank(&left_endpoint.name).cmp(&model_variant_rank(&right_endpoint.name))
    })
    .then_with(|| left_class.order().cmp(&right_class.order()))
}

fn model_variant_rank(name: &str) -> u8 {
    let Some(parsed) = parse_model_name(name) else {
        return 2;
    };
    if parsed.family != ModelFamily::Gpt {
        return 2;
    }
    if parsed.model.iter().any(|part| part == "sol") {
        return 0;
    }
    if parsed.model.iter().any(|part| part == "luna") {
        return 1;
    }
    2
}

fn endpoint_model_identity(endpoint: &ServingEndpointSummary) -> &str {
    endpoint
        .model_service_name
        .as_deref()
        .unwrap_or(&endpoint.name)
}

fn normalized_version(version: &[u32]) -> [u32; 3] {
    [
        version.first().copied().unwrap_or_default(),
        version.get(1).copied().unwrap_or_default(),
        version.get(2).copied().unwrap_or_default(),
    ]
}

fn compare_fallback_candidate(
    selected_variant: &[String],
    left: &ServingEndpointSummary,
    left_variant: &[String],
    right: &ServingEndpointSummary,
    right_variant: &[String],
) -> Ordering {
    let left_exact = left_variant == selected_variant;
    let right_exact = right_variant == selected_variant;
    right_exact
        .cmp(&left_exact)
        .then_with(|| {
            optional_profile_number(right.profile.as_ref().and_then(|profile| profile.quality))
                .total_cmp(&optional_profile_number(
                    left.profile.as_ref().and_then(|profile| profile.quality),
                ))
        })
        .then_with(|| {
            left.model_class
                .map(ModelClass::order)
                .unwrap_or(ModelClass::ORDER.len())
                .cmp(
                    &right
                        .model_class
                        .map(ModelClass::order)
                        .unwrap_or(ModelClass::ORDER.len()),
                )
        })
        .then_with(|| {
            left.profile
                .as_ref()
                .and_then(|profile| profile.cost)
                .unwrap_or(f64::INFINITY)
                .total_cmp(
                    &right
                        .profile
                        .as_ref()
                        .and_then(|profile| profile.cost)
                        .unwrap_or(f64::INFINITY),
                )
        })
        .then_with(|| {
            optional_profile_number(right.profile.as_ref().and_then(|profile| profile.speed))
                .total_cmp(&optional_profile_number(
                    left.profile.as_ref().and_then(|profile| profile.speed),
                ))
        })
        .then_with(|| left.name.cmp(&right.name))
}

fn optional_profile_number(value: Option<f64>) -> f64 {
    value.unwrap_or(f64::NEG_INFINITY)
}
