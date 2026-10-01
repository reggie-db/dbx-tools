//! Model-proxy adapter for the shared native service desktop runtime.

#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

use clap::{CommandFactory, FromArgMatches, Parser};
use dbx_tools_core::build_info;
use dbx_tools_service::{
    desktop::{run_desktop, DesktopCli, DesktopConfig, DesktopIcon},
    ServiceConfig,
};

#[derive(Clone, Debug, Parser)]
#[command(name = "dbx-model-proxy-desktop")]
struct Cli {
    #[command(flatten)]
    desktop: DesktopCli,
}

fn proxy_icon() -> DesktopIcon {
    let mut rgba = Vec::with_capacity(32 * 32 * 4);
    #[cfg(target_os = "macos")]
    let color = [0x00, 0x00, 0x00, 0xff];
    #[cfg(not(target_os = "macos"))]
    let color = [0xff, 0x36, 0x21, 0xff];
    let rectangles = [
        (4, 13, 6, 6),
        (24, 4, 6, 6),
        (24, 13, 6, 6),
        (24, 22, 6, 6),
        (10, 15, 6, 2),
        (16, 6, 2, 20),
        (18, 6, 6, 2),
        (18, 15, 6, 2),
        (18, 24, 6, 2),
    ];
    for y in 0..32 {
        for x in 0..32 {
            let inside = rectangles.iter().any(|(left, top, width, height)| {
                (*left..*left + *width).contains(&x) && (*top..*top + *height).contains(&y)
            });
            rgba.extend_from_slice(if inside { &color } else { &[0, 0, 0, 0] });
        }
    }
    DesktopIcon::new(rgba, 32, 32)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::from_arg_matches(&Cli::command().version(build_info::version()).get_matches())?;
    let service = ServiceConfig::new("model-proxy", 4000)?
        .with_invalid_runtime_detector(dbx_tools_core::is_databricks_app);
    let config = DesktopConfig::new(
        service.clone(),
        "dbx model proxy",
        service.metrics_url(),
        service.health_url(),
        proxy_icon(),
    )
    .with_template_icon(true);
    run_desktop(cli.desktop, config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_supplies_model_proxy_identity_and_endpoints() {
        let cli = Cli::try_parse_from(["dbx-model-proxy-desktop"]).unwrap();
        let service = ServiceConfig::with_config_root("model-proxy", 4000, "/tmp").unwrap();

        assert_eq!(service.metrics_url(), "http://127.0.0.1:4000/metrics");
        assert_eq!(service.health_url(), "http://127.0.0.1:4000/api/healthz");
        assert!(!cli.desktop.probe);
        let icon = proxy_icon();
        let opaque = icon
            .rgba
            .chunks_exact(4)
            .filter(|pixel| pixel[3] != 0)
            .count();
        assert_eq!((icon.width, icon.height), (32, 32));
        assert!(opaque > 0 && opaque < (icon.width * icon.height) as usize);
    }
}
