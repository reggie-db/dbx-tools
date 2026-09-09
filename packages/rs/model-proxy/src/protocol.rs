//! Client and upstream wire protocol selection.

use clap::ValueEnum;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ClientWire {
    Chat,
    Responses,
    Anthropic,
}

/// Databricks output protocol selected for requests.
#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub(crate) enum TargetWire {
    Auto,
    Chat,
    Responses,
}

pub(crate) fn is_codex_originator(value: &str) -> bool {
    value.trim().to_ascii_lowercase().starts_with("codex")
}
