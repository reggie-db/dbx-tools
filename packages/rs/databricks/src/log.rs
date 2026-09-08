//! Shared structured logging initialization for Rust binaries.

use tracing_subscriber::{filter::LevelFilter, fmt, EnvFilter};

pub const LOG_LEVEL_ENV: &str = "LOG_LEVEL";
pub const DEFAULT_LOG_LEVEL: &str = "info";

pub fn init_logging() -> Result<(), LoggingError> {
    let level = parse_log_level(std::env::var(LOG_LEVEL_ENV).ok().as_deref());
    let filter = EnvFilter::new(format!(
        "warn,dbx_tools={level},dbx_model_proxy={level},dbx_lakebase_proxy={level}"
    ));
    fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init()
        .map_err(|error| LoggingError::Initialize(error.to_string()))
}

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
pub enum LoggingError {
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
    }
}
