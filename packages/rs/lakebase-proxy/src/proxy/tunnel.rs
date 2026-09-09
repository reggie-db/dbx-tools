//! Opaque PostgreSQL protocol tunneling.

use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};

use bytes::{Buf, BytesMut};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio_util::codec::Framed;

pub(super) async fn tunnel_postgres_connection<LocalIo, LocalCodec, UpstreamIo, UpstreamCodec>(
    local: Framed<LocalIo, LocalCodec>,
    upstream: Framed<UpstreamIo, UpstreamCodec>,
) -> Result<(), io::Error>
where
    LocalIo: AsyncRead + AsyncWrite + Unpin,
    UpstreamIo: AsyncRead + AsyncWrite + Unpin,
{
    let local_parts = local.into_parts();
    let upstream_parts = upstream.into_parts();
    let mut local = local_parts.io;
    let mut upstream = upstream_parts.io;
    if !local_parts.write_buf.is_empty() {
        local.write_all(&local_parts.write_buf).await?;
    }
    if !upstream_parts.write_buf.is_empty() {
        upstream.write_all(&upstream_parts.write_buf).await?;
    }
    if !upstream_parts.read_buf.is_empty() {
        local.write_all(&upstream_parts.read_buf).await?;
    }
    if !local_parts.read_buf.is_empty() {
        upstream.write_all(&local_parts.read_buf).await?;
    }
    local.flush().await?;
    upstream.flush().await?;
    tokio::io::copy_bidirectional(&mut local, &mut upstream).await?;
    Ok(())
}

pub(super) struct PrefixedIo<S> {
    inner: S,
    prefix: BytesMut,
}

impl<S> PrefixedIo<S> {
    pub(super) fn new(inner: S, prefix: BytesMut) -> Self {
        Self { inner, prefix }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for PrefixedIo<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if !self.prefix.is_empty() {
            let length = self.prefix.len().min(buffer.remaining());
            buffer.put_slice(&self.prefix[..length]);
            self.prefix.advance(length);
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(context, buffer)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for PrefixedIo<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<Result<usize, io::Error>> {
        Pin::new(&mut self.inner).poll_write(context, buffer)
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Result<(), io::Error>> {
        Pin::new(&mut self.inner).poll_flush(context)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Result<(), io::Error>> {
        Pin::new(&mut self.inner).poll_shutdown(context)
    }
}
