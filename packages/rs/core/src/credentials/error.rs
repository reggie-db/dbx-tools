use thiserror::Error;

#[derive(Debug, Error)]
/// Error returned by credential acquisition, renewal, and storage operations.
pub enum Error {
    /// Credential or provider configuration is invalid.
    #[error("configuration error: {0}")]
    Config(String),
    /// The selected provider does not support an OAuth operation.
    #[error("OAuth is not supported by {0}")]
    OAuthNotSupported(String),
    /// An OAuth authorization or token exchange failed.
    #[error("OAuth error: {0}")]
    OAuth(String),
    /// A credential-store operation failed.
    #[error("credential storage error: {0}")]
    Storage(String),
    /// The named credential lock was not acquired before its timeout.
    #[error("timed out waiting for credential lock {0}")]
    LockTimeout(String),
    /// The named credential requires an explicit browser login.
    #[error("browser login is required for credential {0}")]
    LoginRequired(String),
    /// A filesystem or network I/O operation failed.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// Credential JSON could not be serialized or parsed.
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    /// A configured URL could not be parsed.
    #[error(transparent)]
    Url(#[from] url::ParseError),
    /// An HTTP client or request failed.
    #[error(transparent)]
    Http(#[from] reqwest::Error),
}

/// Result type used by credential and OAuth operations.
pub type Result<T> = std::result::Result<T, Error>;
