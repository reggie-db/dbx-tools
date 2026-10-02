//! Client and upstream wire protocol selection.

use clap::ValueEnum;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ClientWire {
    Chat,
    Responses,
    Anthropic,
}

impl ClientWire {
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Responses => "responses",
            Self::Anthropic => "anthropic",
        }
    }
}

/// Databricks output protocol selected for requests.
#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub(crate) enum TargetWire {
    Auto,
    Chat,
    Responses,
}

impl TargetWire {
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Chat => "chat",
            Self::Responses => "responses",
        }
    }
}

pub(crate) fn is_codex_originator(value: &str) -> bool {
    value.trim().to_ascii_lowercase().starts_with("codex")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_labels_are_lowercase_wire_values() {
        assert_eq!(ClientWire::Chat.label(), "chat");
        assert_eq!(ClientWire::Responses.label(), "responses");
        assert_eq!(ClientWire::Anthropic.label(), "anthropic");
        assert_eq!(TargetWire::Auto.label(), "auto");
        assert_eq!(TargetWire::Chat.label(), "chat");
        assert_eq!(TargetWire::Responses.label(), "responses");
    }
}
