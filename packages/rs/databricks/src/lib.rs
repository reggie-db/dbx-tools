//! Databricks runtime, authentication, caching, and filesystem primitives.

mod auth;
mod credentials;
mod databricks_cli;
mod file_cache;
mod file_lock;
mod oauth;
mod runtime;

pub use auth::*;
pub use credentials::*;
pub use databricks_cli::{databricks_cli_available, databricks_cli_token, DatabricksCliError};
pub use file_cache::{platform_cache_root, FileCache, FileCacheError};
pub use file_lock::{FileLock, FileLockError};
pub use oauth::*;
pub use runtime::{is_databricks_app, is_databricks_app_environment};

uniffi::setup_scaffolding!();
