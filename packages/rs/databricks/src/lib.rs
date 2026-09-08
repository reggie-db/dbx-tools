//! Databricks runtime, authentication, caching, and filesystem primitives.

mod auth;
mod client;
mod credentials;
mod databricks_cli;
mod file_cache;
mod file_lock;
pub mod lakebase_address;
pub mod log;
mod oauth;
mod runtime;

pub use auth::*;
pub use client::{DatabricksClient, DatabricksClientError};
pub use credentials::*;
pub use databricks_cli::{databricks_cli_available, databricks_cli_token, DatabricksCliError};
pub use file_cache::{platform_cache_root, FileCache, FileCacheError};
pub use file_lock::{FileLock, FileLockError};
pub use lakebase_address::{
    connection_url, parse_address, parse_lakebase_address, parse_resource_path, AddressError,
    ParsedAddress, SslMode,
};
pub use log::{init_logging, parse_log_level, LoggingError, DEFAULT_LOG_LEVEL, LOG_LEVEL_ENV};
pub use oauth::*;
pub use runtime::{is_databricks_app, is_databricks_app_environment};

uniffi::setup_scaffolding!();
