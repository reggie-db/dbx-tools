//! Databricks Lakebase discovery and per-connection credentials.

mod credential;
mod discovery;
mod session;

use dbx_tools_databricks::{DatabricksAuthOptions, DatabricksClientError, ParsedAddress};

pub use discovery::ResolvedLakebase;

use self::{discovery::LakebaseDiscoveryCache, session::DatabricksSessionCache};

/// Databricks client for Lakebase resource discovery and database credentials.
#[derive(Clone)]
pub struct LakebaseClient {
    sessions: DatabricksSessionCache,
    discovery: LakebaseDiscoveryCache,
}

impl LakebaseClient {
    /// Create a Lakebase client with automatic Databricks authentication.
    pub fn new() -> Self {
        Self::with_auth_options(DatabricksAuthOptions::default())
    }

    /// Create a Lakebase client with explicit Databricks authentication options.
    pub fn with_auth_options(auth_options: DatabricksAuthOptions) -> Self {
        Self {
            sessions: DatabricksSessionCache::new(auth_options),
            discovery: LakebaseDiscoveryCache::new(),
        }
    }

    /// Resolve a Lakebase address into concrete Postgres connection metadata.
    pub async fn resolve_lakebase(
        &self,
        profile: Option<&str>,
        target: &ParsedAddress,
    ) -> Result<ResolvedLakebase, DatabricksError> {
        self.discovery
            .resolve(&self.sessions, profile, target)
            .await
    }

    /// Generate a short-lived Postgres password for a Lakebase endpoint.
    pub async fn generate_database_credential(
        &self,
        profile: Option<&str>,
        endpoint: &str,
    ) -> Result<String, DatabricksError> {
        credential::generate_database_credential(&self.sessions, profile, endpoint).await
    }
}

impl Default for LakebaseClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Errors produced by Lakebase discovery and credential generation.
#[derive(Debug, thiserror::Error)]
pub enum DatabricksError {
    /// A Databricks API or authentication request failed.
    #[error(transparent)]
    Client(#[from] DatabricksClientError),
    /// Lakebase resources could not be selected unambiguously.
    #[error("Databricks discovery failed: {0}")]
    Discovery(String),
    /// A Databricks API response omitted required Lakebase metadata.
    #[error("Databricks API response is invalid: {0}")]
    InvalidResponse(String),
}
