//! Multi-protocol OpenAI and Anthropic proxy for Databricks model serving.

mod adapt;
mod error;
mod images;
mod protocol;
mod routes;
mod stream;
mod throttle;

use std::{
    net::IpAddr,
    num::{NonZeroU64, NonZeroUsize},
};

use clap::Parser;
use dbx_tools_core::{init_logging, DatabricksClient};
use dbx_tools_model::{ModelCapabilitiesResolver, ModelClient};
use images::DEFAULT_IMAGE_RESIZE_THRESHOLD_BYTES;
use protocol::TargetWire;
use routes::AppState;
use tracing::info;

const DEFAULT_MAX_REQUEST_BYTES: NonZeroUsize =
    NonZeroUsize::new(25_000_000).expect("default request limit is non-zero");
const DEFAULT_IMAGE_RESIZE_THRESHOLD: NonZeroUsize =
    NonZeroUsize::new(DEFAULT_IMAGE_RESIZE_THRESHOLD_BYTES)
        .expect("default image resize threshold is non-zero");

#[derive(Debug, Parser)]
#[command(name = "dbx-model-proxy", version)]
struct Cli {
    /// Databricks CLI profile.
    #[arg(long, env = "DATABRICKS_CONFIG_PROFILE")]
    profile: Option<String>,
    /// Listening address.
    #[arg(long, default_value = "127.0.0.1")]
    host: IpAddr,
    /// Listening port.
    #[arg(long, env = "DATABRICKS_APP_PORT", default_value_t = 4000)]
    port: u16,
    /// Databricks output protocol.
    #[arg(long, value_enum, default_value_t = TargetWire::Auto)]
    target: TargetWire,
    /// Maximum buffered request body size in bytes.
    #[arg(long, env = "MAX_REQUEST_BYTES", default_value_t = DEFAULT_MAX_REQUEST_BYTES)]
    max_request_bytes: NonZeroUsize,
    /// Resize embedded images whose decoded file exceeds this many bytes.
    #[arg(
        long,
        env = "IMAGE_RESIZE_THRESHOLD_BYTES",
        default_value_t = DEFAULT_IMAGE_RESIZE_THRESHOLD
    )]
    image_resize_threshold_bytes: NonZeroUsize,
    /// Optional token reservations per minute for each workspace and resolved model.
    #[arg(long, env = "TOKENS_PER_MINUTE")]
    tokens_per_minute: Option<NonZeroU64>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    init_logging()?;
    let Cli {
        profile,
        host,
        port,
        target,
        max_request_bytes,
        image_resize_threshold_bytes,
        tokens_per_minute,
    } = Cli::parse();
    let databricks = DatabricksClient::new(profile).await?;
    let models = ModelClient::new(databricks.clone())?;
    let state = AppState::new(
        ModelCapabilitiesResolver::new()?,
        databricks,
        models,
        target,
        tokens_per_minute,
        image_resize_threshold_bytes.get(),
    );
    let listener = tokio::net::TcpListener::bind((host, port)).await?;
    info!(
        address = %listener.local_addr()?,
        ?target,
        max_request_bytes = max_request_bytes.get(),
        image_resize_threshold_bytes = image_resize_threshold_bytes.get(),
        tokens_per_minute = tokens_per_minute.map(NonZeroU64::get),
        "model proxy listening"
    );
    axum::serve(listener, routes::routes(state, max_request_bytes))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_limit_defaults_to_image_capable_proxy_limit() {
        let cli = Cli::try_parse_from(["dbx-model-proxy"]).unwrap();
        assert_eq!(cli.max_request_bytes, DEFAULT_MAX_REQUEST_BYTES);
        assert_eq!(cli.max_request_bytes.get(), 25_000_000);
        assert_eq!(
            cli.image_resize_threshold_bytes,
            DEFAULT_IMAGE_RESIZE_THRESHOLD
        );
        assert_eq!(cli.tokens_per_minute, None);

        let cli = Cli::try_parse_from([
            "dbx-model-proxy",
            "--max-request-bytes",
            "8388608",
            "--image-resize-threshold-bytes",
            "3145728",
        ])
        .unwrap();
        assert_eq!(cli.max_request_bytes.get(), 8 * 1024 * 1024);
        assert_eq!(cli.image_resize_threshold_bytes.get(), 3 * 1024 * 1024);
    }
}
