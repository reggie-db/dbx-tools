//! Reusable per-user service lifecycle, state, and companion autostart.

#[cfg(feature = "desktop")]
pub mod desktop;

use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    str::FromStr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use auto_launcher::{
    AutoLaunch, AutoLaunchBuilder, LinuxLaunchMode, MacOSLaunchMode, WindowsEnableMode,
};
use clap::{Args, Parser, Subcommand, ValueEnum};
use directories::BaseDirs;
use rusqlite::{params, Connection, OptionalExtension};
use rusqlite_migration::{Migrations, M};
use serde::{Deserialize, Serialize};
use service_manager::{
    RestartPolicy, ServiceInstallCtx, ServiceLabel, ServiceLevel, ServiceManager, ServiceStartCtx,
    ServiceStatus, ServiceStatusCtx, ServiceStopCtx, ServiceUninstallCtx,
};

const MIGRATIONS_SLICE: &[M<'_>] = &[
    M::up(
        "CREATE TABLE service_configuration (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        program TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        companion_program TEXT,
        companion_arguments_json TEXT,
        host TEXT NOT NULL,
        port INTEGER NOT NULL
    );",
    ),
    M::up(
        "CREATE TABLE service_settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );",
    ),
    M::up(
        "CREATE TABLE aggregate_metrics (
        runtime_key TEXT PRIMARY KEY NOT NULL,
        payload BLOB NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX aggregate_metrics_updated_at
        ON aggregate_metrics(updated_at_ms);",
    ),
];
const MIGRATIONS: Migrations<'_> = Migrations::from_slice(MIGRATIONS_SLICE);
const DATABASE_NAME: &str = "service.sqlite3";
const STARTUP_HEALTH_TIMEOUT: Duration = Duration::from_secs(10);
const STARTUP_HEALTH_POLL: Duration = Duration::from_millis(250);
const COMPANION_PROCESS_ID_SETTING: &str = "service.companion-process-id";
#[cfg(target_os = "windows")]
const WINDOWS_PROCESS_ID_SETTING: &str = "service.windows-process-id";

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

/// Runtime persistence selected for service-owned state.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum PersistenceMode {
    /// Use memory for direct execution and SQLite for installed services.
    #[default]
    Auto,
    /// Keep state only for the lifetime of the process.
    Memory,
    /// Persist state in the service configuration directory.
    Sqlite,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
pub enum SystrayMode {
    #[default]
    Auto,
    Always,
    Never,
}

impl FromStr for SystrayMode {
    type Err = String;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        match value {
            "auto" => Ok(Self::Auto),
            "always" => Ok(Self::Always),
            "never" => Ok(Self::Never),
            _ => Err(format!("invalid systray mode: {value}")),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ServiceConfig {
    pub name: String,
    pub label: ServiceLabel,
    pub host: String,
    pub port: u16,
    pub config_dir: PathBuf,
    invalid_runtime: fn() -> bool,
    companion_support_detector: fn(&Path) -> bool,
}

impl ServiceConfig {
    pub fn new(name: impl Into<String>, port: u16) -> Result<Self> {
        let name = name.into();
        let base = BaseDirs::new().ok_or("could not resolve the current user's home directory")?;
        Self::with_config_root(name, port, base.home_dir().join(".dbx-tools"))
    }

    pub fn with_config_root(
        name: impl Into<String>,
        port: u16,
        root: impl Into<PathBuf>,
    ) -> Result<Self> {
        let name = name.into();
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(format!("invalid service name: {name}").into());
        }
        let label = format!("com.dbx-tools.{}", name.replace('_', "-")).parse()?;
        Ok(Self {
            config_dir: root.into().join(&name),
            name,
            label,
            host: "127.0.0.1".to_string(),
            port,
            invalid_runtime: never_invalid_runtime,
            companion_support_detector: companion_supported,
        })
    }

    pub fn health_url(&self) -> String {
        format!("http://{}:{}/api/healthz", self.host, self.port)
    }

    pub fn metrics_url(&self) -> String {
        format!("http://{}:{}/metrics", self.host, self.port)
    }

    pub fn database_path(&self) -> PathBuf {
        self.config_dir.join(DATABASE_NAME)
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.config_dir.join("logs")
    }

    pub fn with_invalid_runtime_detector(mut self, detector: fn() -> bool) -> Self {
        self.invalid_runtime = detector;
        self
    }

    /// Reject service and desktop behavior in an unsupported managed runtime.
    pub fn ensure_runtime(&self) -> Result<()> {
        guard_invalid_runtime(self.invalid_runtime)
    }
}

#[derive(Clone, Debug)]
pub struct ServiceDefinition {
    pub name: String,
    pub default_port: u16,
    pub executable: PathBuf,
    pub companion: Option<PathBuf>,
    pub companion_support_detector: fn(&Path) -> bool,
    pub invalid_runtime_detector: fn() -> bool,
}

impl ServiceDefinition {
    pub fn new(name: impl Into<String>, default_port: u16) -> Result<Self> {
        Ok(Self {
            name: name.into(),
            default_port,
            executable: env::current_exe()?,
            companion: None,
            companion_support_detector: companion_supported,
            invalid_runtime_detector: never_invalid_runtime,
        })
    }
}

fn service_config(
    definition: &ServiceDefinition,
    config_dir: Option<&PathBuf>,
) -> Result<ServiceConfig> {
    let mut config = ServiceConfig::new(&definition.name, definition.default_port)?;
    config.invalid_runtime = definition.invalid_runtime_detector;
    config.companion_support_detector = definition.companion_support_detector;
    if let Some(config_dir) = config_dir {
        config.config_dir = std::path::absolute(config_dir)?;
    }
    Ok(config)
}

/// Runtime arguments shared by direct and installed service processes.
#[derive(Clone, Debug, Args)]
pub struct ServiceRuntimeOptions {
    /// Service configuration directory.
    #[arg(long)]
    pub config_dir: Option<PathBuf>,
    /// Persistence mode for settings and aggregate metrics.
    #[arg(long, value_enum, default_value_t = PersistenceMode::Auto)]
    pub persistence: PersistenceMode,
    /// Mark execution as an installed service process.
    #[arg(long, hide = true, default_value_t = false)]
    pub service_mode: bool,
}

impl Default for ServiceRuntimeOptions {
    fn default() -> Self {
        Self {
            config_dir: None,
            persistence: PersistenceMode::Auto,
            service_mode: false,
        }
    }
}

/// Resolved service runtime state and its shared persistence handle.
#[derive(Clone)]
pub struct ServiceRuntime {
    pub config: ServiceConfig,
    pub persistence: PersistenceMode,
    pub settings: Arc<dyn SettingsStore>,
    pub storage: Option<ServiceStorage>,
}

impl ServiceRuntimeOptions {
    /// Resolve runtime defaults from execution mode without inspecting consumer arguments.
    pub fn resolve(&self, definition: &ServiceDefinition) -> Result<ServiceRuntime> {
        let config = service_config(definition, self.config_dir.as_ref())?;
        let persistence = match self.persistence {
            PersistenceMode::Auto if self.service_mode => PersistenceMode::Sqlite,
            PersistenceMode::Auto => PersistenceMode::Memory,
            explicit => explicit,
        };
        match persistence {
            PersistenceMode::Memory => Ok(ServiceRuntime {
                config,
                persistence,
                settings: Arc::new(MemorySettings::default()),
                storage: None,
            }),
            PersistenceMode::Sqlite => {
                let storage = ServiceStorage::open(&config.config_dir)?;
                Ok(ServiceRuntime {
                    config,
                    persistence,
                    settings: Arc::new(storage.clone()),
                    storage: Some(storage),
                })
            }
            PersistenceMode::Auto => unreachable!("automatic persistence is resolved above"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ResolvedLaunch {
    pub args: Vec<OsString>,
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Debug, Args)]
pub struct ServiceCli {
    #[command(subcommand)]
    pub command: ServiceCommand,
}

#[derive(Clone, Debug, Subcommand)]
pub enum ServiceCommand {
    /// Install and start the per-user service.
    Install(ServiceInstallCommand),
    /// Start the installed service.
    Start(ServicePathCommand),
    /// Stop the installed service.
    Stop(ServicePathCommand),
    /// Restart the installed service.
    Restart(ServicePathCommand),
    /// Show registration, health, and companion status.
    Status(ServicePathCommand),
    /// Uninstall the service while retaining its configuration by default.
    #[command(alias = "remove")]
    Uninstall(ServiceUninstallCommand),
    /// Resolve install requirements for a release-binary orchestrator.
    #[command(hide = true)]
    Requirements(ServiceRequirementsCommand),
}

#[derive(Clone, Debug, Args)]
pub struct ServicePathCommand {
    /// Service configuration directory.
    #[arg(long)]
    pub config_dir: Option<PathBuf>,
}

#[derive(Clone, Debug, Args)]
pub struct ServiceInstallCommand {
    /// Service configuration directory.
    #[arg(long)]
    pub config_dir: Option<PathBuf>,
    /// Stable service executable path.
    #[arg(long)]
    pub executable: Option<PathBuf>,
    /// Optional desktop companion executable path.
    #[arg(long)]
    pub companion: Option<PathBuf>,
    /// Systray startup policy.
    #[arg(long, value_enum, default_value_t = SystrayMode::Auto)]
    pub systray: SystrayMode,
    /// Persistence used by the installed service process.
    #[arg(long, value_enum, default_value_t = PersistenceMode::Auto)]
    pub persistence: PersistenceMode,
    /// Non-secret server options captured by the installed service.
    #[arg(last = true, allow_hyphen_values = true)]
    pub server_args: Vec<OsString>,
}

#[derive(Clone, Debug, Args)]
pub struct ServiceUninstallCommand {
    /// Service configuration directory.
    #[arg(long)]
    pub config_dir: Option<PathBuf>,
    /// Delete the service configuration directory after uninstalling.
    #[arg(long)]
    pub purge: bool,
}

#[derive(Clone, Debug, Args)]
pub struct ServiceRequirementsCommand {
    /// Companion executable available for capability probing.
    #[arg(long)]
    pub companion: Option<PathBuf>,
    /// Original arguments supplied after `service install`.
    #[arg(last = true, allow_hyphen_values = true)]
    pub install_args: Vec<OsString>,
}

#[derive(Debug, Parser)]
struct ServiceInstallParser {
    #[command(flatten)]
    install: ServiceInstallCommand,
}

#[derive(Clone, Debug, Serialize)]
pub struct ServiceRequirements {
    pub companion_asset_required: bool,
    pub companion_supported: Option<bool>,
    pub install_args: Vec<String>,
}

impl ServiceCli {
    /// Whether this command requests automatic or required desktop integration.
    pub fn companion_requested(&self) -> bool {
        matches!(
            &self.command,
            ServiceCommand::Install(command) if command.systray != SystrayMode::Never
        )
    }

    pub fn requirements(
        &self,
        definition: &ServiceDefinition,
    ) -> Result<Option<ServiceRequirements>> {
        let ServiceCommand::Requirements(command) = &self.command else {
            return Ok(None);
        };
        guard_invalid_runtime(definition.invalid_runtime_detector)?;
        let mut parser_args = vec![OsString::from("service-install")];
        parser_args.extend_from_slice(&command.install_args);
        let install = ServiceInstallParser::try_parse_from(parser_args)?.install;
        let companion = install.companion.as_ref().or(command.companion.as_ref());
        if let Some(companion) = companion {
            require_absolute_existing(companion, "companion executable")?;
        }
        let companion_supported = match (install.systray, companion) {
            (SystrayMode::Never, _) | (_, None) => None,
            (_, Some(companion)) => Some((definition.companion_support_detector)(companion)),
        };
        if install.systray == SystrayMode::Always && companion_supported == Some(false) {
            return Err("the desktop companion is unsupported in this session".into());
        }
        let mut install_args = os_strings(&command.install_args)?;
        if install.companion.is_none() {
            if let Some(companion) = &command.companion {
                let index = install_args
                    .iter()
                    .position(|argument| argument == "--")
                    .unwrap_or(install_args.len());
                install_args.splice(
                    index..index,
                    ["--companion".to_string(), path_text(companion.as_path())?],
                );
            }
        }
        Ok(Some(ServiceRequirements {
            companion_asset_required: install.systray != SystrayMode::Never && companion.is_none(),
            companion_supported,
            install_args,
        }))
    }

    pub fn execute(
        &self,
        definition: &ServiceDefinition,
        resolve_launch: impl FnOnce(&[OsString], u16, &Path) -> Result<ResolvedLaunch>,
    ) -> Result<LifecycleStatus> {
        guard_invalid_runtime(definition.invalid_runtime_detector)?;
        match &self.command {
            ServiceCommand::Install(command) => {
                let mut config = service_config(definition, command.config_dir.as_ref())?;
                let launch = resolve_launch(
                    &command.server_args,
                    definition.default_port,
                    &config.config_dir,
                )?;
                let mut launch = launch;
                inject_runtime_arguments(
                    &mut launch.args,
                    &config.config_dir,
                    command.persistence,
                )?;
                config.host = launch.host;
                config.port = launch.port;
                let companion = command
                    .companion
                    .as_ref()
                    .or(definition.companion.as_ref())
                    .map(|program| CompanionConfig {
                        program: program.clone(),
                        args: vec![
                            OsString::from("--url"),
                            OsString::from(config.metrics_url()),
                            OsString::from("--health-url"),
                            OsString::from(config.health_url()),
                        ],
                    });
                ServiceLifecycle::new(config).install(InstallConfig {
                    program: command
                        .executable
                        .clone()
                        .unwrap_or_else(|| definition.executable.clone()),
                    args: launch.args,
                    companion,
                    systray: command.systray,
                })
            }
            ServiceCommand::Start(command) => {
                ServiceLifecycle::new(service_config(definition, command.config_dir.as_ref())?)
                    .start()
            }
            ServiceCommand::Stop(command) => {
                ServiceLifecycle::new(service_config(definition, command.config_dir.as_ref())?)
                    .stop()
            }
            ServiceCommand::Restart(command) => {
                ServiceLifecycle::new(service_config(definition, command.config_dir.as_ref())?)
                    .restart()
            }
            ServiceCommand::Status(command) => {
                ServiceLifecycle::new(service_config(definition, command.config_dir.as_ref())?)
                    .status()
            }
            ServiceCommand::Uninstall(command) => {
                ServiceLifecycle::new(service_config(definition, command.config_dir.as_ref())?)
                    .uninstall(command.purge)
            }
            ServiceCommand::Requirements(_) => {
                Err("service requirements must be handled before lifecycle execution".into())
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct CompanionConfig {
    pub program: PathBuf,
    pub args: Vec<OsString>,
}

#[derive(Clone, Debug)]
pub struct InstallConfig {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub companion: Option<CompanionConfig>,
    pub systray: SystrayMode,
}

#[derive(Clone, Debug, Serialize)]
pub struct LifecycleStatus {
    pub registration: String,
    pub healthy: bool,
    pub systray: bool,
    pub config_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub health_url: String,
    pub metrics_url: String,
}

/// Non-secret key-value settings used by a service runtime.
pub trait SettingsStore: Send + Sync {
    /// Read one setting.
    fn get(&self, key: &str) -> Result<Option<String>>;
    /// Insert or replace one setting.
    fn set(&self, key: &str, value: &str) -> Result<()>;
    /// Remove one setting.
    fn remove(&self, key: &str) -> Result<()>;
}

/// Process-local settings for direct command-line execution.
#[derive(Default)]
pub struct MemorySettings {
    values: Mutex<HashMap<String, String>>,
}

impl SettingsStore for MemorySettings {
    fn get(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .values
            .lock()
            .map_err(|_| "memory settings lock is poisoned")?
            .get(key)
            .cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<()> {
        validate_setting_key(key)?;
        self.values
            .lock()
            .map_err(|_| "memory settings lock is poisoned")?
            .insert(key.to_owned(), value.to_owned());
        Ok(())
    }

    fn remove(&self, key: &str) -> Result<()> {
        validate_setting_key(key)?;
        self.values
            .lock()
            .map_err(|_| "memory settings lock is poisoned")?
            .remove(key);
        Ok(())
    }
}

/// Shared SQLite storage for service settings and bounded aggregate metrics.
#[derive(Clone)]
pub struct ServiceStorage {
    connection: Arc<Mutex<Connection>>,
}

impl ServiceStorage {
    /// Open and migrate the database in one service configuration directory.
    pub fn open(config_dir: impl AsRef<Path>) -> Result<Self> {
        fs::create_dir_all(config_dir.as_ref())?;
        Ok(Self {
            connection: Arc::new(Mutex::new(open_service_connection(
                &config_dir.as_ref().join(DATABASE_NAME),
            )?)),
        })
    }

    /// Load the latest aggregate metrics for one hashed runtime key.
    pub fn load_aggregate_metrics(&self, runtime_key: &str) -> Result<Option<Vec<u8>>> {
        validate_metric_key(runtime_key)?;
        self.connection
            .lock()
            .map_err(|_| "SQLite service storage lock is poisoned")?
            .query_row(
                "SELECT payload FROM aggregate_metrics WHERE runtime_key = ?1",
                [runtime_key],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    /// Replace one aggregate snapshot after pruning the oldest metric rows.
    ///
    /// A zero limit removes the selected runtime snapshot while leaving service
    /// settings available. Payloads larger than the complete limit are not stored.
    pub fn store_aggregate_metrics(
        &self,
        runtime_key: &str,
        payload: &[u8],
        updated_at_ms: u64,
        max_bytes: u64,
    ) -> Result<bool> {
        validate_metric_key(runtime_key)?;
        let payload_size = i64::try_from(payload.len())?;
        let max_bytes = i64::try_from(max_bytes).unwrap_or(i64::MAX);
        let updated_at_ms = i64::try_from(updated_at_ms).unwrap_or(i64::MAX);
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite service storage lock is poisoned")?;
        let transaction = connection.transaction()?;
        if max_bytes == 0 || payload_size > max_bytes {
            transaction.execute(
                "DELETE FROM aggregate_metrics WHERE runtime_key = ?1",
                [runtime_key],
            )?;
            transaction.commit()?;
            return Ok(false);
        }
        let replaced_size = transaction
            .query_row(
                "SELECT size_bytes FROM aggregate_metrics WHERE runtime_key = ?1",
                [runtime_key],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or_default();
        let mut retained_size = transaction.query_row(
            "SELECT COALESCE(SUM(size_bytes), 0) FROM aggregate_metrics",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        retained_size = retained_size.saturating_sub(replaced_size);
        while retained_size.saturating_add(payload_size) > max_bytes {
            let oldest = transaction
                .query_row(
                    "SELECT runtime_key, size_bytes
                     FROM aggregate_metrics
                     WHERE runtime_key != ?1
                     ORDER BY updated_at_ms ASC, runtime_key ASC
                     LIMIT 1",
                    [runtime_key],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()?;
            let Some((oldest_key, oldest_size)) = oldest else {
                break;
            };
            transaction.execute(
                "DELETE FROM aggregate_metrics WHERE runtime_key = ?1",
                [oldest_key],
            )?;
            retained_size = retained_size.saturating_sub(oldest_size);
        }
        transaction.execute(
            "INSERT INTO aggregate_metrics (runtime_key, payload, size_bytes, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(runtime_key) DO UPDATE SET
                payload = excluded.payload,
                size_bytes = excluded.size_bytes,
                updated_at_ms = excluded.updated_at_ms",
            params![runtime_key, payload, payload_size, updated_at_ms],
        )?;
        transaction.commit()?;
        Ok(true)
    }
}

impl SettingsStore for ServiceStorage {
    fn get(&self, key: &str) -> Result<Option<String>> {
        validate_setting_key(key)?;
        self.connection
            .lock()
            .map_err(|_| "SQLite service storage lock is poisoned")?
            .query_row(
                "SELECT value FROM service_settings WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    fn set(&self, key: &str, value: &str) -> Result<()> {
        validate_setting_key(key)?;
        self.connection
            .lock()
            .map_err(|_| "SQLite service storage lock is poisoned")?
            .execute(
                "INSERT INTO service_settings (key, value, updated_at)
                 VALUES (?1, ?2, unixepoch())
                 ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at",
                params![key, value],
            )?;
        Ok(())
    }

    fn remove(&self, key: &str) -> Result<()> {
        validate_setting_key(key)?;
        self.connection
            .lock()
            .map_err(|_| "SQLite service storage lock is poisoned")?
            .execute("DELETE FROM service_settings WHERE key = ?1", [key])?;
        Ok(())
    }
}

/// Compatibility name for consumers that only need SQLite settings.
pub type SqliteSettings = ServiceStorage;

#[derive(Debug, Deserialize, Serialize)]
struct StoredConfiguration {
    program: String,
    arguments: Vec<String>,
    companion_program: Option<String>,
    companion_arguments: Option<Vec<String>>,
    host: String,
    port: u16,
}

fn effective_config(config: &ServiceConfig, stored: Option<&StoredConfiguration>) -> ServiceConfig {
    let mut effective = config.clone();
    if let Some(stored) = stored {
        effective.host.clone_from(&stored.host);
        effective.port = stored.port;
    }
    effective
}

pub struct ServiceStore {
    connection: Connection,
}

impl ServiceStore {
    pub fn open(config: &ServiceConfig) -> Result<Self> {
        fs::create_dir_all(&config.config_dir)?;
        Ok(Self {
            connection: open_service_connection(&config.database_path())?,
        })
    }

    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    fn save(&self, config: &ServiceConfig, install: &InstallConfig) -> Result<()> {
        let stored = StoredConfiguration {
            program: path_text(&install.program)?,
            arguments: os_strings(&install.args)?,
            companion_program: install
                .companion
                .as_ref()
                .map(|companion| path_text(&companion.program))
                .transpose()?,
            companion_arguments: install
                .companion
                .as_ref()
                .map(|companion| os_strings(&companion.args))
                .transpose()?,
            host: config.host.clone(),
            port: config.port,
        };
        self.connection.execute(
            "INSERT INTO service_configuration (
                singleton, program, arguments_json, companion_program,
                companion_arguments_json, host, port
             ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(singleton) DO UPDATE SET
                program = excluded.program,
                arguments_json = excluded.arguments_json,
                companion_program = excluded.companion_program,
                companion_arguments_json = excluded.companion_arguments_json,
                host = excluded.host,
                port = excluded.port",
            params![
                stored.program,
                serde_json::to_string(&stored.arguments)?,
                stored.companion_program,
                stored
                    .companion_arguments
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                stored.host,
                stored.port,
            ],
        )?;
        Ok(())
    }

    fn load(&self) -> Result<Option<StoredConfiguration>> {
        self.connection
            .query_row(
                "SELECT program, arguments_json, companion_program,
                        companion_arguments_json, host, port
                 FROM service_configuration WHERE singleton = 1",
                [],
                |row| {
                    let arguments: String = row.get(1)?;
                    let companion_arguments: Option<String> = row.get(3)?;
                    Ok(StoredConfiguration {
                        program: row.get(0)?,
                        arguments: serde_json::from_str(&arguments).map_err(to_sql_error)?,
                        companion_program: row.get(2)?,
                        companion_arguments: companion_arguments
                            .map(|value| serde_json::from_str(&value).map_err(to_sql_error))
                            .transpose()?,
                        host: row.get(4)?,
                        port: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }
}

fn open_service_connection(path: &Path) -> Result<Connection> {
    let mut connection = Connection::open(path)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "foreign_keys", true)?;
    MIGRATIONS.to_latest(&mut connection)?;
    Ok(connection)
}

fn validate_setting_key(key: &str) -> Result<()> {
    if key.trim().is_empty() {
        return Err("service setting key must not be empty".into());
    }
    Ok(())
}

fn validate_metric_key(key: &str) -> Result<()> {
    if key.is_empty()
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("aggregate metric runtime key must be a non-empty opaque identifier".into());
    }
    Ok(())
}

pub struct ServiceLifecycle {
    config: ServiceConfig,
}

impl ServiceLifecycle {
    pub fn new(config: ServiceConfig) -> Self {
        Self { config }
    }

    pub fn config(&self) -> &ServiceConfig {
        &self.config
    }

    pub fn install(&self, install: InstallConfig) -> Result<LifecycleStatus> {
        self.guard_runtime()?;
        require_absolute_existing(&install.program, "service executable")?;
        if install.systray == SystrayMode::Always && install.companion.is_none() {
            return Err("systray mode always requires a companion executable".into());
        }
        if let Some(companion) = &install.companion {
            require_absolute_existing(&companion.program, "companion executable")?;
        }
        let companion_enabled =
            resolve_companion_policy(&install, self.config.companion_support_detector)?;
        let store = ServiceStore::open(&self.config)?;
        let existing = store.load()?;
        unregister_service(&self.config, existing.as_ref())?;
        let mut install = install;
        install.program = install_managed_executable(&self.config, &install.program)?;
        register_service(&self.config, &install)?;
        configure_companion(&self.config, &install, existing.as_ref(), companion_enabled)?;
        store.save(&self.config, &install)?;
        self.await_healthy_status()
    }

    pub fn start(&self) -> Result<LifecycleStatus> {
        self.guard_runtime()?;
        start_service(&self.config)?;
        self.await_healthy_status()
    }

    pub fn stop(&self) -> Result<LifecycleStatus> {
        self.guard_runtime()?;
        stop_service(&self.config)?;
        self.status()
    }

    pub fn restart(&self) -> Result<LifecycleStatus> {
        self.guard_runtime()?;
        stop_service(&self.config)?;
        start_service(&self.config)?;
        self.await_healthy_status()
    }

    pub fn status(&self) -> Result<LifecycleStatus> {
        self.guard_runtime()?;
        let registration = registration_status(&self.config)?;
        let stored = if self.config.database_path().exists() {
            ServiceStore::open(&self.config)?.load()?
        } else {
            None
        };
        let effective = effective_config(&self.config, stored.as_ref());
        let systray_registered = stored
            .as_ref()
            .and_then(|stored| companion_auto_launch(&self.config.name, stored))
            .map(|auto| auto.is_enabled())
            .transpose()?
            .unwrap_or(false);
        let systray = systray_registered
            && stored
                .as_ref()
                .is_some_and(|stored| companion_process(configured_companion(stored)).is_some());
        let healthy = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()?
            .get(effective.health_url())
            .send()
            .map(|response| response.status().is_success())
            .unwrap_or(false);
        Ok(LifecycleStatus {
            registration,
            healthy,
            systray,
            config_dir: effective.config_dir.clone(),
            logs_dir: effective.logs_dir(),
            health_url: effective.health_url(),
            metrics_url: effective.metrics_url(),
        })
    }

    pub fn uninstall(&self, purge: bool) -> Result<LifecycleStatus> {
        self.guard_runtime()?;
        let stored = if self.config.database_path().exists() {
            ServiceStore::open(&self.config)?.load()?
        } else {
            None
        };
        stop_companion_process(&self.config, stored.as_ref())?;
        if let Some(auto) = stored
            .as_ref()
            .and_then(|stored| companion_auto_launch(&self.config.name, stored))
        {
            if auto.is_enabled().unwrap_or(false) {
                auto.disable()?;
            }
        }
        unregister_service(&self.config, stored.as_ref())?;
        if let Some(stored) = &stored {
            remove_managed_executable(&self.config, Path::new(&stored.program))?;
        }
        if purge && self.config.config_dir.exists() {
            fs::remove_dir_all(&self.config.config_dir)?;
        }
        self.status()
    }

    fn guard_runtime(&self) -> Result<()> {
        self.config.ensure_runtime()
    }

    fn await_healthy_status(&self) -> Result<LifecycleStatus> {
        let deadline = Instant::now() + STARTUP_HEALTH_TIMEOUT;
        loop {
            let status = self.status()?;
            if status.healthy || Instant::now() >= deadline {
                return Ok(status);
            }
            std::thread::sleep(STARTUP_HEALTH_POLL);
        }
    }
}

fn guard_invalid_runtime(detector: fn() -> bool) -> Result<()> {
    if detector() {
        return Err("OS service management is unavailable inside a Databricks App".into());
    }
    Ok(())
}

fn path_text(path: &Path) -> Result<String> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("path is not valid UTF-8: {}", path.display()).into())
}

fn os_strings(values: &[OsString]) -> Result<Vec<String>> {
    values
        .iter()
        .map(|value| {
            value
                .to_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| "service arguments must be valid UTF-8".into())
        })
        .collect()
}

fn inject_runtime_arguments(
    args: &mut Vec<OsString>,
    config_dir: &Path,
    persistence: PersistenceMode,
) -> Result<()> {
    for reserved in ["--config-dir", "--persistence", "--service-mode"] {
        if args.iter().any(|argument| argument == reserved) {
            return Err(format!(
                "{reserved} is owned by the service lifecycle; pass it before the server argument separator"
            )
            .into());
        }
    }
    args.push(OsString::from("--config-dir"));
    args.push(config_dir.as_os_str().to_owned());
    args.push(OsString::from("--persistence"));
    args.push(OsString::from(match persistence {
        PersistenceMode::Auto => "auto",
        PersistenceMode::Memory => "memory",
        PersistenceMode::Sqlite => "sqlite",
    }));
    args.push(OsString::from("--service-mode"));
    Ok(())
}

fn to_sql_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn install_managed_executable(config: &ServiceConfig, source: &Path) -> Result<PathBuf> {
    let name = source
        .file_name()
        .ok_or_else(|| format!("service executable has no file name: {}", source.display()))?;
    let directory = config.config_dir.join("bin");
    let destination = directory.join(name);
    if source == destination {
        return Ok(destination);
    }
    fs::create_dir_all(&directory)?;
    let staged = directory.join(format!(
        ".{}.{}.tmp",
        name.to_string_lossy(),
        std::process::id()
    ));
    if staged.exists() {
        fs::remove_file(&staged)?;
    }
    fs::copy(source, &staged)?;
    #[cfg(target_os = "windows")]
    if destination.exists() {
        fs::remove_file(&destination)?;
    }
    fs::rename(&staged, &destination)?;
    Ok(destination)
}

fn remove_managed_executable(config: &ServiceConfig, executable: &Path) -> Result<()> {
    let directory = config.config_dir.join("bin");
    if executable.parent() == Some(directory.as_path()) && executable.exists() {
        fs::remove_file(executable)?;
    }
    if directory
        .read_dir()
        .is_ok_and(|mut entries| entries.next().is_none())
    {
        fs::remove_dir(directory)?;
    }
    Ok(())
}

fn require_absolute_existing(path: &Path, description: &str) -> Result<()> {
    if !path.is_absolute() {
        return Err(format!(
            "{description} must use an absolute path: {}",
            path.display()
        )
        .into());
    }
    if !path.is_file() {
        return Err(format!("{description} does not exist: {}", path.display()).into());
    }
    Ok(())
}

fn user_manager() -> Result<Box<dyn ServiceManager>> {
    let mut manager = <dyn ServiceManager>::native()?;
    manager
        .set_level(ServiceLevel::User)
        .map_err(|error| format!("native service manager has no per-user support: {error}"))?;
    Ok(manager)
}

#[cfg(not(target_os = "windows"))]
fn register_service(config: &ServiceConfig, install: &InstallConfig) -> Result<()> {
    let manager = user_manager()?;
    let status = manager.status(ServiceStatusCtx {
        label: config.label.clone(),
    })?;
    if status != ServiceStatus::NotInstalled {
        manager.uninstall(ServiceUninstallCtx {
            label: config.label.clone(),
        })?;
    }
    manager.install(ServiceInstallCtx {
        label: config.label.clone(),
        program: install.program.clone(),
        args: install.args.clone(),
        contents: None,
        username: None,
        working_directory: Some(config.config_dir.clone()),
        environment: None,
        autostart: true,
        restart_policy: RestartPolicy::Never,
    })?;
    manager.start(ServiceStartCtx {
        label: config.label.clone(),
    })?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn register_service(config: &ServiceConfig, install: &InstallConfig) -> Result<()> {
    stop_service(config)?;
    let auto = auto_launch(&config.name, &install.program, &os_strings(&install.args)?)?;
    auto.enable()?;
    start_stored_process(config, &install.program, &install.args)?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn registration_status(config: &ServiceConfig) -> Result<String> {
    Ok(
        match user_manager()?.status(ServiceStatusCtx {
            label: config.label.clone(),
        })? {
            ServiceStatus::NotInstalled => "not-installed".to_string(),
            ServiceStatus::Running => "running".to_string(),
            ServiceStatus::Stopped(reason) => reason
                .map(|reason| format!("stopped: {reason}"))
                .unwrap_or_else(|| "stopped".to_string()),
        },
    )
}

#[cfg(not(target_os = "windows"))]
fn start_service(config: &ServiceConfig) -> Result<()> {
    user_manager()?
        .start(ServiceStartCtx {
            label: config.label.clone(),
        })
        .map_err(Into::into)
}

#[cfg(target_os = "windows")]
fn start_service(config: &ServiceConfig) -> Result<()> {
    let stored = ServiceStore::open(config)?
        .load()?
        .ok_or("the service has no stored launch configuration")?;
    let (program, arguments) = stored_process_spec(&stored)?;
    start_stored_process(config, &program, &arguments)
}

#[cfg(not(target_os = "windows"))]
fn stop_service(config: &ServiceConfig) -> Result<()> {
    user_manager()?
        .stop(ServiceStopCtx {
            label: config.label.clone(),
        })
        .map_err(Into::into)
}

#[cfg(target_os = "windows")]
fn stop_service(config: &ServiceConfig) -> Result<()> {
    use sysinfo::{Pid, ProcessesToUpdate, Signal, System};

    if !config.database_path().exists() {
        return Ok(());
    }
    let storage = ServiceStorage::open(&config.config_dir)?;
    let Some(pid) = storage.get(WINDOWS_PROCESS_ID_SETTING)? else {
        return Ok(());
    };
    let pid = pid
        .parse::<u32>()
        .map(Pid::from_u32)
        .map_err(|_| "stored Windows service process id is invalid")?;
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    if let Some(process) = system.process(pid) {
        let stored = ServiceStore::open(config)?
            .load()?
            .ok_or("the service has no stored launch configuration")?;
        let executable = normalized_process_path(Path::new(&stored.program));
        if process.exe().map(normalized_process_path).as_deref() != Some(executable.as_path()) {
            return Err("stored Windows process id belongs to another executable".into());
        }
        let stopped = process.kill_with(Signal::Term).unwrap_or(false) || process.kill();
        if !stopped {
            return Err("Windows service process could not be stopped".into());
        }
        for _ in 0..100 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
            if system.process(pid).is_none() {
                break;
            }
        }
        if system.process(pid).is_some() {
            return Err("Windows service process did not stop within five seconds".into());
        }
    }
    storage.remove(WINDOWS_PROCESS_ID_SETTING)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn registration_status(config: &ServiceConfig) -> Result<String> {
    let stored = if config.database_path().exists() {
        ServiceStore::open(config)?.load()?
    } else {
        None
    };
    let Some(stored) = stored else {
        return Ok("not-installed".to_string());
    };
    let auto = auto_launch(&config.name, Path::new(&stored.program), &stored.arguments)?;
    let storage = ServiceStorage::open(&config.config_dir)?;
    let running = storage
        .get(WINDOWS_PROCESS_ID_SETTING)?
        .and_then(|value| value.parse::<u32>().ok())
        .is_some_and(|pid| process_matches(pid, Path::new(&stored.program)));
    Ok(if auto.is_enabled()? && running {
        "running".to_string()
    } else if auto.is_enabled()? {
        "stopped".to_string()
    } else {
        "not-installed".to_string()
    })
}

#[cfg(not(target_os = "windows"))]
fn unregister_service(config: &ServiceConfig, _stored: Option<&StoredConfiguration>) -> Result<()> {
    let manager = user_manager()?;
    let status = manager.status(ServiceStatusCtx {
        label: config.label.clone(),
    })?;
    if status != ServiceStatus::NotInstalled {
        manager.uninstall(ServiceUninstallCtx {
            label: config.label.clone(),
        })?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn unregister_service(config: &ServiceConfig, stored: Option<&StoredConfiguration>) -> Result<()> {
    stop_service(config)?;
    if let Some(stored) = stored {
        let auto = auto_launch(&config.name, Path::new(&stored.program), &stored.arguments)?;
        if auto.is_enabled()? {
            auto.disable()?;
        }
    }
    Ok(())
}

#[cfg(any(target_os = "windows", test))]
fn stored_process_spec(stored: &StoredConfiguration) -> Result<(PathBuf, Vec<OsString>)> {
    let program = PathBuf::from(&stored.program);
    require_absolute_existing(&program, "service executable")?;
    Ok((
        program,
        stored.arguments.iter().map(OsString::from).collect(),
    ))
}

#[cfg(target_os = "windows")]
fn start_stored_process(config: &ServiceConfig, program: &Path, args: &[OsString]) -> Result<()> {
    use sysinfo::{Pid, ProcessesToUpdate, System};

    let storage = ServiceStorage::open(&config.config_dir)?;
    if storage
        .get(WINDOWS_PROCESS_ID_SETTING)?
        .and_then(|value| value.parse::<u32>().ok())
        .is_some_and(|pid| process_matches(pid, program))
    {
        return Ok(());
    }
    let child = Command::new(program)
        .args(args)
        .current_dir(&config.config_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let pid = child.id();
    let mut system = System::new();
    let system_pid = Pid::from_u32(pid);
    system.refresh_processes(ProcessesToUpdate::Some(&[system_pid]), true);
    let expected = program.canonicalize()?;
    let matches = system
        .process(system_pid)
        .and_then(|process| process.exe())
        .and_then(|path| path.canonicalize().ok())
        .is_some_and(|path| path == expected);
    if !matches {
        return Err("started Windows service process did not match the stored executable".into());
    }
    storage.set(WINDOWS_PROCESS_ID_SETTING, &pid.to_string())?;
    Ok(())
}

fn process_matches(pid: u32, program: &Path) -> bool {
    use sysinfo::{Pid, ProcessesToUpdate, System};

    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    let expected = normalized_process_path(program);
    system
        .process(pid)
        .and_then(|process| process.exe())
        .map(normalized_process_path)
        .is_some_and(|executable| executable == expected)
}

fn normalized_process_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn stop_companion_process(
    config: &ServiceConfig,
    companion: Option<&StoredConfiguration>,
) -> Result<()> {
    use sysinfo::{Pid, ProcessesToUpdate, Signal, System};

    if !config.database_path().exists() {
        return Ok(());
    }
    let storage = ServiceStorage::open(&config.config_dir)?;
    let expected = companion
        .and_then(|stored| stored.companion_program.as_deref())
        .map(Path::new);
    let Some(expected) = expected else {
        storage.remove(COMPANION_PROCESS_ID_SETTING)?;
        return Ok(());
    };
    let pid = storage
        .get(COMPANION_PROCESS_ID_SETTING)?
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|pid| process_matches(*pid, expected))
        .or_else(|| companion_process(Some(expected)))
        .map(Pid::from_u32);
    let Some(pid) = pid else {
        storage.remove(COMPANION_PROCESS_ID_SETTING)?;
        return Ok(());
    };
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    if let Some(process) = system.process(pid) {
        let stopped = process.kill_with(Signal::Term).unwrap_or(false) || process.kill();
        if !stopped {
            return Err("desktop companion process could not be stopped".into());
        }
    }
    storage.remove(COMPANION_PROCESS_ID_SETTING)?;
    Ok(())
}

fn start_companion_process(config: &ServiceConfig, companion: &CompanionConfig) -> Result<()> {
    let storage = ServiceStorage::open(&config.config_dir)?;
    if let Some(pid) = companion_process(Some(&companion.program)) {
        storage.set(COMPANION_PROCESS_ID_SETTING, &pid.to_string())?;
        return Ok(());
    }
    fs::create_dir_all(config.logs_dir())?;
    let stdout = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(config.logs_dir().join("desktop.log"))?;
    let stderr = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(config.logs_dir().join("desktop-error.log"))?;
    let child = Command::new(&companion.program)
        .args(&companion.args)
        .current_dir(&config.config_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()?;
    storage.set(COMPANION_PROCESS_ID_SETTING, &child.id().to_string())?;
    Ok(())
}

fn configure_companion(
    config: &ServiceConfig,
    install: &InstallConfig,
    existing: Option<&StoredConfiguration>,
    enabled: bool,
) -> Result<()> {
    stop_companion_process(config, existing)?;
    let Some(companion) = &install.companion else {
        if let Some(auto) = existing.and_then(|stored| companion_auto_launch(&config.name, stored))
        {
            if auto.is_enabled().unwrap_or(false) {
                auto.disable()?;
            }
        }
        return Ok(());
    };
    let auto = companion_launch(
        &config.name,
        &companion.program,
        &os_strings(&companion.args)?,
    )?;
    if enabled {
        auto.enable()?;
        start_companion_process(config, companion)?;
    } else if auto.is_enabled().unwrap_or(false) {
        auto.disable()?;
    }
    Ok(())
}

fn resolve_companion_policy(
    install: &InstallConfig,
    companion_support_detector: fn(&Path) -> bool,
) -> Result<bool> {
    let Some(companion) = &install.companion else {
        return if install.systray == SystrayMode::Always {
            Err("systray mode always requires a companion executable".into())
        } else {
            Ok(false)
        };
    };
    match install.systray {
        SystrayMode::Never => Ok(false),
        SystrayMode::Auto => Ok(companion_support_detector(&companion.program)),
        SystrayMode::Always if companion_support_detector(&companion.program) => Ok(true),
        SystrayMode::Always => Err(format!(
            "the desktop companion is unsupported in this session: {}",
            companion.program.display()
        )
        .into()),
    }
}

fn companion_auto_launch(name: &str, stored: &StoredConfiguration) -> Option<AutoLaunch> {
    let program = stored.companion_program.as_ref()?;
    companion_launch(
        name,
        Path::new(program),
        stored.companion_arguments.as_deref().unwrap_or_default(),
    )
    .ok()
}

fn configured_companion(stored: &StoredConfiguration) -> Option<&Path> {
    stored.companion_program.as_deref().map(Path::new)
}

fn companion_process(program: Option<&Path>) -> Option<u32> {
    use sysinfo::System;

    let expected = normalized_process_path(program?);
    System::new_all()
        .processes()
        .iter()
        .find_map(|(pid, process)| {
            process
                .exe()
                .map(normalized_process_path)
                .is_some_and(|executable| executable == expected)
                .then(|| pid.as_u32())
        })
}

fn auto_launch(name: &str, program: &Path, args: &[String]) -> Result<AutoLaunch> {
    let mut builder = AutoLaunchBuilder::new();
    builder
        .set_app_name(name)
        .set_app_path(&path_text(program)?)
        .set_args(args)
        .set_windows_enable_mode(WindowsEnableMode::CurrentUser)
        .set_macos_launch_mode(MacOSLaunchMode::LaunchAgentUser)
        .set_linux_launch_mode(LinuxLaunchMode::SystemdUser);
    Ok(builder.build()?)
}

fn companion_launch(name: &str, program: &Path, args: &[String]) -> Result<AutoLaunch> {
    auto_launch(&format!("{name}-desktop"), program, args)
}

fn companion_supported(program: &Path) -> bool {
    Command::new(program)
        .arg("--probe")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn never_invalid_runtime() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn service_defaults_are_stable_and_scoped() {
        let root = tempdir().unwrap();
        let config = ServiceConfig::with_config_root("model-proxy", 4000, root.path()).unwrap();
        assert_eq!(config.config_dir, root.path().join("model-proxy"));
        assert_eq!(config.health_url(), "http://127.0.0.1:4000/api/healthz");
        assert_eq!(config.metrics_url(), "http://127.0.0.1:4000/metrics");

        let definition = ServiceDefinition::new("model-proxy", 4000).unwrap();
        let relative = PathBuf::from("relative-service-config");
        let resolved = service_config(&definition, Some(&relative)).unwrap();
        assert!(resolved.config_dir.is_absolute());
        assert!(resolved.config_dir.ends_with(relative));
    }

    #[test]
    fn managed_executable_is_copied_out_of_mutable_build_storage() {
        let root = tempdir().unwrap();
        let source = root.path().join("target").join("dbx-model-proxy");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, b"first").unwrap();
        let config = ServiceConfig::with_config_root("model-proxy", 4000, root.path()).unwrap();

        let installed = install_managed_executable(&config, &source).unwrap();
        assert_eq!(
            installed,
            root.path().join("model-proxy/bin").join("dbx-model-proxy")
        );
        assert_eq!(fs::read(&installed).unwrap(), b"first");

        fs::write(&source, b"second").unwrap();
        assert_eq!(
            install_managed_executable(&config, &source).unwrap(),
            installed
        );
        assert_eq!(fs::read(&installed).unwrap(), b"second");

        remove_managed_executable(&config, &installed).unwrap();
        assert!(!installed.exists());
    }

    #[test]
    fn stored_host_and_port_drive_service_status_urls() {
        let root = tempdir().unwrap();
        let config = ServiceConfig::with_config_root("fixture", 4100, root.path()).unwrap();
        let stored = StoredConfiguration {
            program: "/service".into(),
            arguments: Vec::new(),
            companion_program: None,
            companion_arguments: None,
            host: "127.0.0.2".into(),
            port: 4200,
        };
        let effective = effective_config(&config, Some(&stored));

        assert_eq!(effective.health_url(), "http://127.0.0.2:4200/api/healthz");
        assert_eq!(effective.metrics_url(), "http://127.0.0.2:4200/metrics");
    }

    #[test]
    fn store_migrates_and_exposes_sqlite_access() {
        let root = tempdir().unwrap();
        let config = ServiceConfig::with_config_root("fixture", 4100, root.path()).unwrap();
        let store = ServiceStore::open(&config).unwrap();
        let version: i64 = store
            .connection()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 3);
        assert!(config.database_path().is_file());
        assert!(MIGRATIONS.validate().is_ok());
    }

    #[test]
    fn settings_support_memory_and_sqlite_persistence() {
        let memory = MemorySettings::default();
        assert_eq!(memory.get("profile").unwrap(), None);
        memory.set("profile", "workspace").unwrap();
        assert_eq!(memory.get("profile").unwrap().as_deref(), Some("workspace"));
        memory.remove("profile").unwrap();
        assert_eq!(memory.get("profile").unwrap(), None);

        let root = tempdir().unwrap();
        {
            let settings = ServiceStorage::open(root.path()).unwrap();
            settings.set("profile", "workspace").unwrap();
        }
        let settings = ServiceStorage::open(root.path()).unwrap();
        assert_eq!(
            settings.get("profile").unwrap().as_deref(),
            Some("workspace")
        );
        settings.remove("profile").unwrap();
        assert_eq!(settings.get("profile").unwrap(), None);
        assert!(settings.set("", "invalid").is_err());
    }

    #[test]
    fn runtime_auto_persistence_follows_service_mode() {
        let root = tempdir().unwrap();
        let mut definition = ServiceDefinition::new("fixture", 4100).unwrap();
        definition.executable = env::current_exe().unwrap();
        let direct = ServiceRuntimeOptions {
            config_dir: Some(root.path().join("direct")),
            ..ServiceRuntimeOptions::default()
        }
        .resolve(&definition)
        .unwrap();
        assert_eq!(direct.persistence, PersistenceMode::Memory);
        assert!(direct.storage.is_none());

        let installed = ServiceRuntimeOptions {
            config_dir: Some(root.path().join("installed")),
            service_mode: true,
            ..ServiceRuntimeOptions::default()
        }
        .resolve(&definition)
        .unwrap();
        assert_eq!(installed.persistence, PersistenceMode::Sqlite);
        assert!(installed.storage.is_some());
        assert!(installed.config.database_path().is_file());
    }

    #[test]
    fn aggregate_metrics_prune_oldest_without_affecting_settings() {
        let root = tempdir().unwrap();
        let storage = ServiceStorage::open(root.path()).unwrap();
        storage.set("profile", "workspace").unwrap();
        assert!(storage
            .store_aggregate_metrics("runtime-a", b"12345", 1, 10)
            .unwrap());
        assert!(storage
            .store_aggregate_metrics("runtime-b", b"67890", 2, 10)
            .unwrap());
        assert!(storage
            .store_aggregate_metrics("runtime-c", b"abcde", 3, 10)
            .unwrap());
        assert_eq!(storage.load_aggregate_metrics("runtime-a").unwrap(), None);
        assert_eq!(
            storage.load_aggregate_metrics("runtime-c").unwrap(),
            Some(b"abcde".to_vec())
        );
        assert_eq!(
            storage.get("profile").unwrap().as_deref(),
            Some("workspace")
        );
        assert!(!storage
            .store_aggregate_metrics("runtime-c", b"abcde", 4, 0)
            .unwrap());
        assert_eq!(storage.load_aggregate_metrics("runtime-c").unwrap(), None);
        assert_eq!(
            storage.get("profile").unwrap().as_deref(),
            Some("workspace")
        );
    }

    #[test]
    fn installed_runtime_arguments_are_stable_and_centralized() {
        let root = tempdir().unwrap();
        let mut args = vec![OsString::from("--port"), OsString::from("4100")];
        inject_runtime_arguments(&mut args, root.path(), PersistenceMode::Auto).unwrap();
        assert_eq!(
            args,
            [
                OsString::from("--port"),
                OsString::from("4100"),
                OsString::from("--config-dir"),
                root.path().as_os_str().to_owned(),
                OsString::from("--persistence"),
                OsString::from("auto"),
                OsString::from("--service-mode"),
            ]
        );
        assert!(inject_runtime_arguments(
            &mut vec![OsString::from("--config-dir")],
            root.path(),
            PersistenceMode::Auto,
        )
        .is_err());
    }

    #[test]
    fn companion_policy_uses_the_injected_capability_probe() {
        fn supported(_: &Path) -> bool {
            true
        }

        let install = InstallConfig {
            program: env::current_exe().unwrap(),
            args: Vec::new(),
            companion: Some(CompanionConfig {
                program: env::current_exe().unwrap(),
                args: Vec::new(),
            }),
            systray: SystrayMode::Auto,
        };
        assert!(resolve_companion_policy(&install, supported).unwrap());
    }

    #[test]
    fn stored_process_spec_preserves_exact_executable_and_arguments() {
        let executable = env::current_exe().unwrap();
        let stored = StoredConfiguration {
            program: path_text(&executable).unwrap(),
            arguments: vec!["--profile".into(), "workspace name".into()],
            companion_program: None,
            companion_arguments: None,
            host: "127.0.0.1".into(),
            port: 4100,
        };
        let (program, arguments) = stored_process_spec(&stored).unwrap();
        assert_eq!(program, executable);
        assert_eq!(
            arguments,
            [
                OsString::from("--profile"),
                OsString::from("workspace name")
            ]
        );
    }

    #[test]
    fn systray_mode_rejects_unknown_values() {
        assert_eq!(SystrayMode::default(), SystrayMode::Auto);
        assert_eq!("auto".parse(), Ok(SystrayMode::Auto));
        assert!("sometimes".parse::<SystrayMode>().is_err());
    }

    #[test]
    fn requirements_reuse_install_parsing_and_defaults() {
        let cli = ServiceCli {
            command: ServiceCommand::Requirements(ServiceRequirementsCommand {
                companion: None,
                install_args: vec![
                    OsString::from("--config-dir"),
                    OsString::from("/custom/service"),
                ],
            }),
        };
        let mut definition = ServiceDefinition::new("fixture", 4100).unwrap();
        definition.companion_support_detector = |_| false;
        let requirements = cli.requirements(&definition).unwrap().unwrap();

        assert!(requirements.companion_asset_required);
        assert_eq!(requirements.companion_supported, None);
        assert_eq!(
            requirements.install_args,
            ["--config-dir", "/custom/service"]
        );
    }

    #[test]
    fn requirements_insert_companion_before_server_arguments() {
        let executable = env::current_exe().unwrap();
        let cli = ServiceCli {
            command: ServiceCommand::Requirements(ServiceRequirementsCommand {
                companion: Some(executable.clone()),
                install_args: vec![
                    OsString::from("--config-dir"),
                    OsString::from("/custom/service"),
                    OsString::from("--"),
                    OsString::from("--profile"),
                    OsString::from("fixture"),
                ],
            }),
        };
        let mut definition = ServiceDefinition::new("fixture", 4100).unwrap();
        definition.companion_support_detector = |_| false;
        let requirements = cli.requirements(&definition).unwrap().unwrap();
        let executable = executable.to_str().unwrap();

        assert!(!requirements.companion_asset_required);
        assert_eq!(requirements.companion_supported, Some(false));
        assert_eq!(
            requirements.install_args,
            [
                "--config-dir",
                "/custom/service",
                "--companion",
                executable,
                "--",
                "--profile",
                "fixture",
            ]
        );
    }

    #[test]
    fn runtime_guard_precedes_service_and_storage_access() {
        fn invalid_runtime() -> bool {
            true
        }

        let root = tempdir().unwrap();
        let config = ServiceConfig::with_config_root("fixture", 4100, root.path())
            .unwrap()
            .with_invalid_runtime_detector(invalid_runtime);
        let lifecycle = ServiceLifecycle::new(config);

        assert!(lifecycle
            .status()
            .unwrap_err()
            .to_string()
            .contains("Databricks App"));
        assert!(!root.path().join("fixture").exists());
    }
}
