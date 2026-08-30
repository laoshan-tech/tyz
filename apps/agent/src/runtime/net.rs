//! Per-connection forwarding: pick a target (LB), dial (plain or kaminari
//! TLS), then run the counting bidirectional copy. Semantics track realm's
//! `connect_and_relay`: no socket options are set (decision D5 — kernel
//! defaults everywhere).

use std::io;
use std::net::IpAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use kaminari::mix::{MixAccept, MixConnect, MixServerStream};
use kaminari::{AsyncAccept, AsyncConnect};
use realm_lb::{BalanceCtx, Token};
use tokio::net::TcpStream;

use crate::runtime::zero;
use crate::stats::{ConnGuard, Counters, TxCounter};
use crate::translate::{DesiredService, TargetAddr};

/// Handshake scratch buffer (realm uses buf_size() = 16K for the same).
const HANDSHAKE_BUF: usize = 16 * 1024;

/// The client side of a connection: raw TCP, or TLS-terminated (exit legs
/// handshake before forwarding starts).
pub enum ClientConn {
    Plain(TcpStream),
    Tls(Box<MixServerStream<TcpStream>>),
}

/// Everything a connection task needs, shared from its service.
pub struct ConnContext {
    pub service: Arc<DesiredService>,
    /// Target-side TLS connector (entry legs dial with TLS).
    pub connector: Option<Arc<MixConnect>>,
}

/// Terminate TLS on an accepted exit-leg socket (before forwarding starts).
pub async fn tls_accept(sock: TcpStream, acceptor: &MixAccept) -> io::Result<MixServerStream<TcpStream>> {
    let mut hs = vec![0u8; HANDSHAKE_BUF];
    acceptor.accept(sock, &mut hs).await
}

/// Forward one connection to its end.
pub async fn handle_conn(client: ClientConn, peer_ip: IpAddr, ctx: Arc<ConnContext>, guard: ConnGuard) {
    let name = ctx.service.raw.name.as_str();
    let counters = guard.counters();
    let timeout = ctx.service.connect_timeout;

    // LB pick: Token(0) = primary target, Token(i) = targets[i].
    let target_idx = match &ctx.service.balancer {
        Some(balancer) => match balancer.next(BalanceCtx { src_ip: &peer_ip }) {
            Some(Token(0)) | None => 0,
            Some(Token(i)) => (i as usize).min(ctx.service.targets.len() - 1),
        },
        None => 0,
    };
    let target: &TargetAddr = &ctx.service.targets[target_idx];

    let result = dial_and_forward(client, target, &ctx, timeout, counters).await;
    if let Err(err) = result {
        tracing::debug!(service = name, target = %target, "connection failed: {err}");
        for c in counters {
            c.total_errs.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// Byte accounting: the hot atomics live on the SERVICE-level counters (the
/// ledger consumes those); the per-client breakdown is synced once at
/// connection end from the returned totals.
fn sync_client_level(counters: [&Arc<Counters>; 2], a_to_b: u64, b_to_a: u64) {
    counters[1].input_bytes.store(a_to_b, Ordering::Relaxed);
    counters[1].output_bytes.store(b_to_a, Ordering::Relaxed);
    counters[1].total_conns.store(counters[0].total_conns.load(Ordering::Relaxed), Ordering::Relaxed);
    counters[1].total_errs.store(counters[0].total_errs.load(Ordering::Relaxed), Ordering::Relaxed);
}

async fn dial(
    target: &TargetAddr,
    timeout: Duration,
) -> io::Result<TcpStream> {
    tokio::time::timeout(timeout, TcpStream::connect((target.host.as_str(), target.port)))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "connect timeout"))?
}

async fn dial_and_forward(
    client: ClientConn,
    target: &TargetAddr,
    ctx: &ConnContext,
    timeout: Duration,
    counters: [&Arc<Counters>; 2],
) -> io::Result<()> {
    let up = counters[0].input_handle();
    let down = counters[0].output_handle();

    match client {
        // Plain client + plain target (entry leg without TLS, exit leg
        // without TLS, single-node direct): the splice zero-copy path.
        ClientConn::Plain(client) if ctx.service.tls.is_none() => {
            let sock = dial(target, timeout).await?;
            let (a2b, b2a) = zero::bidi_copy_counted(client, sock, up, down).await?;
            sync_client_level(counters, a2b, b2a);
            Ok(())
        }
        // Plain client + TLS target (entry leg): kaminari client handshake,
        // then userland copy (realm itself goes userland under transport).
        ClientConn::Plain(mut client) => {
            let connector = ctx
                .connector
                .as_ref()
                .expect("translate guarantees a connector for tls connect legs");
            let sock = dial(target, timeout).await?;
            let mut hs = vec![0u8; HANDSHAKE_BUF];
            let tls_stream = connector.connect(sock, &mut hs).await?;
            let (a2b, b2a) = copy_tls_target(&mut client, tls_stream, up, down).await?;
            sync_client_level(counters, a2b, b2a);
            Ok(())
        }
        // TLS-terminated client + plain target (exit leg).
        ClientConn::Tls(mut tls_client) => {
            let sock = dial(target, timeout).await?;
            let (a2b, b2a) = copy_tls_client(&mut tls_client, sock, up, down).await?;
            sync_client_level(counters, a2b, b2a);
            Ok(())
        }
    }
}

use kaminari::IOStream;
use realm_io::statistic::StatStream;
use tokio::io::{AsyncRead, AsyncWrite};

/// Userland counting copy for TLS legs: writes INTO target = upload
/// (client→target), writes INTO client = download. `StatStream` counts
/// successful poll_writes on the stream it wraps — realm itself goes
/// userland whenever a transport is in play.
async fn bidi_copy_userland<A, B>(
    client: &mut A,
    target: &mut B,
    up: zero::DirectionCounter,
    down: zero::DirectionCounter,
) -> io::Result<(u64, u64)>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let mut target = StatStream::new(target, TxCounter(up));
    let mut client = StatStream::new(client, TxCounter(down));
    realm_io::bidi_copy(&mut client, &mut target).await
}

async fn copy_tls_target<S>(
    client: &mut TcpStream,
    target: S,
    up: zero::DirectionCounter,
    down: zero::DirectionCounter,
) -> io::Result<(u64, u64)>
where
    S: IOStream,
{
    let mut target = target;
    bidi_copy_userland(client, &mut target, up, down).await
}

async fn copy_tls_client<S>(
    client: &mut S,
    target: TcpStream,
    up: zero::DirectionCounter,
    down: zero::DirectionCounter,
) -> io::Result<(u64, u64)>
where
    S: IOStream,
{
    let mut target = target;
    bidi_copy_userland(client, &mut target, up, down).await
}
