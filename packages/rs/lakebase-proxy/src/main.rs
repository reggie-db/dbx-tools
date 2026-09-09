use std::{
    net::IpAddr,
    sync::Arc,
    time::{Duration, Instant},
};

use clap::{Parser, Subcommand};
use dbx_tools_core::{connection_url, init_logging, DatabricksAuthOptions};
use dbx_tools_lakebase_proxy::{
    databricks::LakebaseClient,
    proxy::{report_connection_stats, ConnectionStats, PostgresProxy},
};
use tokio::{net::TcpListener, task::JoinSet};
use tracing::{error, info};

#[derive(Debug, Parser)]
#[command(name = "dbx-lakebase-proxy", version)]
struct Cli {
    #[arg(long, default_value = "127.0.0.1")]
    host: IpAddr,
    #[arg(long, default_value_t = 5432)]
    port: u16,
    #[arg(long, default_value_t = 30)]
    startup_timeout_seconds: u64,
    #[arg(long, env = "DATABRICKS_CONFIG_PROFILE")]
    profile: Option<String>,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Format a local PostgreSQL URL for one Lakebase address.
    Url {
        #[arg(long)]
        target: Option<String>,
        #[arg(long, env = "LAKEBASE_ENDPOINT")]
        endpoint: Option<String>,
        #[arg(long, default_value = "localhost")]
        host: String,
        #[arg(long, default_value_t = 5432)]
        port: u16,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    init_logging()?;
    let Cli {
        host: listen_host,
        port: listen_port,
        startup_timeout_seconds,
        profile,
        command,
    } = Cli::parse();
    if let Some(Command::Url {
        target,
        endpoint,
        host,
        port,
    }) = command
    {
        let target = target
            .or(endpoint)
            .ok_or("url requires --target or LAKEBASE_ENDPOINT")?;
        println!("{}", connection_url(&target, &host, port)?);
        return Ok(());
    }
    if !listen_host.is_loopback() {
        return Err("Postgres proxy listener must use a loopback address".into());
    }
    let listener = TcpListener::bind((listen_host, listen_port)).await?;
    let proxy = PostgresProxy::new(LakebaseClient::with_auth_options(DatabricksAuthOptions {
        profile,
        ..Default::default()
    }))?;
    let startup_timeout = Duration::from_secs(startup_timeout_seconds);
    let mut tasks = JoinSet::new();
    let stats = Arc::new(ConnectionStats::default());
    tokio::spawn(report_connection_stats(Arc::clone(&stats)));
    info!(address = %listener.local_addr()?, "Lakebase proxy listening");
    loop {
        tokio::select! {
            result = listener.accept() => {
                let (socket, peer) = result?;
                let proxy = proxy.clone();
                let stats = Arc::clone(&stats);
                tasks.spawn(async move {
                    stats.connection_opened(peer);
                    let started = Instant::now();
                    match proxy.handle(socket, startup_timeout).await {
                        Ok(()) => {
                            stats.connection_closed(peer, started.elapsed(), false, None)
                        }
                        Err(error) => {
                            stats.connection_closed(
                                peer,
                                started.elapsed(),
                                true,
                                Some(&error.to_string()),
                            )
                        }
                    }
                });
            }
            () = shutdown_signal() => break,
        }
    }
    tasks.abort_all();
    while let Some(result) = tasks.join_next().await {
        if let Err(error) = result {
            if !error.is_cancelled() {
                error!(%error, "Postgres proxy task failed");
            }
        }
    }
    Ok(())
}

async fn shutdown_signal() {
    let interrupt = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl-C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = interrupt => {}
        () = terminate => {}
    }
}
