use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("configuration error: {0}")]
    Config(String),
    #[error("OAuth is not supported by {0}")]
    OAuthNotSupported(String),
    #[error("OAuth error: {0}")]
    OAuth(String),
    #[error("credential storage error: {0}")]
    Storage(String),
    #[error("timed out waiting for credential lock for profile {0}")]
    LockTimeout(String),
    #[error("browser login is required for profile {0}")]
    LoginRequired(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Url(#[from] url::ParseError),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
