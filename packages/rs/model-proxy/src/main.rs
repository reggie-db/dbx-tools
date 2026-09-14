//! Multi-protocol OpenAI and Anthropic proxy for Databricks model serving.

mod adapt;
mod error;
mod images;
mod protocol;
mod rate_limit;
mod routes;
mod stream;
mod throttle;

use std::{
    net::{IpAddr, SocketAddr},
    num::{NonZeroU64, NonZeroUsize},
    time::Duration,
};

use clap::Parser;
use dbx_tools_core::{init_logging, DatabricksClient};
use dbx_tools_model::{ModelCapabilitiesResolver, ModelClient, ModelRateLimitsResolver};
use images::DEFAULT_IMAGE_RESIZE_THRESHOLD_BYTES;
use protocol::TargetWire;
use rate_limit::RateLimitPolicy;
use routes::AppState;
use throttle::ThrottleConfig;
use tracing::info;

const DEFAULT_MAX_REQUEST_BYTES: NonZeroUsize =
    NonZeroUsize::new(25_000_000).expect("default request limit is non-zero");
const DEFAULT_IMAGE_RESIZE_THRESHOLD: NonZeroUsize =
    NonZeroUsize::new(DEFAULT_IMAGE_RESIZE_THRESHOLD_BYTES)
        .expect("default image resize threshold is non-zero");
const DEFAULT_RATE_LIMIT_RETRIES: u32 = 5;
const DEFAULT_RATE_LIMIT_INITIAL_DELAY_MS: NonZeroU64 =
    NonZeroU64::new(1_000).expect("default retry delay is non-zero");
const DEFAULT_RATE_LIMIT_MAX_DELAY_MS: NonZeroU64 =
    NonZeroU64::new(60_000).expect("default maximum retry delay is non-zero");

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
    /// Override input tokens per minute for pay-per-token models.
    #[arg(long, env = "INPUT_TOKENS_PER_MINUTE")]
    input_tokens_per_minute: Option<NonZeroU64>,
    /// Override output tokens per minute for pay-per-token models.
    #[arg(long, env = "OUTPUT_TOKENS_PER_MINUTE")]
    output_tokens_per_minute: Option<NonZeroU64>,
    /// Disable pay-per-token TPM controls for provisioned throughput.
    #[arg(long, env = "PROVISIONED_THROUGHPUT", default_value_t = false)]
    provisioned_throughput: bool,
    /// Retries after an upstream 429 response; zero disables coordinated backoff.
    #[arg(
        long,
        env = "RATE_LIMIT_RETRIES",
        default_value_t = DEFAULT_RATE_LIMIT_RETRIES,
        value_parser = clap::value_parser!(u32).range(..=100)
    )]
    rate_limit_retries: u32,
    /// Initial jittered exponential delay when Retry-After is absent.
    #[arg(
        long,
        env = "RATE_LIMIT_INITIAL_DELAY_MS",
        default_value_t = DEFAULT_RATE_LIMIT_INITIAL_DELAY_MS
    )]
    rate_limit_initial_delay_ms: NonZeroU64,
    /// Maximum exponential delay when Retry-After is absent.
    #[arg(
        long,
        env = "RATE_LIMIT_MAX_DELAY_MS",
        default_value_t = DEFAULT_RATE_LIMIT_MAX_DELAY_MS
    )]
    rate_limit_max_delay_ms: NonZeroU64,
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
        input_tokens_per_minute,
        output_tokens_per_minute,
        provisioned_throughput,
        rate_limit_retries,
        rate_limit_initial_delay_ms,
        rate_limit_max_delay_ms,
    } = Cli::parse();
    if rate_limit_initial_delay_ms > rate_limit_max_delay_ms {
        return Err("RATE_LIMIT_INITIAL_DELAY_MS must not exceed RATE_LIMIT_MAX_DELAY_MS".into());
    }
    let databricks = DatabricksClient::new(profile).await?;
    let models = ModelClient::new(databricks.clone())?;
    let model_rate_limits = if provisioned_throughput {
        Default::default()
    } else {
        ModelRateLimitsResolver::new()?.rate_limits().await?
    };
    let state = AppState::new(
        ModelCapabilitiesResolver::new()?,
        databricks,
        models,
        target,
        ThrottleConfig {
            input_tokens_per_minute,
            output_tokens_per_minute,
            provisioned_throughput,
            documented_limits: model_rate_limits,
        },
        image_resize_threshold_bytes.get(),
        RateLimitPolicy {
            max_retries: rate_limit_retries,
            initial_delay: Duration::from_millis(rate_limit_initial_delay_ms.get()),
            max_delay: Duration::from_millis(rate_limit_max_delay_ms.get()),
        },
    );
    let listener = tokio::net::TcpListener::bind((host, port)).await?;
    info!(
        address = %listener.local_addr()?,
        ?target,
        max_request_bytes = max_request_bytes.get(),
        image_resize_threshold_bytes = image_resize_threshold_bytes.get(),
        input_tokens_per_minute = input_tokens_per_minute.map(NonZeroU64::get),
        output_tokens_per_minute = output_tokens_per_minute.map(NonZeroU64::get),
        provisioned_throughput,
        rate_limit_retries,
        rate_limit_initial_delay_ms = rate_limit_initial_delay_ms.get(),
        rate_limit_max_delay_ms = rate_limit_max_delay_ms.get(),
        "model proxy listening"
    );
    axum::serve(
        listener,
        routes::routes(state, max_request_bytes)
            .into_make_service_with_connect_info::<SocketAddr>(),
    )
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
        assert_eq!(cli.input_tokens_per_minute, None);
        assert_eq!(cli.output_tokens_per_minute, None);
        assert!(!cli.provisioned_throughput);
        assert_eq!(cli.rate_limit_retries, DEFAULT_RATE_LIMIT_RETRIES);
        assert_eq!(cli.rate_limit_retries, 5);
        assert_eq!(
            cli.rate_limit_initial_delay_ms,
            DEFAULT_RATE_LIMIT_INITIAL_DELAY_MS
        );
        assert_eq!(cli.rate_limit_max_delay_ms, DEFAULT_RATE_LIMIT_MAX_DELAY_MS);

        let cli = Cli::try_parse_from([
            "dbx-model-proxy",
            "--max-request-bytes",
            "8388608",
            "--image-resize-threshold-bytes",
            "3145728",
            "--input-tokens-per-minute",
            "200000",
            "--output-tokens-per-minute",
            "20000",
            "--provisioned-throughput",
            "--rate-limit-retries",
            "0",
            "--rate-limit-initial-delay-ms",
            "250",
            "--rate-limit-max-delay-ms",
            "5000",
        ])
        .unwrap();
        assert_eq!(cli.max_request_bytes.get(), 8 * 1024 * 1024);
        assert_eq!(cli.image_resize_threshold_bytes.get(), 3 * 1024 * 1024);
        assert_eq!(cli.input_tokens_per_minute.unwrap().get(), 200_000);
        assert_eq!(cli.output_tokens_per_minute.unwrap().get(), 20_000);
        assert!(cli.provisioned_throughput);
        assert_eq!(cli.rate_limit_retries, 0);
        assert_eq!(cli.rate_limit_initial_delay_ms.get(), 250);
        assert_eq!(cli.rate_limit_max_delay_ms.get(), 5_000);
    }
}
