use std::{
    net::{IpAddr, SocketAddr},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use clap::{Parser, Subcommand};
use dbx_tools_databricks::{connection_url, init_logging, DatabricksAuthOptions};
use dbx_tools_lakebase_proxy::{databricks::LakebaseClient, proxy::PostgresProxy};
use tokio::{net::TcpListener, task::JoinSet};
use tracing::{debug, error, info};

const STATS_INTERVAL: Duration = Duration::from_secs(60);

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
    tokio::spawn(report_stats(Arc::clone(&stats)));
    info!(address = %listener.local_addr()?, "Lakebase proxy listening");
    loop {
        tokio::select! {
            result = listener.accept() => {
                let (socket, peer) = result?;
                let proxy = proxy.clone();
                let stats = Arc::clone(&stats);
                tasks.spawn(async move {
                    stats.open(peer);
                    let started = Instant::now();
                    match proxy.handle(socket, startup_timeout).await {
                        Ok(()) => stats.close(peer, started.elapsed(), false, None),
                        Err(error) => {
                            stats.close(peer, started.elapsed(), true, Some(&error.to_string()))
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

#[derive(Default)]
struct ConnectionStats {
    active: AtomicUsize,
    opened: AtomicU64,
    closed: AtomicU64,
    failed: AtomicU64,
}

impl ConnectionStats {
    fn open(&self, peer: SocketAddr) {
        self.active.fetch_add(1, Ordering::Relaxed);
        self.opened.fetch_add(1, Ordering::Relaxed);
        debug!(%peer, active = self.active.load(Ordering::Relaxed), "connection opened");
    }

    fn close(&self, peer: SocketAddr, elapsed: Duration, failed: bool, error: Option<&str>) {
        self.active.fetch_sub(1, Ordering::Relaxed);
        self.closed.fetch_add(1, Ordering::Relaxed);
        if failed {
            self.failed.fetch_add(1, Ordering::Relaxed);
        }
        debug!(
            %peer,
            failed,
            error = error.unwrap_or_default(),
            duration_ms = elapsed.as_millis(),
            active = self.active.load(Ordering::Relaxed),
            "connection closed"
        );
    }
}

async fn report_stats(stats: Arc<ConnectionStats>) {
    let mut interval = tokio::time::interval(STATS_INTERVAL);
    interval.tick().await;
    loop {
        interval.tick().await;
        info!(
            period_seconds = STATS_INTERVAL.as_secs(),
            opened = stats.opened.swap(0, Ordering::Relaxed),
            closed = stats.closed.swap(0, Ordering::Relaxed),
            failed = stats.failed.swap(0, Ordering::Relaxed),
            active = stats.active.load(Ordering::Relaxed),
            "connection stats"
        );
    }
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
