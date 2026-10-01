//! Shared structured logging initialization for Rust binaries.

use tracing_subscriber::{filter::LevelFilter, fmt, EnvFilter};

/// Environment variable controlling dbx-tools Rust log verbosity.
pub const LOG_LEVEL_ENV: &str = "LOG_LEVEL";
/// Log level used when [`LOG_LEVEL_ENV`] is absent or invalid.
pub const DEFAULT_LOG_LEVEL: &str = "info";

/// Install the shared tracing subscriber for dbx-tools Rust binaries.
///
/// Debug output includes source locations to make low-level diagnostics
/// actionable without adding noise to the default info-level format.
pub fn init_logging() -> Result<(), LoggingError> {
    init_logging_with_verbose(false)
}

/// Install logging, using debug as the default when verbose mode is requested.
///
/// An explicit [`LOG_LEVEL_ENV`] value always takes precedence.
pub fn init_logging_with_verbose(verbose: bool) -> Result<(), LoggingError> {
    let level = resolved_log_level(std::env::var(LOG_LEVEL_ENV).ok().as_deref(), verbose);
    let filter = EnvFilter::new(format!(
        "warn,dbx_tools={level},dbx_model_proxy={level},dbx_lakebase_proxy={level}"
    ));
    fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_file(level == LevelFilter::DEBUG)
        .with_line_number(level == LevelFilter::DEBUG)
        .try_init()
        .map_err(|error| LoggingError::Initialize(error.to_string()))
}

fn resolved_log_level(value: Option<&str>, verbose: bool) -> LevelFilter {
    value.map_or_else(
        || {
            if verbose {
                LevelFilter::DEBUG
            } else {
                LevelFilter::INFO
            }
        },
        |value| parse_log_level(Some(value)),
    )
}

/// Parse the supported four-level log vocabulary.
pub fn parse_log_level(value: Option<&str>) -> LevelFilter {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("debug") => LevelFilter::DEBUG,
        Some("warn") => LevelFilter::WARN,
        Some("error") => LevelFilter::ERROR,
        Some("info") => LevelFilter::INFO,
        _ => LevelFilter::INFO,
    }
}

#[derive(Debug, thiserror::Error)]
/// Logging initialization errors.
pub enum LoggingError {
    /// Another subscriber is installed or tracing setup otherwise failed.
    #[error("could not initialize logging: {0}")]
    Initialize(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_level_is_trimmed_case_insensitive_and_defaults_to_info() {
        assert_eq!(parse_log_level(Some(" DEBUG ")), LevelFilter::DEBUG);
        assert_eq!(parse_log_level(Some("warn")), LevelFilter::WARN);
        assert_eq!(parse_log_level(Some("ERROR")), LevelFilter::ERROR);
        assert_eq!(parse_log_level(Some("")), LevelFilter::INFO);
        assert_eq!(parse_log_level(Some("trace")), LevelFilter::INFO);
        assert_eq!(parse_log_level(None), LevelFilter::INFO);
        assert_eq!(resolved_log_level(None, true), LevelFilter::DEBUG);
        assert_eq!(resolved_log_level(Some("warn"), true), LevelFilter::WARN);
    }
}
