use std::{
    process::{Command, Stdio},
    sync::OnceLock,
    time::Duration,
};

static DATABRICKS_CLI_AVAILABLE: OnceLock<bool> = OnceLock::new();

/// Failures returned while invoking the Databricks CLI.
#[derive(Debug, thiserror::Error)]
pub enum DatabricksCliError {
    /// The CLI process could not be started or read.
    #[error("could not run Databricks CLI: {0}")]
    Io(#[from] std::io::Error),
    /// The CLI returned an unsuccessful status and diagnostic.
    #[error("{0}")]
    Command(String),
}

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

/// Run interactive Databricks CLI login for one profile.
pub fn databricks_cli_login(profile: &str, timeout: Duration) -> Result<(), DatabricksCliError> {
    let status = login_command(databricks_executable(), profile, timeout).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(DatabricksCliError::Command(format!(
            "databricks auth login exited {status}"
        )))
    }
}

/// Request one profile token from the Databricks CLI as its JSON response bytes.
pub fn databricks_cli_token(
    profile: &str,
    force_refresh: bool,
) -> Result<Vec<u8>, DatabricksCliError> {
    let output = token_command(databricks_executable(), profile, force_refresh).output()?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Err(DatabricksCliError::Command(if detail.is_empty() {
        format!("databricks auth token exited {}", output.status)
    } else {
        detail
    }))
}

fn databricks_executable() -> std::ffi::OsString {
    std::env::var_os("DATABRICKS_CLI_PATH").unwrap_or_else(|| "databricks".into())
}

fn login_command(executable: std::ffi::OsString, profile: &str, timeout: Duration) -> Command {
    let mut command = Command::new(executable);
    command.args([
        "auth",
        "login",
        "--profile",
        profile,
        "--timeout",
        &format!("{}s", timeout.as_secs()),
    ]);
    command
}

fn token_command(executable: std::ffi::OsString, profile: &str, force_refresh: bool) -> Command {
    let mut command = Command::new(executable);
    command.args(["auth", "token", "--profile", profile, "--output", "json"]);
    if force_refresh {
        command.arg("--force-refresh");
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_command_uses_profile_json_and_force_refresh() {
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
    fn login_command_uses_profile_and_timeout() {
        let command = login_command("databricks".into(), "PROFILE", Duration::from_secs(900));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            ["auth", "login", "--profile", "PROFILE", "--timeout", "900s"]
        );
    }
}
