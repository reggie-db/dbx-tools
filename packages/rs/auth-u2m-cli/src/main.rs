use std::{path::PathBuf, sync::Arc, time::Duration};

use clap::{Args, Parser, Subcommand, ValueEnum};
use dbx_tools_auth_u2m::{
    open_store, AuthClient, AuthOptions, CredentialStore, Profile, ProfileOptions, StoreBackend,
    StoreOptions, TargetKind,
};
use serde::Serialize;
use time::Duration as TimeDuration;

#[cfg(feature = "postgres")]
mod postgres;

#[derive(Debug, Parser)]
#[command(
    name = "dbx-tools-auth-u2m",
    version,
    about = "Databricks browser OAuth with secure refresh-token storage"
)]
struct Cli {
    #[command(flatten)]
    common: CommonArgs,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Args)]
struct CommonArgs {
    #[arg(long, env = "DATABRICKS_CONFIG_PROFILE")]
    profile: Option<String>,
    #[arg(long, env = "DATABRICKS_HOST")]
    host: Option<String>,
    #[arg(long, env = "DATABRICKS_ACCOUNT_ID")]
    account_id: Option<String>,
    #[arg(long, env = "DATABRICKS_WORKSPACE_ID")]
    workspace_id: Option<String>,
    #[arg(long, env = "DATABRICKS_CONFIG_FILE")]
    config_file: Option<PathBuf>,
    #[arg(long, env = "DATABRICKS_CLIENT_ID")]
    client_id: Option<String>,
    #[arg(long, value_delimiter = ',')]
    scopes: Vec<String>,
    #[arg(long, env = "DBX_TOOLS_U2M_TARGET", value_enum)]
    target: Option<CliTarget>,
    #[arg(
        long,
        env = "DBX_TOOLS_U2M_STORAGE",
        value_enum,
        default_value = "auto"
    )]
    storage: CliStorage,
    #[arg(long, env = "DBX_TOOLS_U2M_CACHE_DIR")]
    cache_dir: Option<PathBuf>,
    #[arg(long, env = "DBX_TOOLS_U2M_POSTGRES_URL")]
    #[cfg(feature = "postgres")]
    postgres_url: Option<String>,
    #[arg(long, env = "DBX_TOOLS_U2M_LOCK_TIMEOUT_SECONDS", default_value_t = 30)]
    lock_timeout_seconds: u64,
    #[arg(
        long,
        env = "DBX_TOOLS_U2M_LOGIN_TIMEOUT_SECONDS",
        default_value_t = 3600
    )]
    login_timeout_seconds: u64,
    #[arg(
        long,
        env = "DBX_TOOLS_U2M_REFRESH_BUFFER_SECONDS",
        default_value_t = 300
    )]
    refresh_buffer_seconds: i64,
}

#[derive(Debug, Subcommand)]
enum Command {
    Login,
    Token {
        #[arg(long)]
        force_refresh: bool,
        #[arg(long)]
        login_if_missing: bool,
    },
    Logout,
    Status,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum CliStorage {
    Auto,
    Memory,
    File,
    Keyring,
    #[cfg(feature = "postgres")]
    Postgres,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum CliTarget {
    Workspace,
    Account,
    Unified,
}

#[derive(Serialize)]
struct Status<'a> {
    profile: &'a str,
    host: String,
    storage: &'static str,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> dbx_tools_auth_u2m::Result<()> {
    let cli = Cli::parse();
    let store = open_cli_store(&cli.common).await?;
    let profile = Profile::from_sources(ProfileOptions {
        profile: cli.common.profile.clone(),
        host: cli.common.host.clone(),
        account_id: cli.common.account_id.clone(),
        workspace_id: cli.common.workspace_id.clone(),
        client_id: cli.common.client_id.clone(),
        scopes: (!cli.common.scopes.is_empty()).then_some(cli.common.scopes.clone()),
        target: cli.common.target.map(Into::into),
        config_file: cli.common.config_file.clone(),
    })?;
    let client = AuthClient::new(
        profile,
        store,
        AuthOptions {
            refresh_buffer: TimeDuration::seconds(cli.common.refresh_buffer_seconds),
            lock_timeout: Duration::from_secs(cli.common.lock_timeout_seconds),
            login_timeout: Duration::from_secs(cli.common.login_timeout_seconds),
        },
    )?;

    match cli.command {
        Command::Login => print_json(&client.login().await?)?,
        Command::Token {
            force_refresh,
            login_if_missing,
        } => {
            let token = if force_refresh {
                client.force_refresh().await?
            } else if login_if_missing {
                client.token_or_login().await?
            } else {
                client.token().await?
            };
            print_json(&token)?;
        }
        Command::Logout => client.logout().await?,
        Command::Status => print_json(&Status {
            profile: &client.profile().name,
            host: client.profile().host.to_string(),
            storage: client.store_name(),
        })?,
    }
    Ok(())
}

fn print_json(value: &impl Serialize) -> dbx_tools_auth_u2m::Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

impl From<CliStorage> for StoreBackend {
    fn from(value: CliStorage) -> Self {
        match value {
            CliStorage::Auto => Self::Auto,
            CliStorage::Memory => Self::Memory,
            CliStorage::File => Self::File,
            CliStorage::Keyring => Self::Keyring,
            #[cfg(feature = "postgres")]
            CliStorage::Postgres => unreachable!("Postgres is opened by the CLI adapter"),
        }
    }
}

async fn open_cli_store(
    common: &CommonArgs,
) -> dbx_tools_auth_u2m::Result<Arc<dyn CredentialStore>> {
    #[cfg(feature = "postgres")]
    if matches!(common.storage, CliStorage::Postgres) || common.postgres_url.is_some() {
        let url = common.postgres_url.as_deref().ok_or_else(|| {
            dbx_tools_auth_u2m::Error::Config(
                "Postgres storage requires DBX_TOOLS_U2M_POSTGRES_URL".into(),
            )
        })?;
        return Ok(Arc::new(postgres::PostgresStore::connect(url).await?));
    }

    open_store(StoreOptions {
        backend: Some(common.storage.into()),
        cache_dir: common.cache_dir.clone(),
        config_file: common.config_file.clone(),
    })
    .await
}

impl From<CliTarget> for TargetKind {
    fn from(value: CliTarget) -> Self {
        match value {
            CliTarget::Workspace => Self::Workspace,
            CliTarget::Account => Self::Account,
            CliTarget::Unified => Self::Unified,
        }
    }
}
