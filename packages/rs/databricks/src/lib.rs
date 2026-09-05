use std::collections::HashMap;

mod databricks_cli;

pub use databricks_cli::{databricks_cli_available, databricks_cli_token, DatabricksCliError};

const APP_ENV_OVERRIDE: &str = "DBX_TOOLS_DATABRICKS_APP_ENV";
const APP_NAME: &str = "DATABRICKS_APP_NAME";
const APP_HOST: &str = "DATABRICKS_HOST";
const APP_PORT: &str = "DATABRICKS_APP_PORT";

/// Detect whether the current process is running as a Databricks App.
#[uniffi::export]
pub fn is_databricks_app() -> bool {
    is_databricks_app_environment(&std::env::vars().collect())
}

/// Detect a Databricks App from a supplied environment map.
pub fn is_databricks_app_environment(environment: &HashMap<String, String>) -> bool {
    if let Some(override_value) = environment
        .get(APP_ENV_OVERRIDE)
        .and_then(|value| parse_boolean(value))
    {
        return override_value;
    }
    environment
        .get(APP_NAME)
        .is_some_and(|value| valid_value(value))
        && environment
            .get(APP_HOST)
            .is_some_and(|value| valid_http_url(value))
        && environment
            .get(APP_PORT)
            .is_some_and(|value| valid_port(value))
}

fn parse_boolean(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "t" | "on" | "1" | "yes" | "y" => Some(true),
        "false" | "f" | "off" | "0" | "no" | "n" => Some(false),
        _ => None,
    }
}

fn valid_value(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty() && !contains_interpolation(value)
}

fn contains_interpolation(value: &str) -> bool {
    value
        .match_indices("${")
        .any(|(index, _)| value[index + 2..].find('}').is_some_and(|end| end > 0))
}

fn valid_http_url(value: &str) -> bool {
    valid_value(value)
        && url::Url::parse(value.trim()).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}

fn valid_port(value: &str) -> bool {
    value.trim().parse::<u16>().is_ok_and(|port| port > 0)
}

uniffi::setup_scaffolding!();

#[cfg(test)]
mod tests {
    use super::*;

    fn app_environment() -> HashMap<String, String> {
        HashMap::from([
            (APP_NAME.into(), "example".into()),
            (
                APP_HOST.into(),
                "https://example.cloud.databricks.com".into(),
            ),
            (APP_PORT.into(), "8000".into()),
        ])
    }

    #[test]
    fn detects_valid_databricks_app_environment() {
        assert!(is_databricks_app_environment(&app_environment()));
    }

    #[test]
    fn recognized_override_takes_precedence() {
        let mut environment = app_environment();
        environment.insert(APP_ENV_OVERRIDE.into(), "off".into());
        assert!(!is_databricks_app_environment(&environment));

        environment.clear();
        environment.insert(APP_ENV_OVERRIDE.into(), "yes".into());
        assert!(is_databricks_app_environment(&environment));
    }

    #[test]
    fn invalid_override_falls_back_to_structural_detection() {
        let mut environment = app_environment();
        environment.insert(APP_ENV_OVERRIDE.into(), "automatic".into());
        assert!(is_databricks_app_environment(&environment));
    }

    #[test]
    fn rejects_missing_or_invalid_required_values() {
        for (key, value) in [
            (APP_NAME, ""),
            (APP_NAME, "${app.name}"),
            (APP_HOST, "example.cloud.databricks.com"),
            (APP_HOST, "ftp://example.com"),
            (APP_PORT, "0"),
            (APP_PORT, "65536"),
        ] {
            let mut environment = app_environment();
            environment.insert(key.into(), value.into());
            assert!(!is_databricks_app_environment(&environment));
        }
    }
}
