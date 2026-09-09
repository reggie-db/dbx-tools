//! PostgreSQL connection statistics and reporting.

use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use tracing::{debug, info};

const STATS_INTERVAL: Duration = Duration::from_secs(60);

/// Process-local counters for PostgreSQL proxy connections.
#[derive(Default)]
pub struct ConnectionStats {
    active: AtomicUsize,
    opened: AtomicU64,
    closed: AtomicU64,
    failed: AtomicU64,
}

impl ConnectionStats {
    /// Record and log an accepted local connection.
    pub fn connection_opened(&self, peer: SocketAddr) {
        self.active.fetch_add(1, Ordering::Relaxed);
        self.opened.fetch_add(1, Ordering::Relaxed);
        debug!(%peer, active = self.active.load(Ordering::Relaxed), "connection opened");
    }

    /// Record and log a closed local connection.
    pub fn connection_closed(
        &self,
        peer: SocketAddr,
        elapsed: Duration,
        failed: bool,
        error: Option<&str>,
    ) {
        self.active.fetch_sub(1, Ordering::Relaxed);
        self.closed.fetch_add(1, Ordering::Relaxed);
        if failed {
            self.failed.fetch_add(1, Ordering::Relaxed);
        }
        debug!(
            %peer,
            failed,
            error = error.unwrap_or_default(),
            duration_ms = elapsed.as_millis(),
            active = self.active.load(Ordering::Relaxed),
            "connection closed"
        );
    }
}

/// Log aggregate connection counters once per reporting interval.
pub async fn report_connection_stats(stats: Arc<ConnectionStats>) {
    let mut interval = tokio::time::interval(STATS_INTERVAL);
    interval.tick().await;
    loop {
        interval.tick().await;
        info!(
            period_seconds = STATS_INTERVAL.as_secs(),
            opened = stats.opened.swap(0, Ordering::Relaxed),
            closed = stats.closed.swap(0, Ordering::Relaxed),
            failed = stats.failed.swap(0, Ordering::Relaxed),
            active = stats.active.load(Ordering::Relaxed),
            "connection stats"
        );
    }
}
