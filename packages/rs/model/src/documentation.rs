//! Shared Databricks documentation loading and generated-snapshot persistence.

use std::{
    fmt::Display,
    future::Future,
    io::Write,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use dbx_tools_core::{FileCache, FileCacheError};
use scraper::ElementRef;
use serde::{de::DeserializeOwned, Deserialize, Serialize};

/// Cached documentation value plus non-fatal refresh errors.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct CachedDocumentation<T> {
    value: T,
    errors: Vec<String>,
}

impl<T> CachedDocumentation<T> {
    /// Create a cache envelope from a value and refresh errors.
    pub(crate) fn new(value: T, errors: Vec<String>) -> Self {
        Self { value, errors }
    }

    /// Keep a fallback value when a documentation load fails.
    pub(crate) fn from_result<E: Display>(result: Result<T, E>, fallback: T) -> Self {
        match result {
            Ok(value) => Self::new(value, Vec::new()),
            Err(error) => Self::new(fallback, vec![error.to_string()]),
        }
    }
}

/// Resolve one cached documentation envelope and emit its fallback warnings.
pub(crate) async fn cached_documentation<T, E, Load, Fut>(
    cache: &FileCache,
    label: &'static str,
    load: Load,
) -> Result<T, E>
where
    T: Clone + DeserializeOwned + Serialize + Send + 'static,
    E: From<FileCacheError>,
    Load: FnOnce() -> Fut,
    Fut: Future<Output = Result<CachedDocumentation<T>, E>>,
{
    let snapshot = cache.get_or_try_init(load).await?;
    for error in snapshot.errors {
        tracing::warn!(
            source = label,
            error,
            "Databricks documentation refresh failed; using generated fallback"
        );
    }
    Ok(snapshot.value)
}

pub(crate) async fn load_page(
    client: &reqwest::Client,
    url: &str,
    user_agent: &str,
) -> Result<String, DocumentationError> {
    let response = client
        .get(url)
        .header("user-agent", user_agent)
        .timeout(Duration::from_secs(15))
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        return Err(DocumentationError::HttpStatus(status.as_u16()));
    }
    Ok(response.text().await?)
}

pub(crate) fn collapse_text(element: ElementRef<'_>) -> String {
    element
        .text()
        .flat_map(str::split_whitespace)
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn unix_timestamp() -> Result<u64, DocumentationError> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}

pub(crate) fn read_snapshot<T: DeserializeOwned>(path: &Path) -> Option<T> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

pub(crate) fn snapshot_is_fresh(generated_at: u64, now: u64, ttl: Duration) -> bool {
    now.saturating_sub(generated_at) < ttl.as_secs()
}

pub(crate) fn write_snapshot<T: Serialize>(
    path: &Path,
    value: &T,
) -> Result<(), DocumentationError> {
    let parent = path.parent().ok_or(DocumentationError::MissingParent)?;
    std::fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(&serde_json::to_vec_pretty(value)?)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map_err(|error| DocumentationError::Io(error.error))?;
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum DocumentationError {
    #[error("Databricks documentation returned HTTP {0}")]
    HttpStatus(u16),
    #[error("Databricks documentation request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("generated snapshot path has no parent directory")]
    MissingParent,
    #[error("generated snapshot I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("generated snapshot JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("system time is before the Unix epoch: {0}")]
    Time(#[from] std::time::SystemTimeError),
}
