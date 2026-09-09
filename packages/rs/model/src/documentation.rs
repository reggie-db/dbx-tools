//! Shared Databricks documentation loading and generated-snapshot persistence.

use std::{
    io::Write,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use scraper::ElementRef;
use serde::{de::DeserializeOwned, Serialize};

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
