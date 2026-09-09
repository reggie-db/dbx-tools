//! Flexible Lakebase PostgreSQL address parsing aligned with the Node parser.

use url::Url;

/// PostgreSQL TLS modes recognized in Lakebase connection URLs.
#[derive(Clone, Copy, Debug, Eq, PartialEq, uniffi::Enum)]
pub enum SslMode {
    /// Require a TLS connection.
    Require,
    /// Disable TLS for a local proxy connection.
    Disable,
    /// Prefer TLS when the server supports it.
    Prefer,
}

impl SslMode {
    /// Return the PostgreSQL `sslmode` spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Require => "require",
            Self::Disable => "disable",
            Self::Prefer => "prefer",
        }
    }
}

/// Connection and resource fields recovered from a Lakebase address.
#[derive(Clone, Debug, Default, Eq, PartialEq, uniffi::Record)]
pub struct ParsedAddress {
    /// Lakebase Postgres project identifier.
    pub project: Option<String>,
    /// Branch identifier within the project.
    pub branch: Option<String>,
    /// Canonical endpoint resource path.
    pub endpoint: Option<String>,
    /// Endpoint leaf identifier.
    pub endpoint_id: Option<String>,
    /// PostgreSQL database name.
    pub database: Option<String>,
    /// Database resource leaf identifier.
    pub database_resource_id: Option<String>,
    /// PostgreSQL user or Databricks profile from a URL.
    pub user: Option<String>,
    /// Endpoint or local proxy host.
    pub host: Option<String>,
    /// PostgreSQL port.
    pub port: Option<u16>,
    /// PostgreSQL TLS mode.
    pub ssl_mode: Option<SslMode>,
}

/// Parse a PostgreSQL URL, Lakebase resource path, hostname, or project id.
#[uniffi::export]
pub fn parse_address(input: Option<String>) -> ParsedAddress {
    let Some(value) = input
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return ParsedAddress::default();
    };
    if value.split_once("://").is_some_and(|(scheme, _)| {
        matches!(
            scheme.to_ascii_lowercase().as_str(),
            "postgres" | "postgresql"
        )
    }) {
        return parse_uri(value);
    }
    if value.starts_with("projects/") {
        return parse_resource_path(Some(value.to_owned()));
    }
    if is_hostname(value) {
        return ParsedAddress {
            host: Some(value.to_owned()),
            ..Default::default()
        };
    }
    if is_project_id(value) {
        return ParsedAddress {
            project: Some(value.to_owned()),
            ..Default::default()
        };
    }
    ParsedAddress::default()
}

/// Parse a canonical Lakebase `projects/...` resource path.
#[uniffi::export]
pub fn parse_resource_path(input: Option<String>) -> ParsedAddress {
    let Some(value) = input
        .as_deref()
        .map(str::trim)
        .filter(|value| value.starts_with("projects/"))
    else {
        return ParsedAddress::default();
    };
    let parts = value.split('/').collect::<Vec<_>>();
    let Some(project) = parts.get(1).copied().filter(|project| !project.is_empty()) else {
        return ParsedAddress::default();
    };
    match parts.as_slice() {
        ["projects", _] => ParsedAddress {
            project: Some(project.to_owned()),
            ..Default::default()
        },
        ["projects", _, "branches", branch] if !branch.is_empty() => ParsedAddress {
            project: Some(project.to_owned()),
            branch: Some((*branch).to_owned()),
            ..Default::default()
        },
        ["projects", _, "branches", branch, "endpoints", endpoint]
            if !branch.is_empty() && !endpoint.is_empty() =>
        {
            ParsedAddress {
                project: Some(project.to_owned()),
                branch: Some((*branch).to_owned()),
                endpoint: Some(value.to_owned()),
                endpoint_id: Some((*endpoint).to_owned()),
                ..Default::default()
            }
        }
        ["projects", _, "branches", branch, "databases", database]
            if !branch.is_empty() && !database.is_empty() =>
        {
            ParsedAddress {
                project: Some(project.to_owned()),
                branch: Some((*branch).to_owned()),
                database_resource_id: Some((*database).to_owned()),
                ..Default::default()
            }
        }
        _ => ParsedAddress::default(),
    }
}

/// Parse a required Lakebase target and reject unrecognized values.
pub fn parse_lakebase_address(value: &str) -> Result<ParsedAddress, AddressError> {
    let parsed = parse_address(Some(value.to_owned()));
    if parsed == ParsedAddress::default() {
        Err(AddressError::InvalidAddress(value.to_owned()))
    } else {
        Ok(parsed)
    }
}

/// Build a local PostgreSQL URL that preserves a Lakebase target in its path.
pub fn connection_url(target: &str, host: &str, port: u16) -> Result<String, AddressError> {
    parse_lakebase_address(target)?;
    let mut url = Url::parse("postgresql://localhost").expect("static PostgreSQL URL is valid");
    url.set_host(Some(host))
        .map_err(|_| AddressError::InvalidHost(host.to_owned()))?;
    url.set_port(Some(port))
        .map_err(|_| AddressError::InvalidPort(port))?;
    url.set_path(target.trim().trim_start_matches('/'));
    url.query_pairs_mut().append_pair("sslmode", "disable");
    Ok(url.into())
}

fn parse_uri(value: &str) -> ParsedAddress {
    let Ok(url) = Url::parse(value) else {
        return ParsedAddress::default();
    };
    if !matches!(
        url.scheme().to_ascii_lowercase().as_str(),
        "postgres" | "postgresql"
    ) {
        return ParsedAddress::default();
    }
    let decode = |value: &str| {
        percent_encoding::percent_decode_str(value)
            .decode_utf8()
            .map(|value| value.into_owned())
            .unwrap_or_else(|_| value.to_owned())
    };
    let ssl_mode = url
        .query_pairs()
        .find(|(name, _)| name.eq_ignore_ascii_case("sslmode"))
        .and_then(|(_, value)| match value.to_ascii_lowercase().as_str() {
            "require" => Some(SslMode::Require),
            "disable" => Some(SslMode::Disable),
            "prefer" => Some(SslMode::Prefer),
            _ => None,
        });
    let target = decode(url.path().trim_start_matches('/'));
    let mut parsed = parse_resource_path(Some(target.clone()));
    if parsed == ParsedAddress::default() && !target.is_empty() {
        parsed.database = Some(target);
    }
    parsed.user = (!url.username().is_empty()).then(|| decode(url.username()));
    parsed.host = url.host_str().map(str::to_owned);
    parsed.port = url.port();
    parsed.ssl_mode = ssl_mode;
    parsed
}

fn is_hostname(value: &str) -> bool {
    value.contains('.')
        && value.split('.').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '-')
        })
}

fn is_project_id(value: &str) -> bool {
    (1..=63).contains(&value.len())
        && value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_lowercase())
        && value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
        && value
            .chars()
            .last()
            .is_some_and(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
}

#[derive(Debug, thiserror::Error)]
/// Errors returned while validating and formatting Lakebase addresses.
pub enum AddressError {
    /// The target is not a supported URL, resource path, hostname, or project id.
    #[error("Lakebase address is not recognized: {0}")]
    InvalidAddress(String),
    /// The local listener host is invalid.
    #[error("invalid listener host {0}")]
    InvalidHost(String),
    /// The local listener port is invalid.
    #[error("invalid listener port {0}")]
    InvalidPort(u16),
}
