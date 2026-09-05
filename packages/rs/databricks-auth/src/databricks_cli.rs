use std::{
    process::{Command, Stdio},
    sync::OnceLock,
    time::Duration,
};

use dbx_tools_auth::{Result, Token, TokenProvider};

use crate::{Error, OAuthFlow};

static DATABRICKS_CLI_AVAILABLE: OnceLock<bool> = OnceLock::new();

/// Whether `databricks auth --help` succeeds in this process environment.
#[uniffi::export]
pub fn databricks_cli_available() -> bool {
    *DATABRICKS_CLI_AVAILABLE.get_or_init(|| {
        Command::new(databricks_executable())
            .args(["auth", "--help"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    })
}

pub(crate) struct DatabricksCliFlow {
    native: OAuthFlow,
    profile: String,
}

impl DatabricksCliFlow {
    pub(crate) fn new(native: OAuthFlow, profile: String) -> Self {
        Self { native, profile }
    }

    async fn token(&self, force_refresh: bool) -> Result<Token> {
        let executable = databricks_executable();
        let profile = self.profile.clone();
        tokio::task::spawn_blocking(move || {
            let output = token_command(executable, &profile, force_refresh).output()?;
            if !output.status.success() {
                let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
                return Err(Error::OAuth(if detail.is_empty() {
                    format!("databricks auth token exited {}", output.status)
                } else {
                    detail
                }));
            }
            parse_token(&output.stdout)
        })
        .await
        .map_err(|error| Error::OAuth(format!("databricks auth token task failed: {error}")))?
    }
}

#[async_trait::async_trait]
impl TokenProvider for DatabricksCliFlow {
    async fn authenticate(&self, _timeout: Duration) -> Result<Token> {
        self.token(false).await
    }

    async fn login(&self, timeout: Duration) -> Result<Token> {
        self.native.login(timeout).await
    }

    async fn refresh(&self, _token: &Token) -> Result<Token> {
        self.token(true).await
    }

    fn can_authenticate_silently(&self) -> bool {
        true
    }
}

fn databricks_executable() -> std::ffi::OsString {
    std::env::var_os("DATABRICKS_CLI_PATH").unwrap_or_else(|| "databricks".into())
}

fn token_command(executable: std::ffi::OsString, profile: &str, force_refresh: bool) -> Command {
    let mut command = Command::new(executable);
    command.args(["auth", "token", "--profile", profile, "--output", "json"]);
    if force_refresh {
        command.arg("--force-refresh");
    }
    command
}

fn parse_token(output: &[u8]) -> Result<Token> {
    serde_json::from_slice(output).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn databricks_cli_token_uses_profile_and_json_output() {
        let command = token_command("databricks".into(), "PROFILE", true);
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "auth",
                "token",
                "--profile",
                "PROFILE",
                "--output",
                "json",
                "--force-refresh",
            ]
        );
    }

    #[test]
    fn parses_databricks_cli_token_json() {
        let token = parse_token(
            br#"{"access_token":"access","token_type":"Bearer","refresh_token":"refresh","expiry":"2026-09-05T13:00:00Z","scopes":["all-apis","offline_access"]}"#,
        )
        .unwrap();
        assert_eq!(token.access_token, "access");
        assert_eq!(token.refresh_token.as_deref(), Some("refresh"));
        assert_eq!(token.scopes, ["all-apis", "offline_access"]);
    }
}
