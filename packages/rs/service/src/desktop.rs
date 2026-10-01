//! Optional native tray and system WebView runtime for managed services.

use std::{sync::Arc, time::Duration};

use clap::Args;
use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem},
    Icon, TrayIcon, TrayIconBuilder,
};

use crate::{Result, ServiceConfig, ServiceLifecycle};

pub type HealthCheck = Arc<dyn Fn(&str) -> bool + Send + Sync>;
pub type UrlOpener = Arc<dyn Fn(&str) -> Result<()> + Send + Sync>;

#[derive(Clone, Debug)]
pub struct DesktopIcon {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

impl DesktopIcon {
    pub fn new(rgba: Vec<u8>, width: u32, height: u32) -> Self {
        Self {
            rgba,
            width,
            height,
        }
    }
}

#[derive(Clone, Debug, Args)]
pub struct DesktopCli {
    /// URL opened from the tray.
    #[arg(long)]
    pub url: Option<String>,
    /// Service health URL.
    #[arg(long)]
    pub health_url: Option<String>,
    /// Probe native tray capability and exit.
    #[arg(long, hide = true)]
    pub probe: bool,
}

#[derive(Clone)]
pub struct DesktopConfig {
    pub service: ServiceConfig,
    pub title: String,
    pub url: String,
    pub health_url: String,
    pub icon: DesktopIcon,
    pub icon_as_template: bool,
    pub health_check: HealthCheck,
    pub open_url: UrlOpener,
}

impl DesktopConfig {
    pub fn new(
        service: ServiceConfig,
        title: impl Into<String>,
        url: impl Into<String>,
        health_url: impl Into<String>,
        icon: DesktopIcon,
    ) -> Self {
        Self {
            service,
            title: title.into(),
            url: url.into(),
            health_url: health_url.into(),
            icon,
            icon_as_template: false,
            health_check: Arc::new(default_health_check),
            open_url: Arc::new(default_open_url),
        }
    }

    pub fn with_template_icon(mut self, icon_as_template: bool) -> Self {
        self.icon_as_template = icon_as_template;
        self
    }

    pub fn with_health_check(mut self, health_check: HealthCheck) -> Self {
        self.health_check = health_check;
        self
    }

    pub fn with_url_opener(mut self, open_url: UrlOpener) -> Self {
        self.open_url = open_url;
        self
    }
}

struct Tray {
    icon: TrayIcon,
    open: MenuItem,
    status: MenuItem,
    start: MenuItem,
    stop: MenuItem,
    restart: MenuItem,
    quit: MenuItem,
}

impl Tray {
    fn new(config: &DesktopConfig) -> Result<Self> {
        let open = MenuItem::new(format!("Open {}", config.title), true, None);
        let status = MenuItem::new("Service: checking", false, None);
        let start = MenuItem::new("Start service", true, None);
        let stop = MenuItem::new("Stop service", true, None);
        let restart = MenuItem::new("Restart service", true, None);
        let quit = MenuItem::new("Quit", true, None);
        let menu = Menu::with_items(&[&open, &status, &start, &stop, &restart, &quit])?;
        let icon = TrayIconBuilder::new()
            .with_tooltip(&config.title)
            .with_icon(Icon::from_rgba(
                config.icon.rgba.clone(),
                config.icon.width,
                config.icon.height,
            )?)
            .with_icon_as_template(config.icon_as_template)
            .with_menu(Box::new(menu))
            .build()?;
        Ok(Self {
            icon,
            open,
            status,
            start,
            stop,
            restart,
            quit,
        })
    }

    fn set_status(&self, text: &str) {
        self.status.set_text(format!("Service: {text}"));
        let _ = self.icon.set_tooltip(Some(format!("Service: {text}")));
    }

    fn set_healthy(&self, healthy: bool) {
        self.set_status(if healthy { "healthy" } else { "unavailable" });
    }

    fn handle_lifecycle(&self, event: &MenuEvent, config: &DesktopConfig) -> bool {
        let lifecycle = ServiceLifecycle::new(config.service.clone());
        let result = if event.id == *self.start.id() {
            Some(lifecycle.start())
        } else if event.id == *self.stop.id() {
            Some(lifecycle.stop())
        } else if event.id == *self.restart.id() {
            Some(lifecycle.restart())
        } else {
            None
        };
        if let Some(result) = result {
            match result {
                Ok(status) => self.set_status(&status.registration),
                Err(error) => self.set_status(&format!("error: {error}")),
            }
            true
        } else {
            false
        }
    }
}

fn default_health_check(url: &str) -> bool {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .and_then(|client| client.get(url).send())
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

fn default_open_url(url: &str) -> Result<()> {
    open::that(url).map_err(Into::into)
}

#[cfg(target_os = "linux")]
fn run(config: DesktopConfig, probe: bool) -> Result<()> {
    let tray = Tray::new(&config)?;
    if probe {
        return Ok(());
    }
    let mut last_check = std::time::Instant::now() - Duration::from_secs(10);
    loop {
        if last_check.elapsed() >= Duration::from_secs(10) {
            tray.set_healthy((config.health_check)(&config.health_url));
            last_check = std::time::Instant::now();
        }
        if let Ok(event) = MenuEvent::receiver().recv_timeout(Duration::from_millis(250)) {
            if event.id == *tray.open.id() {
                (config.open_url)(&config.url)?;
            } else if event.id == *tray.quit.id() {
                return Ok(());
            } else {
                tray.handle_lifecycle(&event, &config);
            }
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn run(config: DesktopConfig, probe: bool) -> Result<()> {
    use tao::{
        event::{Event, StartCause, WindowEvent},
        event_loop::{ControlFlow, EventLoopBuilder},
        window::{Window, WindowBuilder},
    };

    enum UserEvent {
        Menu(MenuEvent),
        Health(bool),
    }

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |event| {
        let _ = proxy.send_event(UserEvent::Menu(event));
    }));
    if !probe {
        let proxy = event_loop.create_proxy();
        let health_url = config.health_url.clone();
        let health_check = config.health_check.clone();
        std::thread::spawn(move || loop {
            let _ = proxy.send_event(UserEvent::Health(health_check(&health_url)));
            std::thread::sleep(Duration::from_secs(10));
        });
    }

    let mut tray: Option<Tray> = None;
    let mut webview: Option<(Window, wry::WebView)> = None;
    event_loop.run(move |event, event_loop_target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => {
                tray = Some(Tray::new(&config).expect("failed to create service tray"));
                if probe {
                    *control_flow = ControlFlow::Exit;
                }
            }
            Event::UserEvent(UserEvent::Health(healthy)) => {
                if let Some(tray) = &tray {
                    tray.set_healthy(healthy);
                }
            }
            Event::UserEvent(UserEvent::Menu(event)) => {
                let Some(tray) = &tray else {
                    return;
                };
                if event.id == *tray.open.id() {
                    if let Some((window, _)) = &webview {
                        window.set_visible(true);
                        window.set_focus();
                    } else {
                        let window = WindowBuilder::new()
                            .with_title(&config.title)
                            .build(event_loop_target)
                            .expect("failed to create service window");
                        let view = wry::WebViewBuilder::new()
                            .with_url(&config.url)
                            .build(&window)
                            .expect("failed to create service webview");
                        webview = Some((window, view));
                    }
                } else if event.id == *tray.quit.id() {
                    *control_flow = ControlFlow::Exit;
                } else {
                    tray.handle_lifecycle(&event, &config);
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                if let Some((window, _)) = &webview {
                    window.set_visible(false);
                }
            }
            _ => {}
        }
    });
}

pub fn run_desktop(cli: DesktopCli, mut config: DesktopConfig) -> Result<()> {
    config.service.ensure_runtime()?;
    if let Some(url) = cli.url {
        config.url = url;
    }
    if let Some(health_url) = cli.health_url {
        config.health_url = health_url;
    }
    run(config, cli.probe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_cli_keeps_consumer_defaults() {
        let cli = DesktopCli {
            url: None,
            health_url: None,
            probe: false,
        };
        let service = ServiceConfig::with_config_root("fixture", 4100, "/tmp").unwrap();
        let config = DesktopConfig::new(
            service,
            "Fixture",
            "http://127.0.0.1:4100/metrics",
            "http://127.0.0.1:4100/api/healthz",
            DesktopIcon::new(vec![0, 0, 0, 0], 1, 1),
        );

        assert_eq!(config.url, "http://127.0.0.1:4100/metrics");
        assert!(!config.icon_as_template);
        assert!(config.clone().with_template_icon(true).icon_as_template);
        assert!(!cli.probe);
    }
}
