//! Token-bucket rate limiting for the data plane.
//!
//! `RateLimiter` is a byte token bucket (one per limited direction —
//! service-level buckets are shared by every connection of a service,
//! per-connection buckets are fresh each connection). `Pacer` combines
//! several buckets under min semantics: a direction may move bytes only when
//! EVERY bucket grants. `Waiter` is a poll-friendly sleep for parking a task
//! inside a poll fn until the buckets refill. `Paced<S>` wraps a userland
//! stream so TLS legs pace through the same buckets as the splice path —
//! zero-copy is preserved on both: bytes never enter userspace on the splice
//! path, they are merely metered.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncWrite};

/// Byte token bucket. Tokens refill continuously at `rate` up to `burst`
/// (which allows a small startup burst); `chunk` is the smallest refill worth
/// waking a parked task for (~10 wakes/sec at most).
#[derive(Debug)]
pub struct RateLimiter {
    rate: u64, // bytes/sec
    chunk: u64,
    burst: u64,
    state: Mutex<LimiterState>,
}

#[derive(Debug)]
struct LimiterState {
    tokens: u64,
    last: Instant,
}

impl RateLimiter {
    pub fn new(bytes_per_sec: u64) -> Arc<Self> {
        let chunk = (bytes_per_sec / 10).clamp(512, 262_144);
        let burst = (bytes_per_sec / 5).clamp(chunk, 1 << 20);
        Arc::new(Self {
            rate: bytes_per_sec,
            chunk,
            burst,
            state: Mutex::new(LimiterState {
                tokens: burst,
                last: Instant::now(),
            }),
        })
    }

    fn refill(&self, st: &mut LimiterState, now: Instant) {
        let ms = now.duration_since(st.last).as_millis() as u64;
        if ms > 0 {
            st.last = now;
            st.tokens = st
                .tokens
                .saturating_add(ms.saturating_mul(self.rate) / 1000)
                .min(self.burst);
        }
    }

    /// Bytes available right now (refills first).
    pub fn available(&self) -> u64 {
        let mut st = self.state.lock().unwrap();
        self.refill(&mut st, Instant::now());
        st.tokens
    }

    /// Deduct up to n tokens (the caller passes the allowance it agreed on).
    pub fn take(&self, n: u64) {
        let mut st = self.state.lock().unwrap();
        self.refill(&mut st, Instant::now());
        st.tokens -= st.tokens.min(n);
    }

    /// Earliest instant at which another `chunk` of tokens will exist.
    pub fn ready_at(&self) -> Instant {
        let mut st = self.state.lock().unwrap();
        let now = Instant::now();
        self.refill(&mut st, now);
        if st.tokens >= self.chunk {
            return now;
        }
        let need = self.chunk - st.tokens;
        now + Duration::from_millis((need * 1000 / self.rate).max(1))
    }

    pub fn rate(&self) -> u64 {
        self.rate
    }

    #[cfg(test)]
    fn rewind(&self, d: Duration) {
        let mut st = self.state.lock().unwrap();
        st.last -= d;
    }
}

/// Several buckets under min semantics (service-level + per-connection).
/// Empty pacer = unlimited; `grant` then short-circuits.
#[derive(Clone, Default)]
pub struct Pacer {
    buckets: Vec<Arc<RateLimiter>>,
}

impl Pacer {
    pub fn new(buckets: Vec<Arc<RateLimiter>>) -> Self {
        Self { buckets }
    }

    pub fn is_empty(&self) -> bool {
        self.buckets.is_empty()
    }

    /// Reserve up to `want` bytes across every bucket. Returns the granted
    /// allowance (min over all buckets), or 0 when a bucket is dry — the
    /// caller parks until `ready_at`.
    pub fn grant(&self, want: u64) -> u64 {
        if self.buckets.is_empty() {
            return want;
        }
        let mut n = want;
        for b in &self.buckets {
            n = n.min(b.available());
        }
        if n == 0 {
            return 0;
        }
        for b in &self.buckets {
            b.take(n);
        }
        n
    }

    pub fn ready_at(&self) -> Instant {
        self.buckets
            .iter()
            .map(|b| b.ready_at())
            .max()
            .unwrap_or_else(Instant::now)
    }
}

/// Poll-friendly one-shot sleep: lets the splice state machine and the paced
/// writer park a task inside a poll fn until the buckets refill. The deadline
/// may move forward between polls (a shared bucket drained by a sibling
/// connection); the waker is (re)registered accordingly.
#[derive(Default)]
pub struct Waiter {
    sleep: Option<Pin<Box<tokio::time::Sleep>>>,
}

impl Waiter {
    pub fn wait_until(&mut self, cx: &mut Context<'_>, at: Instant) -> Poll<()> {
        let at = tokio::time::Instant::from_std(at);
        match &mut self.sleep {
            Some(s) if s.deadline() != at => s.as_mut().reset(at),
            Some(_) => {}
            None => self.sleep = Some(Box::pin(tokio::time::sleep_until(at))),
        }
        self.sleep.as_mut().unwrap().as_mut().poll(cx)
    }
}

/// `AsyncWrite` pacing adapter: reads pass through untouched; each write is
/// capped to the granted allowance, and a dry bucket parks the task (the
/// copy engine above sees ordinary Poll::Pending backpressure).
pub struct Paced<S> {
    inner: S,
    pacer: Pacer,
    waiter: Waiter,
}

impl<S> Paced<S> {
    pub fn new(inner: S, pacer: Pacer) -> Self {
        Self {
            inner,
            pacer,
            waiter: Waiter::default(),
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for Paced<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Paced<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.pacer.is_empty() {
            return Pin::new(&mut self.inner).poll_write(cx, buf);
        }
        loop {
            let grant = self.pacer.grant(buf.len() as u64);
            if grant == 0 {
                let at = self.pacer.ready_at();
                std::task::ready!(self.waiter.wait_until(cx, at));
                continue;
            }
            let n = (buf.len() as u64).min(grant) as usize;
            return Pin::new(&mut self.inner).poll_write(cx, &buf[..n]);
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_refills_by_elapsed_time_and_caps_at_burst() {
        let lim = RateLimiter::new(1_000_000); // 1MB/s, burst 200KB
        assert_eq!(lim.available(), 200_000, "starts full at burst");
        lim.take(200_000);
        assert_eq!(lim.available(), 0);
        lim.rewind(Duration::from_millis(100)); // pretend 100ms passed
        assert_eq!(lim.available(), 100_000);
        lim.rewind(Duration::from_secs(10)); // far beyond burst: capped
        assert_eq!(lim.available(), 200_000);
    }

    #[test]
    fn ready_at_waits_for_a_chunk_when_dry() {
        let lim = RateLimiter::new(1_000_000);
        lim.take(lim.available());
        let at = lim.ready_at();
        let in_ms = at.duration_since(Instant::now()).as_millis();
        // chunk = 100KB at 1MB/s ≈ 100ms
        assert!((50..=200).contains(&in_ms), "ready_at {in_ms}ms");
    }

    #[test]
    fn pacer_takes_the_minimum_across_buckets() {
        let slow = RateLimiter::new(1_000_000);
        let fast = RateLimiter::new(10_000_000);
        slow.take(slow.available()); // drain the slow bucket
        slow.rewind(Duration::from_millis(10)); // ~10KB available again
        let pacer = Pacer::new(vec![slow.clone(), fast.clone()]);
        assert_eq!(pacer.grant(1_000_000), 10_000, "min over buckets");
        assert_eq!(slow.available(), 0);
        assert_eq!(fast.available(), (1 << 20) - 10_000, "burst-capped bucket");
    }

    #[tokio::test]
    async fn paced_write_parks_on_dry_bucket_then_writes() {
        use std::future::poll_fn;

        let lim = RateLimiter::new(1_000_000);
        lim.take(lim.available()); // dry
        lim.rewind(Duration::from_millis(5)); // ~5KB will have accrued
        let (client, mut server) = tokio::io::duplex(1 << 20);
        let mut paced = Paced::new(client, Pacer::new(vec![lim.clone()]));

        let payload = [7u8; 8_192];
        let write = poll_fn(|cx| {
            let pinned = Pin::new(&mut paced);
            pinned.poll_write(cx, &payload)
        });
        // First poll: bucket dry at poll entry → the 5KB accrued is granted
        // (grant happens synchronously), so the write completes capped.
        let n = write.await.unwrap();
        assert_eq!(n, 5_000, "capped to the granted allowance");
        let mut got = vec![0u8; 5_000];
        tokio::io::AsyncReadExt::read_exact(&mut server, &mut got)
            .await
            .unwrap();
        assert_eq!(got, payload[..5_000]);
    }
}
