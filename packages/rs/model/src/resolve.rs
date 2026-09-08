//! Fuzzy model search, ranking, and resolution.

use std::{cmp::Ordering, sync::LazyLock};

use difflib_fast::ratio;
use regex::Regex;

use crate::{
    classify::{classify_endpoints, supports_tools_by_family},
    models::{
        parse_model_name, version_tuple, ModelClass, ModelFamily, ModelQuery, RankedModel,
        ResolvedModel, ServingEndpointSummary,
    },
};

pub const DEFAULT_FUZZY_THRESHOLD: f64 = 0.4;

static SEARCH_TOKEN_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[a-zA-Z0-9]+").expect("valid search token pattern"));
static NAME_SEGMENT_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[a-z0-9]+").expect("valid name segment pattern"));

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

pub fn lookup_models(endpoints: &[ServingEndpointSummary], query: &ModelQuery) -> Vec<RankedModel> {
    let summaries = endpoints
        .iter()
        .filter(|endpoint| query.include_deprecated || !endpoint.status.deprecated)
        .cloned()
        .collect::<Vec<_>>();
    let eligible = eligible_classes(query.model_class);
    let mut candidates = classify_endpoints(&summaries)
        .into_iter()
        .filter(|(model_class, endpoint)| {
            eligible.contains(model_class)
                && (!query.requires_tools || endpoint_supports_tools(endpoint))
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
        candidates.truncate(limit);
    }
    candidates
}

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
    left_score
        .cmp(&right_score)
        .then_with(|| {
            if versioned {
                version_tuple(&right.endpoint.name).cmp(&version_tuple(&left.endpoint.name))
            } else {
                Ordering::Equal
            }
        })
        .then_with(|| {
            model_variant_rank(&left.endpoint.name).cmp(&model_variant_rank(&right.endpoint.name))
        })
        .then_with(|| left.model_class.order().cmp(&right.model_class.order()))
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
