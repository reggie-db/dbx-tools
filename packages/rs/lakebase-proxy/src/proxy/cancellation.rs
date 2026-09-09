//! PostgreSQL cancellation key mapping and forwarding.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicI32, Ordering},
        Arc,
    },
};

use bytes::Bytes;
use futures::SinkExt;
use pgwire::messages::{
    cancel::CancelRequest, startup::SecretKey, PgWireFrontendMessage, ProtocolVersion,
};
use tokio_rustls::TlsConnector;

use super::{startup::connect_postgres_tls, ProxyError};

static NEXT_PROCESS_ID: AtomicI32 = AtomicI32::new(10_000);

#[derive(Clone, Default)]
pub(super) struct PostgresCancellationMap {
    targets: Arc<tokio::sync::Mutex<HashMap<(i32, Bytes), PostgresCancelTarget>>>,
}

impl PostgresCancellationMap {
    pub(super) fn next_synthetic_process_id(&self) -> i32 {
        NEXT_PROCESS_ID.fetch_add(1, Ordering::Relaxed)
    }

    pub(super) fn synthetic_secret(&self, protocol: ProtocolVersion, process_id: i32) -> SecretKey {
        let secret = process_id.rotate_left(13) ^ 0x5a17_2c4d;
        if protocol == ProtocolVersion::PROTOCOL3_0 {
            SecretKey::I32(secret)
        } else {
            SecretKey::Bytes(Bytes::copy_from_slice(&secret.to_be_bytes()))
        }
    }

    pub(super) async fn register_postgres_cancellation(
        &self,
        process_id: i32,
        secret: &SecretKey,
        target: PostgresCancelTarget,
    ) {
        self.targets
            .lock()
            .await
            .insert((process_id, secret.to_bytes()), target);
    }

    pub(super) async fn remove_postgres_cancellation(&self, process_id: i32, secret: &SecretKey) {
        self.targets
            .lock()
            .await
            .remove(&(process_id, secret.to_bytes()));
    }

    pub(super) async fn forward_postgres_cancellation(&self, request: CancelRequest) {
        let target = self
            .targets
            .lock()
            .await
            .get(&(request.pid, request.secret_key.to_bytes()))
            .cloned();
        if let Some(target) = target {
            let _ = target.forward_postgres_cancellation().await;
        }
    }
}

#[derive(Clone)]
pub(super) struct PostgresCancelTarget {
    tls: TlsConnector,
    host: String,
    port: u16,
    process_id: i32,
    secret: SecretKey,
}

impl PostgresCancelTarget {
    pub(super) fn new(
        tls: TlsConnector,
        host: String,
        port: u16,
        process_id: i32,
        secret: SecretKey,
    ) -> Self {
        Self {
            tls,
            host,
            port,
            process_id,
            secret,
        }
    }

    async fn forward_postgres_cancellation(&self) -> Result<(), ProxyError> {
        let mut socket = connect_postgres_tls(
            &self.host,
            self.port,
            self.tls.clone(),
            ProtocolVersion::PROTOCOL3_0,
        )
        .await?;
        socket
            .send(PgWireFrontendMessage::CancelRequest(CancelRequest::new(
                self.process_id,
                self.secret.clone(),
            )))
            .await?;
        socket.close().await?;
        Ok(())
    }
}
