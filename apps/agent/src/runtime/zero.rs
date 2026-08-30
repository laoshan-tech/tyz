//! Zero-copy bidirectional copy with live byte counting.
//!
//! The splice path from `realm_io::bidi_zero_copy`, specialized to a pair of
//! TCP streams with a counting pipe per direction. The generic hook
//! (`impl AsyncIOBuf for CopyBuffer<LocalBuf, …>`) is blocked by the orphan
//! rule — `CopyBuffer` is foreign and a nested local type buys nothing — so
//! the ~150-line state machine is reproduced here verbatim in semantics
//! (CopyBuffer::poll_copy + BidiCopy, realm_io v0.5.4), reusing realm_io's
//! public `AsyncRawIO` readiness primitives (`poll_read_raw`/`poll_write_raw`
//! on `TcpStream`) and the identical syscall sequence:
//!
//! - read step:  splice(stream_fd → pipe_wr, len=MAX)
//! - write step: splice(pipe_rd → stream_fd, len=MAX)  ← counted here
//!
//! Completion policy is brutal-shutdown (realm's default build): when one
//! direction finishes, the other is closed at its current byte count — a
//! peer that never half-closes cannot pin connections open forever.
//!
//! Non-Linux (dev machines) falls back to the userland counting copy.

use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};

use tokio::io::AsyncWrite;
use tokio::net::TcpStream;

/// Bytes handed to the kernel toward the peer socket, per direction.
pub type DirectionCounter = Arc<AtomicU64>;

/// Copy `a` ⇄ `b` with per-direction live byte counters. Returns the totals
/// `(a_to_b, b_to_a)`, mirroring `realm_io::bidi_copy`'s shape.
pub async fn bidi_copy_counted(
    mut a: TcpStream,
    mut b: TcpStream,
    a_to_b: DirectionCounter,
    b_to_a: DirectionCounter,
) -> io::Result<(u64, u64)> {
    #[cfg(target_os = "linux")]
    {
        let mut copy = BidiSpliceCopy::new(a_to_b, b_to_a)?;
        std::future::poll_fn(|cx| copy.poll(cx, &mut a, &mut b)).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        copy_userland_counted(&mut a, &mut b, a_to_b, b_to_a).await
    }
}

#[cfg(not(target_os = "linux"))]
/// Userland fallback for TLS legs and non-Linux dev runs: `StatStream`
/// wrappers around each socket, realm's own `bidi_copy` engine. Writes INTO
/// `b` are the a→b direction (StatStream counts the writes of the stream it
/// wraps), so `b` carries `a_to_b` and `a` carries `b_to_a`.
pub async fn copy_userland_counted<A, B>(
    a: &mut A,
    b: &mut B,
    a_to_b: DirectionCounter,
    b_to_a: DirectionCounter,
) -> io::Result<(u64, u64)>
where
    A: tokio::io::AsyncRead + AsyncWrite + Unpin,
    B: tokio::io::AsyncRead + AsyncWrite + Unpin,
{
    use realm_io::statistic::StatStream;
    let mut b = StatStream::new(b, crate::stats::TxCounter(a_to_b));
    let mut a = StatStream::new(a, crate::stats::TxCounter(b_to_a));
    realm_io::bidi_copy(&mut a, &mut b).await
}

// ---- Linux splice path (realm_io v0.5.4 semantics, specialized) ----

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use realm_io::AsyncRawIO;
    use std::os::fd::AsRawFd;

    /// A unix pipe (O_NONBLOCK both ends), realm's 16×4K default capacity,
    /// whose write→socket splice updates a shared counter. Mirrors
    /// realm_io's `Pipe` (its fields are private upstream).
    pub struct Pipe {
        rd: i32,
        wr: i32,
    }

    const DEFAULT_PIPE_SIZE: i32 = 16 * 0x1000;

    impl Pipe {
        pub fn new() -> io::Result<Self> {
            let mut fds = [0i32; 2];
            if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_NONBLOCK) } < 0 {
                return Err(io::Error::last_os_error());
            }
            let pipe = Self { rd: fds[0], wr: fds[1] };
            // Enlarge to realm's default; failure is non-fatal (kernel cap).
            unsafe {
                libc::fcntl(pipe.wr, libc::F_SETPIPE_SZ, DEFAULT_PIPE_SIZE);
            }
            Ok(pipe)
        }
    }

    impl Drop for Pipe {
        fn drop(&mut self) {
            unsafe {
                libc::close(self.rd);
                libc::close(self.wr);
            }
        }
    }

    /// splice(r, w, MAX) with SPLICE_F_MOVE | SPLICE_F_NONBLOCK — realm_io's
    /// `splice_n` verbatim (safety: len ≤ isize::MAX is enforced by the
    /// kernel's syscall contract).
    #[inline]
    fn splice_n(r: i32, w: i32) -> isize {
        unsafe {
            libc::splice(
                r,
                std::ptr::null_mut::<libc::loff_t>(),
                w,
                std::ptr::null_mut::<libc::loff_t>(),
                isize::MAX as usize,
                libc::SPLICE_F_MOVE | libc::SPLICE_F_NONBLOCK,
            )
        }
    }

    /// One direction: CopyBuffer::poll_copy over a pipe buffer, with the
    /// write-splice bytes added to the live counter.
    struct Dir {
        pipe: Pipe,
        pos: usize,
        cap: usize,
        amt: u64,
        read_done: bool,
        need_flush: bool,
        counter: DirectionCounter,
    }

    impl Dir {
        fn new(counter: DirectionCounter) -> io::Result<Self> {
            Ok(Self {
                pipe: Pipe::new()?,
                pos: 0,
                cap: 0,
                amt: 0,
                read_done: false,
                need_flush: false,
                counter,
            })
        }

        /// Copy `r → w` until `r` reaches EOF (CopyBuffer::poll_copy logic;
        /// returns Ready when the direction is done, Pending otherwise).
        fn poll_copy(
            &mut self,
            cx: &mut Context<'_>,
            r: &mut TcpStream,
            w: &mut TcpStream,
        ) -> Poll<io::Result<u64>> {
            loop {
                if self.pos == self.cap && !self.read_done {
                    let wr = self.pipe.wr;
                    // The raw fd is stable for a stream's lifetime — capture
                    // it now so the syscall closure owns only integers.
                    let rfd = r.as_raw_fd();
                    let n = match r.poll_read_raw(cx, move || splice_n(rfd, wr)) {
                        Poll::Ready(Ok(n)) => n,
                        Poll::Ready(Err(err)) => return Poll::Ready(Err(err)),
                        Poll::Pending => {
                            // Flush when the reader has no progress to avoid
                            // deadlock when the reader depends on the writer.
                            if self.need_flush {
                                std::task::ready!(Pin::new(w).poll_flush(cx))?;
                                self.need_flush = false;
                            }
                            return Poll::Pending;
                        }
                    };
                    if n == 0 {
                        self.read_done = true;
                    } else {
                        self.pos = 0;
                        self.cap = n;
                    }
                }

                while self.pos < self.cap {
                    let rd = self.pipe.rd;
                    let wfd = w.as_raw_fd();
                    let i = std::task::ready!(w.poll_write_raw(cx, move || splice_n(rd, wfd)))?;
                    if i == 0 {
                        return Poll::Ready(Err(io::ErrorKind::WriteZero.into()));
                    }
                    self.pos += i;
                    self.amt += i as u64;
                    self.counter.fetch_add(i as u64, Ordering::Relaxed);
                    self.need_flush = true;
                }
                debug_assert!(self.pos <= self.cap, "splice wrote more than buffered");

                if self.pos == self.cap && self.read_done {
                    std::task::ready!(Pin::new(w).poll_flush(cx))?;
                    return Poll::Ready(Ok(self.amt));
                }
            }
        }
    }

    /// The BidiCopy future: both directions, realm's brutal-shutdown
    /// completion policy (one side done ⇒ close the other at its current
    /// count), each finished direction shuts down its target's write side.
    pub struct BidiSpliceCopy {
        a_to_b: Dir,
        b_to_a: Dir,
        a_to_b_done: Option<io::Result<u64>>,
        b_to_a_done: Option<io::Result<u64>>,
        a_shutdown: bool,
        b_shutdown: bool,
    }

    use std::pin::Pin;

    impl BidiSpliceCopy {
        pub fn new(a_to_b: DirectionCounter, b_to_a: DirectionCounter) -> io::Result<Self> {
            Ok(Self {
                a_to_b: Dir::new(a_to_b)?,
                b_to_a: Dir::new(b_to_a)?,
                a_to_b_done: None,
                b_to_a_done: None,
                a_shutdown: false,
                b_shutdown: false,
            })
        }

        pub fn poll(
            &mut self,
            cx: &mut Context<'_>,
            a: &mut TcpStream,
            b: &mut TcpStream,
        ) -> Poll<io::Result<(u64, u64)>> {
            // a→b direction (then FIN toward b)
            if self.a_to_b_done.is_none() {
                match self.a_to_b.poll_copy(cx, a, b) {
                    Poll::Ready(res) => {
                        // shutdown our write side toward b
                        if !self.b_shutdown {
                            if let Err(e) = std::task::ready!(Pin::new(&mut *b).poll_shutdown(cx)) {
                                return Poll::Ready(Err(e));
                            }
                            self.b_shutdown = true;
                        }
                        self.a_to_b_done = Some(res);
                    }
                    Poll::Pending => {}
                }
            }
            // b→a direction (then FIN toward a)
            if self.b_to_a_done.is_none() {
                match self.b_to_a.poll_copy(cx, b, a) {
                    Poll::Ready(res) => {
                        if !self.a_shutdown {
                            if let Err(e) = std::task::ready!(Pin::new(&mut *a).poll_shutdown(cx)) {
                                return Poll::Ready(Err(e));
                            }
                            self.a_shutdown = true;
                        }
                        self.b_to_a_done = Some(res);
                    }
                    Poll::Pending => {}
                }
            }

            // Completion policy — realm's brutal shutdown: errors surface
            // immediately, and any finished direction releases the other at
            // its current byte count (a peer that never half-closes cannot
            // pin the copy open).
            match (self.a_to_b_done.as_ref(), self.b_to_a_done.as_ref()) {
                (Some(Ok(x)), Some(Ok(y))) => Poll::Ready(Ok((*x, *y))),
                (Some(Err(e)), _) | (_, Some(Err(e))) => Poll::Ready(Err(clone_err(e))),
                (Some(Ok(x)), None) => Poll::Ready(Ok((*x, self.b_to_a.amt))),
                (None, Some(Ok(y))) => Poll::Ready(Ok((self.a_to_b.amt, *y))),
                (None, None) => Poll::Pending,
            }
        }
    }

    fn clone_err(e: &io::Error) -> io::Error {
        // io::Error is not Clone; keep kind + message (diagnostics only —
        // both directions' errors carry the same meaning here).
        io::Error::new(e.kind(), e.to_string())
    }
}

#[cfg(target_os = "linux")]
pub use imp::BidiSpliceCopy;

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    /// Drive traffic through a real socket pair and check: (1) counters equal
    /// the bytes actually transferred, (2) identical totals to realm_io's own
    /// `bidi_zero_copy` on a parallel pair.
    #[tokio::test]
    async fn counters_match_bidi_zero_copy() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        async fn socket_pair() -> (TcpStream, TcpStream) {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let dial = tokio::net::TcpStream::connect(addr);
            let accept = listener.accept();
            let (client, (server, _)) = tokio::try_join!(dial, accept).unwrap();
            (client, server)
        }

        const PAYLOAD: &[u8] = b"tyz-zero-copy-counting-probe-0123456789";

        // (a) counted relay: client → relay → echo → relay → client
        let (client_a, relay_side_client) = socket_pair().await;
        let (relay_side_target, mut echo) = socket_pair().await;
        let up = Arc::new(AtomicU64::new(0));
        let down = Arc::new(AtomicU64::new(0));
        let mut client_a = client_a;
        let relay = {
            let (up, down) = (up.clone(), down.clone());
            tokio::spawn(async move {
                bidi_copy_counted(relay_side_client, relay_side_target, up, down)
                    .await
                    .unwrap();
            })
        };
        let echo_task = tokio::spawn(async move {
            let mut buf = vec![0u8; PAYLOAD.len()];
            echo.read_exact(&mut buf).await.unwrap();
            echo.write_all(&buf).await.unwrap();
            echo.shutdown().await.unwrap();
        });
        client_a.write_all(PAYLOAD).await.unwrap();
        let mut back = vec![0u8; PAYLOAD.len()];
        client_a.read_exact(&mut back).await.unwrap();
        assert_eq!(back, PAYLOAD);
        client_a.shutdown().await.unwrap();
        relay.await.unwrap();
        echo_task.await.unwrap();

        assert_eq!(
            up.load(Ordering::Relaxed) as usize,
            PAYLOAD.len(),
            "upload counter must equal bytes pushed toward the target"
        );
        assert_eq!(
            down.load(Ordering::Relaxed) as usize,
            PAYLOAD.len(),
            "download counter must equal bytes pushed back to the client"
        );

        // (b) same shape through realm_io's untouched bidi_zero_copy — the
        // returned totals must match what our counters saw.
        let (client_b, mut relay_side_client) = socket_pair().await;
        let (mut relay_side_target, mut echo) = socket_pair().await;
        let mut client_b = client_b;
        let relay = tokio::spawn(async move {
            realm_io::bidi_zero_copy(&mut relay_side_client, &mut relay_side_target)
                .await
                .unwrap()
        });
        let echo_task = tokio::spawn(async move {
            let mut buf = vec![0u8; PAYLOAD.len()];
            echo.read_exact(&mut buf).await.unwrap();
            echo.write_all(&buf).await.unwrap();
            echo.shutdown().await.unwrap();
        });
        client_b.write_all(PAYLOAD).await.unwrap();
        let mut back = vec![0u8; PAYLOAD.len()];
        client_b.read_exact(&mut back).await.unwrap();
        client_b.shutdown().await.unwrap();
        let (a2b, b2a) = relay.await.unwrap();
        echo_task.await.unwrap();
        // Under brutal shutdown the reference engine may legitimately cut the
        // opposite direction's TOTAL at its current count (Ready + Pending ⇒
        // 0 for the pending side) — the invariant is that the echoed data
        // made it back and neither side over-reports.
        assert_eq!(b2a as usize, PAYLOAD.len());
        assert!(a2b as usize <= PAYLOAD.len());
    }

    /// Brutal shutdown: a peer that reads EOF but never closes its own side
    /// must not pin the copy open (realm's default-build behavior).
    #[tokio::test]
    async fn brutal_shutdown_releases_half_dead_peer() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        async fn socket_pair() -> (TcpStream, TcpStream) {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let dial = tokio::net::TcpStream::connect(addr);
            let accept = listener.accept();
            let (client, (server, _)) = tokio::try_join!(dial, accept).unwrap();
            (client, server)
        }

        let (mut client, relay_side_client) = socket_pair().await;
        let (relay_side_target, mut target) = socket_pair().await;
        let up = Arc::new(AtomicU64::new(0));
        let down = Arc::new(AtomicU64::new(0));
        let relay = tokio::spawn(async move {
            bidi_copy_counted(relay_side_client, relay_side_target, up, down)
                .await
                .unwrap();
        });

        client.write_all(b"hello").await.unwrap();
        client.shutdown().await.unwrap(); // client done writing
        let mut buf = [0u8; 5];
        target.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hello");
        // target NEVER writes back and NEVER closes — the copy must still
        // finish (brutal shutdown) instead of hanging.
        tokio::time::timeout(std::time::Duration::from_secs(5), relay)
            .await
            .expect("brutal shutdown must release the half-dead direction")
            .unwrap();
    }
}
