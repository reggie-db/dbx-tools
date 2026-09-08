//! Flexible Lakebase PostgreSQL address parsing aligned with the Node parser.

use url::Url;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SslMode {
    Require,
    Disable,
    Prefer,
}

impl SslMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Require => "require",
            Self::Disable => "disable",
            Self::Prefer => "prefer",
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ParsedAddress {
    pub project: Option<String>,
    pub branch: Option<String>,
    pub endpoint: Option<String>,
    pub endpoint_id: Option<String>,
    pub database: Option<String>,
    pub database_resource_id: Option<String>,
    pub user: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub ssl_mode: Option<SslMode>,
}

pub fn parse_address(input: Option<&str>) -> ParsedAddress {
    let Some(value) = input.map(str::trim).filter(|value| !value.is_empty()) else {
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
        return parse_resource_path(Some(value));
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

pub fn parse_resource_path(input: Option<&str>) -> ParsedAddress {
    let Some(value) = input
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

pub fn parse_lakebase_address(value: &str) -> Result<ParsedAddress, AddressError> {
    let parsed = parse_address(Some(value));
    if parsed == ParsedAddress::default() {
        Err(AddressError::InvalidAddress(value.to_owned()))
    } else {
        Ok(parsed)
    }
}

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
    ParsedAddress {
        user: (!url.username().is_empty()).then(|| decode(url.username())),
        host: url.host_str().map(str::to_owned),
        port: url.port(),
        database: {
            let database = decode(url.path().trim_start_matches('/'));
            (!database.is_empty()).then_some(database)
        },
        ssl_mode,
        ..Default::default()
    }
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
pub enum AddressError {
    #[error("Lakebase address is not recognized: {0}")]
    InvalidAddress(String),
    #[error("invalid listener host {0}")]
    InvalidHost(String),
    #[error("invalid listener port {0}")]
    InvalidPort(u16),
}
