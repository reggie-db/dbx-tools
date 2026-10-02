//! Native Tauri desktop entry point for the Databricks model proxy.

#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

use clap::{CommandFactory, FromArgMatches, Parser};
use dbx_tools_core::{build_info, init_logging_with_verbose};
use dbx_tools_model_proxy::ServerOptions;

#[derive(Clone, Debug, Parser)]
#[command(name = "dbx-model-proxy-desktop")]
struct Cli {
    /// Probe native desktop capability and exit.
    #[arg(long, hide = true)]
    probe: bool,
    #[command(flatten)]
    server: ServerOptions,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::from_arg_matches(&Cli::command().version(build_info::version()).get_matches())?;
    init_logging_with_verbose(cli.server.verbose())?;
    dbx_tools_model_proxy::desktop::run(
        (!cli.probe).then_some(cli.server.with_desktop_defaults()),
        cli.probe,
    )
    .await
}
