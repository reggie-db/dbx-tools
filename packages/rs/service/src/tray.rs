//! Reusable native tray event loop without a WebView or product-specific menu.

use std::sync::Arc;

use clap::Args;
use tray_icon::TrayIconBuilder;

#[cfg(target_os = "linux")]
use std::{sync::mpsc, time::Duration};

use crate::{Result, ServiceConfig};

pub use tray_icon::{
    menu::{CheckMenuItem, Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem, Submenu},
    Icon, TrayIcon,
};

/// Work scheduled onto the native tray event-loop thread.
pub type TrayCommand = Box<dyn FnOnce(&TrayIcon) + Send + 'static>;

/// Result of dispatching one consumer-owned menu event.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrayControl {
    /// Keep the tray process running.
    Continue,
    /// Exit the tray process.
    Quit,
}

/// Thread-safe dispatcher for updating native tray state.
#[derive(Clone)]
pub struct TrayHandle {
    dispatch: Arc<dyn Fn(TrayCommand) + Send + Sync>,
}

impl TrayHandle {
    /// Schedule one tray mutation on the platform event-loop thread.
    pub fn dispatch(&self, command: impl FnOnce(&TrayIcon) + Send + 'static) {
        (self.dispatch)(Box::new(command));
    }
}

/// Consumer callback invoked after the native tray is ready.
pub type TrayReady = Arc<dyn Fn(TrayHandle) + Send + Sync>;

/// Consumer callback for product-owned menu behavior.
pub type TrayMenuHandler = Arc<dyn Fn(&MenuEvent, &TrayIcon) -> Result<TrayControl> + Send + Sync>;

/// Native tray identity and consumer-owned menu callbacks.
pub struct TrayConfig {
    /// Shared service runtime and managed-runtime guard.
    pub service: ServiceConfig,
    /// Tooltip shown for the tray icon.
    pub title: String,
    /// Initial native icon.
    pub icon: Icon,
    /// Initial product-owned menu.
    pub menu: Menu,
    /// Whether macOS renders the icon as a template image.
    pub icon_as_template: bool,
    /// Called after startup so consumers can load menu state asynchronously.
    pub on_ready: TrayReady,
    /// Called for each native menu activation.
    pub on_menu: TrayMenuHandler,
}

/// Generic tray-only command-line options.
#[derive(Clone, Debug, Args)]
pub struct TrayCli {
    /// Probe native tray capability and exit.
    #[arg(long, hide = true)]
    pub probe: bool,
}

fn build_tray(config: &TrayConfig) -> Result<TrayIcon> {
    Ok(TrayIconBuilder::new()
        .with_tooltip(&config.title)
        .with_icon(config.icon.clone())
        .with_icon_as_template(config.icon_as_template)
        .with_menu(Box::new(config.menu.clone()))
        .build()?)
}

#[cfg(target_os = "linux")]
fn run(config: TrayConfig, probe: bool) -> Result<()> {
    let tray = build_tray(&config)?;
    if probe {
        return Ok(());
    }
    let (command_tx, command_rx) = mpsc::channel::<TrayCommand>();
    let handle = TrayHandle {
        dispatch: Arc::new(move |command| {
            let _ = command_tx.send(command);
        }),
    };
    (config.on_ready)(handle);
    loop {
        while let Ok(command) = command_rx.try_recv() {
            command(&tray);
        }
        if let Ok(event) = MenuEvent::receiver().recv_timeout(Duration::from_millis(100)) {
            if (config.on_menu)(&event, &tray)? == TrayControl::Quit {
                return Ok(());
            }
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn run(config: TrayConfig, probe: bool) -> Result<()> {
    use tao::{
        event::{Event, StartCause},
        event_loop::{ControlFlow, EventLoopBuilder},
    };

    enum UserEvent {
        Menu(MenuEvent),
        Command(TrayCommand),
    }

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |event| {
        let _ = proxy.send_event(UserEvent::Menu(event));
    }));
    let command_proxy = event_loop.create_proxy();
    let handle = TrayHandle {
        dispatch: Arc::new(move |command| {
            let _ = command_proxy.send_event(UserEvent::Command(command));
        }),
    };
    let mut tray: Option<TrayIcon> = None;
    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => match build_tray(&config) {
                Ok(created) => {
                    tray = Some(created);
                    if probe {
                        *control_flow = ControlFlow::Exit;
                    } else {
                        (config.on_ready)(handle.clone());
                    }
                }
                Err(error) => {
                    tracing::error!(%error, "native tray could not start");
                    *control_flow = ControlFlow::ExitWithCode(1);
                }
            },
            Event::UserEvent(UserEvent::Menu(event)) => {
                if let Some(tray) = &tray {
                    match (config.on_menu)(&event, tray) {
                        Ok(TrayControl::Continue) => {}
                        Ok(TrayControl::Quit) => *control_flow = ControlFlow::Exit,
                        Err(error) => tracing::error!(%error, "tray menu action failed"),
                    }
                }
            }
            Event::UserEvent(UserEvent::Command(command)) => {
                if let Some(tray) = &tray {
                    command(tray);
                }
            }
            _ => {}
        }
    });
}

/// Replace the product-owned menu on the tray event-loop thread.
pub fn replace_menu(tray: &TrayIcon, menu: Menu) -> Result<()> {
    tray.set_menu(Some(Box::new(menu)));
    Ok(())
}

/// Run the native tray after enforcing the service runtime guard.
pub fn run_tray(cli: TrayCli, config: TrayConfig) -> Result<()> {
    config.service.ensure_runtime()?;
    run(config, cli.probe)
}
