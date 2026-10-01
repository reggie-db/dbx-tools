//! Multi-protocol OpenAI and Anthropic proxy for Databricks model serving.

mod adapt;
mod adaptive;
mod error;
mod images;
mod metrics;
mod protocol;
mod rate_limit;
mod request_log;
mod routes;
mod stream;
mod throttle;

use std::{
    net::IpAddr,
    num::{NonZeroU64, NonZeroUsize},
    time::Duration,
};

use clap::{CommandFactory, FromArgMatches, Parser};
use dbx_tools_core::{build_info, init_logging_with_verbose, shutdown_signal, DatabricksClient};
use dbx_tools_model::{ModelCapabilitiesResolver, ModelClient, ModelRateLimitsResolver};
use images::DEFAULT_IMAGE_RESIZE_THRESHOLD_BYTES;
use metrics::{default_metrics_option, MetricsConfig, MetricsOption, MetricsRuntime, PeerAddr};
use protocol::TargetWire;
use rate_limit::RateLimitPolicy;
use routes::{AppConfig, AppState};
use throttle::{RateLimitMode, ThrottleConfig};
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
#[command(name = "dbx-model-proxy")]
struct Cli {
    /// Enable debug request details when LOG_LEVEL is not set.
    #[arg(short = 'v', long)]
    verbose: bool,
    /// Databricks CLI profile.
    #[arg(long, env = "DATABRICKS_CONFIG_PROFILE")]
    profile: Option<String>,
    /// Listening address.
    #[arg(long, default_value = "127.0.0.1")]
    host: IpAddr,
    /// Listening port.
    #[arg(long, env = "DATABRICKS_APP_PORT", default_value_t = 4000)]
    port: u16,
    /// Metrics mode: ui, collect, off, true, or false.
    #[arg(long, env = "METRICS", default_value_t = default_metrics_option())]
    metrics: MetricsOption,
    /// Permit metrics routes when listening on a non-loopback address.
    #[arg(long, env = "METRICS_PUBLIC", default_value_t = false)]
    metrics_public: bool,
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
    /// Process-local TPM admission mode.
    #[arg(long, env = "RATE_LIMIT_MODE", value_enum, default_value_t = RateLimitMode::Auto)]
    rate_limit_mode: RateLimitMode,
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
    let cli = Cli::from_arg_matches(&Cli::command().version(build_info::version()).get_matches())?;
    init_logging_with_verbose(cli.verbose)?;
    let Cli {
        verbose: _,
        profile,
        host,
        port,
        metrics,
        metrics_public,
        target,
        max_request_bytes,
        image_resize_threshold_bytes,
        input_tokens_per_minute,
        output_tokens_per_minute,
        provisioned_throughput,
        rate_limit_mode,
        rate_limit_retries,
        rate_limit_initial_delay_ms,
        rate_limit_max_delay_ms,
    } = cli;
    if rate_limit_initial_delay_ms > rate_limit_max_delay_ms {
        return Err("RATE_LIMIT_INITIAL_DELAY_MS must not exceed RATE_LIMIT_MAX_DELAY_MS".into());
    }
    let metrics = MetricsRuntime::new(MetricsConfig::resolve(metrics, host, metrics_public)?)?;
    let databricks = DatabricksClient::new(profile).await?;
    let models = ModelClient::new(databricks.clone())?;
    let model_rate_limits = if provisioned_throughput || rate_limit_mode == RateLimitMode::Off {
        Default::default()
    } else {
        ModelRateLimitsResolver::new()?.rate_limits().await?
    };
    let state = AppState::new(
        ModelCapabilitiesResolver::new()?,
        databricks,
        models,
        AppConfig {
            target,
            throttle: ThrottleConfig {
                input_tokens_per_minute,
                output_tokens_per_minute,
                provisioned_throughput,
                mode: rate_limit_mode,
                documented_limits: model_rate_limits,
            },
            image_resize_threshold_bytes: image_resize_threshold_bytes.get(),
            rate_limits: RateLimitPolicy {
                max_retries: rate_limit_retries,
                initial_delay: Duration::from_millis(rate_limit_initial_delay_ms.get()),
                max_delay: Duration::from_millis(rate_limit_max_delay_ms.get()),
            },
            metrics: metrics.clone(),
        },
    );
    let listener = tokio::net::TcpListener::bind((host, port)).await?;
    let address = listener.local_addr()?;
    info!(
        address = %address,
        ?target,
        metrics_mode = %metrics.mode(),
        metrics_routes_visible = metrics.routes_visible(),
        metrics_public,
        max_request_bytes = max_request_bytes.get(),
        image_resize_threshold_bytes = image_resize_threshold_bytes.get(),
        input_tokens_per_minute = input_tokens_per_minute.map(NonZeroU64::get),
        output_tokens_per_minute = output_tokens_per_minute.map(NonZeroU64::get),
        provisioned_throughput,
        ?rate_limit_mode,
        rate_limit_retries,
        rate_limit_initial_delay_ms = rate_limit_initial_delay_ms.get(),
        rate_limit_max_delay_ms = rate_limit_max_delay_ms.get(),
        "model proxy listening"
    );
    let listener = metrics.track_listener(listener);
    axum::serve(
        listener,
        routes::routes(state, max_request_bytes).into_make_service_with_connect_info::<PeerAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_limit_defaults_to_image_capable_proxy_limit() {
        let cli = Cli::try_parse_from(["dbx-model-proxy"]).unwrap();
        assert_eq!(cli.max_request_bytes, DEFAULT_MAX_REQUEST_BYTES);
        assert!(!cli.verbose);
        assert_eq!(cli.metrics, default_metrics_option());
        assert!(!cli.metrics_public);
        assert_eq!(cli.max_request_bytes.get(), 25_000_000);
        assert_eq!(
            cli.image_resize_threshold_bytes,
            DEFAULT_IMAGE_RESIZE_THRESHOLD
        );
        assert_eq!(cli.input_tokens_per_minute, None);
        assert_eq!(cli.output_tokens_per_minute, None);
        assert!(!cli.provisioned_throughput);
        assert_eq!(cli.rate_limit_mode, RateLimitMode::Auto);
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
            "--metrics",
            "false",
            "--metrics-public",
            "--image-resize-threshold-bytes",
            "3145728",
            "--input-tokens-per-minute",
            "200000",
            "--output-tokens-per-minute",
            "20000",
            "--provisioned-throughput",
            "--rate-limit-mode",
            "off",
            "--rate-limit-retries",
            "0",
            "--rate-limit-initial-delay-ms",
            "250",
            "--rate-limit-max-delay-ms",
            "5000",
        ])
        .unwrap();
        assert_eq!(cli.max_request_bytes.get(), 8 * 1024 * 1024);
        assert_eq!(cli.metrics, MetricsOption::Off);
        assert!(cli.metrics_public);
        assert_eq!(cli.image_resize_threshold_bytes.get(), 3 * 1024 * 1024);
        assert_eq!(cli.input_tokens_per_minute.unwrap().get(), 200_000);
        assert_eq!(cli.output_tokens_per_minute.unwrap().get(), 20_000);
        assert!(cli.provisioned_throughput);
        assert_eq!(cli.rate_limit_mode, RateLimitMode::Off);
        assert_eq!(cli.rate_limit_retries, 0);
        assert_eq!(cli.rate_limit_initial_delay_ms.get(), 250);
        assert_eq!(cli.rate_limit_max_delay_ms.get(), 5_000);
    }
}
