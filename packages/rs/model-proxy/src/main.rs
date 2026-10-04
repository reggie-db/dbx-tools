//! Multi-protocol OpenAI and Anthropic proxy for Databricks model serving.

mod adapt;
mod adaptive;
mod error;
mod events;
mod images;
mod metrics;
mod protocol;
mod rate_limit;
mod request_log;
mod routes;
mod runtime;
mod stream;
mod throttle;

use std::{
    ffi::OsString,
    net::IpAddr,
    num::{NonZeroU64, NonZeroUsize},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use clap::{Args, CommandFactory, FromArgMatches, Parser, Subcommand};
use dbx_tools_core::{build_info, init_logging_with_verbose, shutdown_signal};
use dbx_tools_model::{ModelCapabilitiesResolver, ModelRateLimitsResolver};
use dbx_tools_service::{ResolvedLaunch, ServiceCli, ServiceDefinition, ServiceRuntimeOptions};
use events::ProxyFeeds;
use images::DEFAULT_IMAGE_RESIZE_THRESHOLD_BYTES;
use metrics::{
    default_metrics_option, MetricsConfig, MetricsOption, MetricsPersistenceConfig, MetricsRuntime,
    PeerAddr,
};
use protocol::TargetWire;
use rate_limit::{ModelFallbackMode, ModelFallbackPolicy, RateLimitPolicy};
use routes::{AppConfig, AppState};
use runtime::{RuntimeConfig, RuntimeManager, RuntimeSelection};
use throttle::{RateLimitMode, ThrottleConfig};
use tracing::{info, warn};

const DEFAULT_MAX_REQUEST_BYTES: NonZeroUsize =
    NonZeroUsize::new(25_000_000).expect("default request limit is non-zero");
const DEFAULT_IMAGE_RESIZE_THRESHOLD: NonZeroUsize =
    NonZeroUsize::new(DEFAULT_IMAGE_RESIZE_THRESHOLD_BYTES)
        .expect("default image resize threshold is non-zero");
const DEFAULT_STREAM_IDLE_TIMEOUT_MS: NonZeroU64 =
    NonZeroU64::new(120_000).expect("default stream idle timeout is non-zero");
const DEFAULT_RATE_LIMIT_RETRIES: u32 = 5;
const DEFAULT_RATE_LIMIT_INITIAL_DELAY_MS: NonZeroU64 =
    NonZeroU64::new(1_000).expect("default retry delay is non-zero");
const DEFAULT_RATE_LIMIT_MAX_DELAY_MS: NonZeroU64 =
    NonZeroU64::new(60_000).expect("default maximum retry delay is non-zero");
const DEFAULT_RATE_LIMIT_MAX_WAIT_MS: u64 = 60_000;
const DEFAULT_RATE_LIMIT_MODEL_FALLBACK_MAX_STEPS: u32 = 5;
const DEFAULT_RATE_LIMIT_MODEL_FALLBACK_THRESHOLD_MS: NonZeroU64 =
    NonZeroU64::new(10_000).expect("default model fallback threshold is non-zero");
const DEFAULT_METRICS_STORE_MAX_BYTES: u64 = 134_217_728;

#[derive(Debug, Parser)]
#[command(name = "dbx-model-proxy")]
struct Cli {
    #[command(subcommand)]
    command: Option<CliCommand>,
    /// Generate the OpenAPI document and exit without starting the proxy.
    #[arg(
        long,
        value_name = "PATH",
        num_args = 0..=1,
        default_missing_value = "openapi.json"
    )]
    generate_spec: Option<PathBuf>,
    #[command(flatten)]
    server: ServerOptions,
}

#[derive(Debug, Subcommand)]
enum CliCommand {
    /// Manage the per-user background service.
    Service(ServiceCli),
}

#[derive(Clone, Debug, Args)]
struct ServerOptions {
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
    #[command(flatten)]
    service: ServiceRuntimeOptions,
    /// Metrics mode: auto, on, off, true, or false.
    #[arg(long, env = "METRICS", default_value_t = default_metrics_option())]
    metrics: MetricsOption,
    /// Permit metrics routes when listening on a non-loopback address.
    #[arg(long, env = "METRICS_PUBLIC", default_value_t = false)]
    metrics_public: bool,
    /// Maximum SQLite bytes retained for aggregate metrics; zero disables persistence.
    #[arg(
        long,
        env = "METRICS_STORE_MAX_BYTES",
        default_value_t = DEFAULT_METRICS_STORE_MAX_BYTES
    )]
    metrics_store_max_bytes: u64,
    /// Expose authorization, cookie, token, and API-key headers in GraphQL events.
    #[arg(long, default_value_t = false)]
    show_sensitive: bool,
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
    /// Maximum time without an upstream SSE byte before terminating the stream.
    #[arg(
        long,
        env = "STREAM_IDLE_TIMEOUT_MS",
        default_value_t = DEFAULT_STREAM_IDLE_TIMEOUT_MS
    )]
    stream_idle_timeout_ms: NonZeroU64,
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
    /// Model fallback behavior before a long rate-limit wait.
    #[arg(
        long,
        env = "RATE_LIMIT_MODEL_FALLBACK",
        value_enum,
        default_value_t = ModelFallbackMode::SameFamily
    )]
    rate_limit_model_fallback: ModelFallbackMode,
    /// Maximum number of lower same-family model versions.
    #[arg(
        long,
        env = "RATE_LIMIT_MODEL_FALLBACK_MAX_STEPS",
        default_value_t = DEFAULT_RATE_LIMIT_MODEL_FALLBACK_MAX_STEPS,
        value_parser = clap::value_parser!(u32).range(..=20)
    )]
    rate_limit_model_fallback_max_steps: u32,
    /// Wait threshold that triggers an immediate model fallback.
    #[arg(
        long,
        env = "RATE_LIMIT_MODEL_FALLBACK_THRESHOLD_MS",
        default_value_t = DEFAULT_RATE_LIMIT_MODEL_FALLBACK_THRESHOLD_MS
    )]
    rate_limit_model_fallback_threshold_ms: NonZeroU64,
    /// Maximum total time one request may spend waiting on rate limits.
    #[arg(
        long,
        env = "RATE_LIMIT_MAX_WAIT_MS",
        default_value_t = DEFAULT_RATE_LIMIT_MAX_WAIT_MS,
        value_parser = clap::value_parser!(u64).range(1..=60_000)
    )]
    rate_limit_max_wait_ms: u64,
    /// Retries after an upstream 429 response; zero disables coordinated backoff.
    #[arg(
        long,
        env = "RATE_LIMIT_RETRIES",
        default_value_t = DEFAULT_RATE_LIMIT_RETRIES,
        value_parser = clap::value_parser!(u32).range(..=100)
    )]
    rate_limit_retries: u32,
    /// Initial delay for incremental 429 recovery.
    #[arg(
        long,
        env = "RATE_LIMIT_INITIAL_DELAY_MS",
        default_value_t = DEFAULT_RATE_LIMIT_INITIAL_DELAY_MS
    )]
    rate_limit_initial_delay_ms: NonZeroU64,
    /// Maximum delay for each incremental 429 recovery step.
    #[arg(
        long,
        env = "RATE_LIMIT_MAX_DELAY_MS",
        default_value_t = DEFAULT_RATE_LIMIT_MAX_DELAY_MS
    )]
    rate_limit_max_delay_ms: NonZeroU64,
}

#[derive(Debug, Parser)]
struct ServerParser {
    #[command(flatten)]
    server: ServerOptions,
}

fn push_service_argument(args: &mut Vec<OsString>, name: &str, value: impl ToString) {
    args.push(OsString::from(name));
    args.push(OsString::from(value.to_string()));
}

impl ServerOptions {
    fn service_arguments(&self) -> Vec<OsString> {
        let mut args = Vec::new();
        if self.verbose {
            args.push(OsString::from("--verbose"));
        }
        if let Some(profile) = &self.profile {
            push_service_argument(&mut args, "--profile", profile);
        }
        push_service_argument(&mut args, "--host", self.host);
        push_service_argument(&mut args, "--port", self.port);
        push_service_argument(&mut args, "--metrics", self.metrics);
        if self.metrics_public {
            args.push(OsString::from("--metrics-public"));
        }
        push_service_argument(
            &mut args,
            "--metrics-store-max-bytes",
            self.metrics_store_max_bytes,
        );
        if self.show_sensitive {
            args.push(OsString::from("--show-sensitive"));
        }
        push_service_argument(
            &mut args,
            "--target",
            match self.target {
                TargetWire::Auto => "auto",
                TargetWire::Chat => "chat",
                TargetWire::Responses => "responses",
            },
        );
        push_service_argument(&mut args, "--max-request-bytes", self.max_request_bytes);
        push_service_argument(
            &mut args,
            "--image-resize-threshold-bytes",
            self.image_resize_threshold_bytes,
        );
        push_service_argument(
            &mut args,
            "--stream-idle-timeout-ms",
            self.stream_idle_timeout_ms,
        );
        if let Some(limit) = self.input_tokens_per_minute {
            push_service_argument(&mut args, "--input-tokens-per-minute", limit);
        }
        if let Some(limit) = self.output_tokens_per_minute {
            push_service_argument(&mut args, "--output-tokens-per-minute", limit);
        }
        if self.provisioned_throughput {
            args.push(OsString::from("--provisioned-throughput"));
        }
        push_service_argument(
            &mut args,
            "--rate-limit-mode",
            match self.rate_limit_mode {
                RateLimitMode::Auto => "auto",
                RateLimitMode::On => "on",
                RateLimitMode::Off => "off",
            },
        );
        push_service_argument(
            &mut args,
            "--rate-limit-model-fallback",
            match self.rate_limit_model_fallback {
                ModelFallbackMode::Off => "off",
                ModelFallbackMode::SameFamily => "same-family",
            },
        );
        push_service_argument(
            &mut args,
            "--rate-limit-model-fallback-max-steps",
            self.rate_limit_model_fallback_max_steps,
        );
        push_service_argument(
            &mut args,
            "--rate-limit-model-fallback-threshold-ms",
            self.rate_limit_model_fallback_threshold_ms,
        );
        push_service_argument(
            &mut args,
            "--rate-limit-max-wait-ms",
            self.rate_limit_max_wait_ms,
        );
        push_service_argument(&mut args, "--rate-limit-retries", self.rate_limit_retries);
        push_service_argument(
            &mut args,
            "--rate-limit-initial-delay-ms",
            self.rate_limit_initial_delay_ms,
        );
        push_service_argument(
            &mut args,
            "--rate-limit-max-delay-ms",
            self.rate_limit_max_delay_ms,
        );
        args
    }
}

fn resolve_service_launch(
    raw: &[OsString],
    default_port: u16,
    _config_dir: &Path,
) -> dbx_tools_service::Result<ResolvedLaunch> {
    let server = if raw.is_empty() {
        ServerOptions {
            port: default_port,
            ..ServerParser::parse_from(["dbx-model-proxy"]).server
        }
    } else {
        let mut args = vec![OsString::from("dbx-model-proxy")];
        args.extend_from_slice(raw);
        ServerParser::try_parse_from(args)?.server
    };
    if server.service.config_dir.is_some()
        || server.service.persistence != dbx_tools_service::PersistenceMode::Auto
        || server.service.service_mode
    {
        return Err(
            "service runtime options must be passed before the server argument separator".into(),
        );
    }
    Ok(ResolvedLaunch {
        args: server.service_arguments(),
        host: server.host.to_string(),
        port: server.port,
    })
}

fn service_definition() -> dbx_tools_service::Result<ServiceDefinition> {
    let mut definition = ServiceDefinition::new("model-proxy", 4000)?;
    definition.companion = local_tray_companion();
    definition.invalid_runtime_detector = dbx_tools_core::is_databricks_app;
    Ok(definition)
}

fn local_tray_companion() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let name = if cfg!(target_os = "windows") {
        "dbx-model-proxy-tray.exe"
    } else {
        "dbx-model-proxy-tray"
    };
    let companion = executable.with_file_name(name);
    companion.is_file().then_some(companion)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::from_arg_matches(&Cli::command().version(build_info::version()).get_matches())?;
    init_logging_with_verbose(cli.server.verbose)?;
    if cli.generate_spec.is_some() {
        dbx_tools_service::openapi::export_requested(&routes::openapi(), std::env::args_os())?;
        return Ok(());
    }
    if let Some(CliCommand::Service(service)) = cli.command {
        let definition = service_definition()?;
        if service.companion_requested()
            && !service.companion_supplied()
            && definition.companion.is_none()
        {
            warn!(
                "tray companion is unavailable; build dbx-model-proxy-tray with the tray feature or use dbx model-proxy service install"
            );
        }
        info!(command = ?service.command, "executing model proxy service lifecycle");
        let mut stdout = std::io::stdout().lock();
        if let Some(requirements) = service.requirements(&definition)? {
            serde_json::to_writer(&mut stdout, &requirements)?;
        } else {
            let status = service.execute(&definition, resolve_service_launch)?;
            serde_json::to_writer(&mut stdout, &status)?;
        }
        std::io::Write::write_all(&mut stdout, b"\n")?;
        return Ok(());
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run_server(cli.server))
}

async fn run_server(cli: ServerOptions) -> Result<(), Box<dyn std::error::Error>> {
    let ServerOptions {
        verbose: _,
        profile,
        host,
        port,
        service,
        metrics,
        metrics_public,
        metrics_store_max_bytes,
        show_sensitive,
        target,
        max_request_bytes,
        image_resize_threshold_bytes,
        stream_idle_timeout_ms,
        input_tokens_per_minute,
        output_tokens_per_minute,
        provisioned_throughput,
        rate_limit_mode,
        rate_limit_model_fallback,
        rate_limit_model_fallback_max_steps,
        rate_limit_model_fallback_threshold_ms,
        rate_limit_max_wait_ms,
        rate_limit_retries,
        rate_limit_initial_delay_ms,
        rate_limit_max_delay_ms,
    } = cli;
    if rate_limit_initial_delay_ms > rate_limit_max_delay_ms {
        return Err("RATE_LIMIT_INITIAL_DELAY_MS must not exceed RATE_LIMIT_MAX_DELAY_MS".into());
    }
    let in_databricks_app = dbx_tools_core::is_databricks_app();
    let metrics_requested = metrics;
    let metrics_config =
        MetricsConfig::resolve(metrics_requested, host, metrics_public, in_databricks_app)?;
    let model_rate_limits = if provisioned_throughput || rate_limit_mode == RateLimitMode::Off {
        Default::default()
    } else {
        ModelRateLimitsResolver::new()?.rate_limits().await?
    };
    let throttle = ThrottleConfig {
        input_tokens_per_minute,
        output_tokens_per_minute,
        provisioned_throughput,
        mode: rate_limit_mode,
        documented_limits: model_rate_limits,
    };
    let service_runtime = service.resolve(&service_definition()?)?;
    let runtime = RuntimeManager::new_with_persistence(
        RuntimeSelection::exact_profile(profile)?,
        RuntimeConfig::new(throttle),
        Arc::clone(&service_runtime.settings),
        service_runtime.persistence,
    )
    .await?;
    let runtime_status = runtime.status();
    let metrics_persistence = service_runtime
        .storage
        .clone()
        .filter(|_| metrics_store_max_bytes > 0)
        .map(|storage| MetricsPersistenceConfig {
            storage,
            runtime_key: runtime_status.storage_key.clone(),
            max_bytes: metrics_store_max_bytes,
        });
    let metrics = MetricsRuntime::new_with_persistence(metrics_config, metrics_persistence)?;
    let feeds = ProxyFeeds::new(service_runtime.storage.clone(), show_sensitive)?;
    metrics.set_feeds(feeds.clone());
    metrics.activate_runtime(runtime_status.storage_key.clone())?;
    let state = AppState::new(
        ModelCapabilitiesResolver::new()?,
        runtime,
        AppConfig {
            target,
            image_resize_threshold_bytes: image_resize_threshold_bytes.get(),
            stream_idle_timeout: Duration::from_millis(stream_idle_timeout_ms.get()),
            model_fallback: ModelFallbackPolicy {
                mode: rate_limit_model_fallback,
                max_steps: rate_limit_model_fallback_max_steps as usize,
                threshold: Duration::from_millis(rate_limit_model_fallback_threshold_ms.get()),
            },
            rate_limits: RateLimitPolicy {
                max_retries: rate_limit_retries,
                initial_delay: Duration::from_millis(rate_limit_initial_delay_ms.get()),
                max_delay: Duration::from_millis(rate_limit_max_delay_ms.get()),
                max_wait: Duration::from_millis(rate_limit_max_wait_ms),
            },
            metrics: metrics.clone(),
            feeds,
            controls_enabled: host.is_loopback() && !in_databricks_app,
        },
    );
    let listener = tokio::net::TcpListener::bind((host, port)).await?;
    let address = listener.local_addr()?;
    info!(
        address = %address,
        generation = runtime_status.generation,
        profile = runtime_status.profile,
        databricks_host = runtime_status.host,
        ?target,
        metrics_requested = %metrics_requested,
        metrics_mode = %metrics.mode(),
        metrics_routes_visible = metrics.routes_visible(),
        metrics_store_max_bytes,
        show_sensitive,
        persistence = ?service_runtime.persistence,
        service_mode = service.service_mode,
        metrics_public,
        max_request_bytes = max_request_bytes.get(),
        image_resize_threshold_bytes = image_resize_threshold_bytes.get(),
        stream_idle_timeout_ms = stream_idle_timeout_ms.get(),
        input_tokens_per_minute = input_tokens_per_minute.map(NonZeroU64::get),
        output_tokens_per_minute = output_tokens_per_minute.map(NonZeroU64::get),
        provisioned_throughput,
        ?rate_limit_mode,
        ?rate_limit_model_fallback,
        rate_limit_model_fallback_max_steps,
        rate_limit_model_fallback_threshold_ms = rate_limit_model_fallback_threshold_ms.get(),
        rate_limit_max_wait_ms,
        rate_limit_retries,
        rate_limit_initial_delay_ms = rate_limit_initial_delay_ms.get(),
        rate_limit_max_delay_ms = rate_limit_max_delay_ms.get(),
        "model proxy listening"
    );
    let listener = metrics.track_listener(listener);
    let app = routes::routes(state, max_request_bytes)
        .await
        .map_err(std::io::Error::other)?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<PeerAddr>(),
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
        let server = cli.server;
        assert_eq!(server.max_request_bytes, DEFAULT_MAX_REQUEST_BYTES);
        assert!(!server.verbose);
        assert_eq!(server.metrics, default_metrics_option());
        assert!(!server.metrics_public);
        assert_eq!(
            server.metrics_store_max_bytes,
            DEFAULT_METRICS_STORE_MAX_BYTES
        );
        assert!(!server.show_sensitive);
        assert_eq!(
            server.service.persistence,
            dbx_tools_service::PersistenceMode::Auto
        );
        assert!(!server.service.service_mode);
        assert_eq!(server.max_request_bytes.get(), 25_000_000);
        assert_eq!(
            server.image_resize_threshold_bytes,
            DEFAULT_IMAGE_RESIZE_THRESHOLD
        );
        assert_eq!(
            server.stream_idle_timeout_ms,
            DEFAULT_STREAM_IDLE_TIMEOUT_MS
        );
        assert_eq!(server.input_tokens_per_minute, None);
        assert_eq!(server.output_tokens_per_minute, None);
        assert!(!server.provisioned_throughput);
        assert_eq!(server.rate_limit_mode, RateLimitMode::Auto);
        assert_eq!(
            server.rate_limit_model_fallback,
            ModelFallbackMode::SameFamily
        );
        assert_eq!(
            server.rate_limit_model_fallback_max_steps,
            DEFAULT_RATE_LIMIT_MODEL_FALLBACK_MAX_STEPS
        );
        assert_eq!(
            server.rate_limit_model_fallback_threshold_ms,
            DEFAULT_RATE_LIMIT_MODEL_FALLBACK_THRESHOLD_MS
        );
        assert_eq!(
            server.rate_limit_max_wait_ms,
            DEFAULT_RATE_LIMIT_MAX_WAIT_MS
        );
        assert_eq!(server.rate_limit_retries, DEFAULT_RATE_LIMIT_RETRIES);
        assert_eq!(server.rate_limit_retries, 5);
        assert_eq!(
            server.rate_limit_initial_delay_ms,
            DEFAULT_RATE_LIMIT_INITIAL_DELAY_MS
        );
        assert_eq!(
            server.rate_limit_max_delay_ms,
            DEFAULT_RATE_LIMIT_MAX_DELAY_MS
        );

        let cli = Cli::try_parse_from([
            "dbx-model-proxy",
            "--max-request-bytes",
            "8388608",
            "--metrics",
            "false",
            "--metrics-public",
            "--show-sensitive",
            "--image-resize-threshold-bytes",
            "3145728",
            "--stream-idle-timeout-ms",
            "45000",
            "--input-tokens-per-minute",
            "200000",
            "--output-tokens-per-minute",
            "20000",
            "--provisioned-throughput",
            "--rate-limit-mode",
            "off",
            "--rate-limit-model-fallback",
            "off",
            "--rate-limit-model-fallback-max-steps",
            "3",
            "--rate-limit-model-fallback-threshold-ms",
            "7500",
            "--rate-limit-max-wait-ms",
            "30000",
            "--rate-limit-retries",
            "0",
            "--rate-limit-initial-delay-ms",
            "250",
            "--rate-limit-max-delay-ms",
            "5000",
        ])
        .unwrap();
        let server = cli.server;
        assert_eq!(server.max_request_bytes.get(), 8 * 1024 * 1024);
        assert_eq!(server.metrics, MetricsOption::Off);
        assert!(server.metrics_public);
        assert!(server.show_sensitive);
        assert_eq!(server.image_resize_threshold_bytes.get(), 3 * 1024 * 1024);
        assert_eq!(server.stream_idle_timeout_ms.get(), 45_000);
        assert_eq!(server.input_tokens_per_minute.unwrap().get(), 200_000);
        assert_eq!(server.output_tokens_per_minute.unwrap().get(), 20_000);
        assert!(server.provisioned_throughput);
        assert_eq!(server.rate_limit_mode, RateLimitMode::Off);
        assert_eq!(server.rate_limit_model_fallback, ModelFallbackMode::Off);
        assert_eq!(server.rate_limit_model_fallback_max_steps, 3);
        assert_eq!(server.rate_limit_model_fallback_threshold_ms.get(), 7_500);
        assert_eq!(server.rate_limit_max_wait_ms, 30_000);
        assert_eq!(server.rate_limit_retries, 0);
        assert_eq!(server.rate_limit_initial_delay_ms.get(), 250);
        assert_eq!(server.rate_limit_max_delay_ms.get(), 5_000);
        assert!(
            Cli::try_parse_from(["dbx-model-proxy", "--rate-limit-max-wait-ms", "60001",]).is_err()
        );
    }

    #[test]
    fn service_install_captures_only_server_options() {
        let cli = Cli::try_parse_from([
            "dbx-model-proxy",
            "service",
            "install",
            "--systray",
            "never",
            "--",
            "--profile",
            "fixture",
            "--port",
            "4100",
        ])
        .unwrap();
        let Some(CliCommand::Service(service)) = cli.command else {
            panic!("expected service command");
        };
        let dbx_tools_service::ServiceCommand::Install(command) = service.command else {
            panic!("expected install command");
        };
        let directory = tempfile::tempdir().unwrap();
        let launch = resolve_service_launch(&command.server_args, 4000, directory.path()).unwrap();
        let default_stream_idle_timeout = DEFAULT_STREAM_IDLE_TIMEOUT_MS.to_string();
        assert_eq!(launch.port, 4100);
        assert!(launch
            .args
            .windows(2)
            .any(|pair| pair == ["--profile", "fixture"]));
        assert!(launch.args.windows(2).any(|pair| {
            pair[0] == "--stream-idle-timeout-ms"
                && pair[1].to_string_lossy() == default_stream_idle_timeout
        }));
        assert!(!launch
            .args
            .iter()
            .any(|argument| argument == "--config-dir"));
        assert!(!launch
            .args
            .iter()
            .any(|argument| argument == "--service-mode"));
        assert!(!launch
            .args
            .iter()
            .any(|arg| arg.to_string_lossy().contains("secret")));
    }

    #[test]
    fn service_help_is_owned_by_the_native_command() {
        let command = Cli::command();
        let service = command.find_subcommand("service").unwrap();
        let mut install = service.find_subcommand("install").unwrap().clone();
        let install_help = install.render_long_help().to_string();
        let uninstall = service.find_subcommand("uninstall").unwrap();
        let command_names = service
            .get_subcommands()
            .map(|command| command.get_name())
            .collect::<Vec<_>>();

        assert!(
            ["install", "start", "stop", "restart", "status", "uninstall"]
                .iter()
                .all(|name| command_names.contains(name))
        );
        assert!(install_help.contains("--config-dir"));
        assert!(install_help.contains("--systray"));
        assert!(install_help.contains("--persistence"));
        assert!(install_help.contains("default: auto"));
        assert!(uninstall.get_all_aliases().any(|alias| alias == "remove"));
        assert!(uninstall
            .get_arguments()
            .any(|argument| argument.get_id() == "purge"));
    }
}
