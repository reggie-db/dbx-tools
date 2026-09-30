use clap::Parser;
use ubrn_cli::{cli, Result};

fn main() -> Result<()> {
    cli::CliArgs::parse().run()
}
