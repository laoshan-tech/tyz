//! Per-(service × client) cumulative counters, snapshotted into stats samples
//! on every flush. All updates are atomic; lookups happen once per connection.
//! The server's ledger only consumes service-level samples (client == ""),
//! per-client rows are display breakdowns — both are emitted.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::model::{GostStatsSample, ServiceHealthSample};

#[derive(Debug, Default)]
pub struct Counters {
    pub total_conns: AtomicU64,
    pub current_conns: AtomicU64,
    /// Bytes are Arc-backed: the copy path clones the handles and bumps them
    /// live while a connection is in flight (the billing ledger reads the
    /// service-level counters mid-connection, not only after close).
    pub input_bytes: Arc<AtomicU64>,
    pub output_bytes: Arc<AtomicU64>,
    pub total_errs: AtomicU64,
}

impl Counters {
    pub fn input_handle(&self) -> Arc<AtomicU64> {
        self.input_bytes.clone()
    }

    pub fn output_handle(&self) -> Arc<AtomicU64> {
        self.output_bytes.clone()
    }
}

/// `StatStream`'s stat parameter: AddAssign<usize> over a shared atomic.
#[derive(Clone)]
pub struct TxCounter(pub Arc<AtomicU64>);

impl std::ops::AddAssign<usize> for TxCounter {
    fn add_assign(&mut self, n: usize) {
        self.0.fetch_add(n as u64, Ordering::Relaxed);
    }
}

#[derive(Default)]
pub struct StatsRegistry {
    // (service, client) → counters; client "" is the service-level aggregate.
    entries: Mutex<HashMap<(String, String), Arc<Counters>>>,
}

/// RAII guard: decrements `current_conns` when a connection ends.
pub struct ConnGuard {
    counters: [Arc<Counters>; 2], // service-level + per-client
}

impl ConnGuard {
    pub fn counters(&self) -> [&Arc<Counters>; 2] {
        [&self.counters[0], &self.counters[1]]
    }
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        for c in &self.counters {
            c.current_conns.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

fn key(service: &str, client_ip: &str) -> (String, String) {
    (service.to_string(), client_ip.to_string())
}

impl StatsRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn entry(&self, service: &str, client_ip: &str) -> Arc<Counters> {
        let mut map = self.entries.lock().unwrap();
        map.entry(key(service, client_ip)).or_default().clone()
    }

    /// Register an accepted connection; returns the two counter sets
    /// (service-level, per-client) plus the current-conns guard.
    pub fn on_conn(self: &Arc<Self>, service: &str, client_ip: &str) -> ConnGuard {
        let svc = self.entry(service, "");
        let cli = self.entry(service, client_ip);
        for c in [&svc, &cli] {
            c.total_conns.fetch_add(1, Ordering::Relaxed);
            c.current_conns.fetch_add(1, Ordering::Relaxed);
        }
        ConnGuard { counters: [svc, cli] }
    }

    /// One cumulative sample per key. Cheap: reads atomics under a short lock.
    pub fn snapshot(&self) -> Vec<GostStatsSample> {
        let map = self.entries.lock().unwrap();
        let mut samples: Vec<GostStatsSample> = map
            .iter()
            .map(|((service, client), c)| GostStatsSample {
                service: service.clone(),
                client: client.clone(),
                total_conns: c.total_conns.load(Ordering::Relaxed),
                current_conns: c.current_conns.load(Ordering::Relaxed),
                input_bytes: c.input_bytes.load(Ordering::Relaxed),
                output_bytes: c.output_bytes.load(Ordering::Relaxed),
                total_errs: c.total_errs.load(Ordering::Relaxed),
            })
            .collect();
        // Service-level rows first — the billing ledger consumes them and
        // should never be dropped by the buffer cap before client rows.
        samples.sort_by(|a, b| a.client.cmp(&b.client).then_with(|| a.service.cmp(&b.service)));
        samples
    }
}

// ---- send buffer: merge-by-key, cap, chunk ----

/// Flush-time buffer. Consecutive snapshots of one key merge into the newest
/// value while keeping the intra-window `currentConns` PEAK (the hourly
/// connection rollup takes the max), so the buffer holds one entry per active
/// key between flushes.
#[derive(Debug, Default)]
pub struct SampleBuffer {
    max: usize,
    samples: Vec<GostStatsSample>,
}

pub const MAX_BUFFERED_SAMPLES: usize = 1000;
/// D1 caps bound parameters per statement (100); the server inserts stats
/// rows 20 per statement.
pub const STATS_UPLOAD_CHUNK: usize = 20;

impl SampleBuffer {
    pub fn new(max: usize) -> Self {
        Self { max, samples: Vec::new() }
    }

    pub fn push(&mut self, sample: GostStatsSample) {
        let key = (sample.service.clone(), sample.client.clone());
        if let Some(existing) = self
            .samples
            .iter_mut()
            .rev()
            .find(|s| (s.service.clone(), s.client.clone()) == key)
        {
            if sample.current_conns < existing.current_conns {
                // keep the window peak
                let mut merged = sample;
                merged.current_conns = existing.current_conns;
                *existing = merged;
            } else {
                *existing = sample;
            }
            return;
        }
        if self.samples.len() >= self.max {
            // drop-oldest at cap — newest keys must keep flowing
            self.samples.remove(0);
        }
        self.samples.push(sample);
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn len(&self) -> usize {
        self.samples.len()
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    /// Take the next chunk; on upload failure keep the remainder for retry
    /// (call `keep`), on success drop it (`commit`).
    pub fn next_chunk(&mut self) -> Vec<GostStatsSample> {
        let end = self.samples.len().min(STATS_UPLOAD_CHUNK);
        self.samples[..end].to_vec()
    }

    pub fn commit_chunk(&mut self, n: usize) {
        let n = n.min(self.samples.len());
        self.samples.drain(..n);
    }
}

/// Full health snapshot attached to the first chunk of each flush.
pub fn health_batch(entries: &[ServiceHealthSample]) -> Option<Vec<ServiceHealthSample>> {
    if entries.is_empty() {
        None
    } else {
        Some(entries.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(service: &str, client: &str, cur: u64, input: u64) -> GostStatsSample {
        GostStatsSample {
            service: service.into(),
            client: client.into(),
            total_conns: cur,
            current_conns: cur,
            input_bytes: input,
            output_bytes: 0,
            total_errs: 0,
        }
    }

    #[tokio::test]
    async fn registry_counts_conns_and_bytes() {
        let reg = StatsRegistry::new();
        {
            let _guard = reg.on_conn("service-1", "1.2.3.4");
            let counters = _guard.counters();
        for c in counters {
            assert_eq!(c.total_conns.load(Ordering::Relaxed), 1);
            assert_eq!(c.current_conns.load(Ordering::Relaxed), 1);
            c.input_bytes.fetch_add(100, Ordering::Relaxed);
        }
        } // guard dropped
        let snap = reg.snapshot();
        assert_eq!(snap.len(), 2); // service-level + per-client
        for s in &snap {
            assert_eq!(s.total_conns, 1);
            assert_eq!(s.current_conns, 0); // decremented on drop
            assert_eq!(s.input_bytes, 100);
        }
        // service-level rows sort first
        assert_eq!(snap[0].client, "");
        assert_eq!(snap[1].client, "1.2.3.4");
    }

    #[test]
    fn buffer_merges_by_key_keeping_peak() {
        let mut buf = SampleBuffer::new(100);
        buf.push(sample("s", "a", 5, 100));
        buf.push(sample("s", "a", 2, 300)); // conns dipped, bytes grew
        buf.push(sample("s", "", 1, 50));
        assert_eq!(buf.len(), 2);
        let chunk = buf.next_chunk();
        let a = chunk.iter().find(|s| s.client == "a").unwrap();
        assert_eq!(a.input_bytes, 300);
        assert_eq!(a.current_conns, 5, "window peak must survive the merge");
    }

    #[test]
    fn buffer_chunks_and_commits_prefix() {
        let mut buf = SampleBuffer::new(100);
        for i in 0..45 {
            buf.push(sample(&format!("s{i}"), "", 1, 1));
        }
        assert_eq!(buf.next_chunk().len(), 20);
        buf.commit_chunk(20);
        assert_eq!(buf.len(), 25);
        assert_eq!(buf.samples[0].service, "s20");
    }

    #[test]
    fn buffer_drops_oldest_at_cap() {
        let mut buf = SampleBuffer::new(3);
        for i in 0..5 {
            buf.push(sample(&format!("s{i}"), "", 1, 1));
        }
        assert_eq!(buf.len(), 3);
        assert_eq!(buf.samples[0].service, "s2");
    }
}
