//! Multi-protocol OpenAI and Anthropic proxy for Databricks model serving.

mod adapt;
mod adaptive;
#[cfg(feature = "desktop")]
pub mod desktop;
mod error;
mod images;
mod metrics;
#[cfg(feature = "desktop")]
mod operator;
mod protocol;
mod rate_limit;
mod request_log;
mod routes;
mod runtime;
mod stream;
mod throttle;

use std::{
    ffi::OsString,
    future::Future,
    net::{IpAddr, SocketAddr},
    num::{NonZeroU64, NonZeroUsize},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use clap::{Args, CommandFactory, FromArgMatches, Parser, Subcommand};
use dbx_tools_core::{build_info, init_logging_with_verbose, shutdown_signal};
use dbx_tools_model::{ModelCapabilitiesResolver, ModelRateLimitsResolver};
use dbx_tools_service::{ResolvedLaunch, ServiceCli, ServiceDefinition, ServiceRuntimeOptions};
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
    #[command(flatten)]
    server: ServerOptions,
}

#[derive(Debug, Subcommand)]
enum CliCommand {
    /// Manage the per-user background service.
    Service(ServiceCli),
}

/// Command-line server configuration shared by headless and desktop binaries.
#[derive(Clone, Debug, Args)]
pub struct ServerOptions {
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
    /// Metrics mode: auto, collect, off, true, or false.
    #[arg(long, env = "METRICS", default_value_t = default_metrics_option())]
    metrics: MetricsOption,
    /// Maximum SQLite bytes retained for aggregate metrics; zero disables persistence.
    #[arg(
        long,
        env = "METRICS_STORE_MAX_BYTES",
        default_value_t = DEFAULT_METRICS_STORE_MAX_BYTES
    )]
    metrics_store_max_bytes: u64,
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
    /// Whether verbose request logging was selected.
    pub fn verbose(&self) -> bool {
        self.verbose
    }

    /// Use durable defaults for a directly launched desktop application.
    pub fn with_desktop_defaults(mut self) -> Self {
        if self.service.persistence == dbx_tools_service::PersistenceMode::Auto {
            self.service.persistence = dbx_tools_service::PersistenceMode::Sqlite;
        }
        self
    }

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
        push_service_argument(
            &mut args,
            "--metrics-store-max-bytes",
            self.metrics_store_max_bytes,
        );
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
    definition.desktop = local_desktop_executable();
    definition.invalid_runtime_detector = dbx_tools_core::is_databricks_app;
    Ok(definition)
}

fn local_desktop_executable() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let name = if cfg!(target_os = "windows") {
        "dbx-model-proxy-desktop.exe"
    } else {
        "dbx-model-proxy-desktop"
    };
    let desktop = executable.with_file_name(name);
    desktop.is_file().then_some(desktop)
}

/// Bound proxy listener and immutable runtime state awaiting service.
pub struct ProxyServer {
    state: AppState,
    listener: tokio::net::TcpListener,
    address: SocketAddr,
    max_request_bytes: NonZeroUsize,
}

impl ProxyServer {
    /// Resolve Databricks runtime state and bind the configured listener.
    pub async fn bind(options: ServerOptions) -> Result<Self, Box<dyn std::error::Error>> {
        let ServerOptions {
            verbose: _,
            profile,
            host,
            port,
            service,
            metrics: metrics_requested,
            metrics_store_max_bytes,
            target,
            max_request_bytes,
            image_resize_threshold_bytes,
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
        } = options;
        if rate_limit_initial_delay_ms > rate_limit_max_delay_ms {
            return Err(
                "RATE_LIMIT_INITIAL_DELAY_MS must not exceed RATE_LIMIT_MAX_DELAY_MS".into(),
            );
        }
        let in_databricks_app = dbx_tools_core::is_databricks_app();
        let metrics_config = MetricsConfig::resolve(metrics_requested, in_databricks_app)?;
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
            .filter(|_| metrics_store_max_bytes > 0)
            .map(|storage| MetricsPersistenceConfig {
                storage,
                runtime_key: runtime_status.storage_key.clone(),
                max_bytes: metrics_store_max_bytes,
            });
        let metrics = MetricsRuntime::new_with_persistence(metrics_config, metrics_persistence)?;
        metrics.activate_runtime(runtime_status.storage_key.clone())?;
        let state = AppState::new(
            ModelCapabilitiesResolver::new()?,
            runtime,
            AppConfig {
                target,
                image_resize_threshold_bytes: image_resize_threshold_bytes.get(),
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
            metrics_store_max_bytes,
            persistence = ?service_runtime.persistence,
            service_mode = service.service_mode,
            max_request_bytes = max_request_bytes.get(),
            image_resize_threshold_bytes = image_resize_threshold_bytes.get(),
            input_tokens_per_minute = input_tokens_per_minute.map(NonZeroU64::get),
            output_tokens_per_minute = output_tokens_per_minute.map(NonZeroU64::get),
            provisioned_throughput,
            ?rate_limit_mode,
            ?rate_limit_model_fallback,
            rate_limit_model_fallback_max_steps,
            rate_limit_model_fallback_threshold_ms =
                rate_limit_model_fallback_threshold_ms.get(),
            rate_limit_max_wait_ms,
            rate_limit_retries,
            rate_limit_initial_delay_ms = rate_limit_initial_delay_ms.get(),
            rate_limit_max_delay_ms = rate_limit_max_delay_ms.get(),
            "model proxy listening"
        );
        Ok(Self {
            state,
            listener,
            address,
            max_request_bytes,
        })
    }

    /// Return the bound socket address.
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    #[cfg(feature = "desktop")]
    pub(crate) fn state(&self) -> AppState {
        self.state.clone()
    }

    /// Serve proxy routes until shutdown and flush persistent aggregates.
    pub async fn serve(
        self,
        shutdown: impl Future<Output = ()> + Send + 'static,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let metrics = self.state.metrics().clone();
        let listener = self.state.metrics().track_listener(self.listener);
        let result = axum::serve(
            listener,
            routes::routes(self.state, self.max_request_bytes)
                .into_make_service_with_connect_info::<PeerAddr>(),
        )
        .with_graceful_shutdown(shutdown)
        .await;
        metrics.flush().await?;
        result?;
        Ok(())
    }
}

/// Run the headless proxy until the process receives its shutdown signal.
pub async fn run_server(options: ServerOptions) -> Result<(), Box<dyn std::error::Error>> {
    ProxyServer::bind(options)
        .await?
        .serve(shutdown_signal())
        .await
}

/// Parse and execute the headless command-line entry point.
pub fn execute() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::from_arg_matches(&Cli::command().version(build_info::version()).get_matches())?;
    init_logging_with_verbose(cli.server.verbose)?;
    if let Some(CliCommand::Service(service)) = cli.command {
        let definition = service_definition()?;
        if service.desktop_requested()
            && !service.desktop_supplied()
            && definition.desktop.is_none()
        {
            warn!(
                "desktop application is unavailable; build dbx-model-proxy-desktop with the desktop feature or use dbx model-proxy service install"
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
