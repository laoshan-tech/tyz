//! Control loop + stats flush loop.
//!
//! Cadence mirrors the Go agent: while the WS channel is healthy the poll is
//! a 5-minute safety net; demoted channels poll at POLL_INTERVAL_MS. Fetch
//! failures back off exponentially (×2, max 5 min, ±20% jitter) and reset on
//! any successful poll (200 or 304). The flush loop's startup phase is
//! randomized so a fleet started together never hits the stats endpoint in
//! lockstep. The heartbeat lives OUTSIDE the flush loop: in ws mode the WS
//! session's own tick carries it (cp::ws), in poll mode the control loop
//! POSTs it — traffic samples and liveness never share a cadence gate.

use std::sync::Arc;
use std::time::Duration;

use rand::Rng;

use crate::agentcfg::AgentConfig;
use crate::cp::http::{CpClient, Fetched};
use crate::cp::ws::{Mode, WsChannel, WsEvent};
use crate::runtime::SharedSupervisor;
use crate::stats::{SampleBuffer, StatsRegistry, MAX_BUFFERED_SAMPLES};
use crate::{agentcfg, certs, store};

const SAFETY_NET_INTERVAL: Duration = Duration::from_secs(5 * 60);
const MAX_BACKOFF: Duration = Duration::from_secs(5 * 60);

/// What wakes the control loop early.
pub enum Wake {
    WsEvent(WsEvent),
    Shutdown,
}

enum PollOutcome {
    /// Fully applied — version adopted, cache persisted.
    Adopted(i64),
    /// 304 / refused payload — nothing to do, not an error.
    Unchanged,
    /// Transport/server error — grow the backoff.
    Failed,
}

fn jittered(base: Duration) -> Duration {
    let spread = base.as_millis() as f64 * 0.2;
    let ms = base.as_millis() as f64 + rand::thread_rng().gen_range(-spread..=spread);
    Duration::from_millis(ms.max(1.0) as u64)
}

pub struct Control {
    pub cfg: AgentConfig,
    pub cp: Arc<CpClient>,
    pub supervisor: SharedSupervisor,
    pub version: i64,
}

impl Control {
    async fn poll_once(&mut self) -> PollOutcome {
        let resp = match self.cp.fetch_config(self.version).await {
            Ok(Fetched::NotModified) => return PollOutcome::Unchanged,
            Ok(Fetched::Changed(resp)) => *resp,
            Err(err) => {
                tracing::warn!("{err}");
                return PollOutcome::Failed;
            }
        };

        // PEMs must land on disk BEFORE services build TLS configs from them
        // (kaminari resolves the paths at acceptor construction).
        let tls_changed = match &resp.config.tls_material {
            Some(material) => match certs::ensure(material) {
                Ok(c) => c.changed,
                Err(err) => {
                    tracing::error!("certs write failed: {err}");
                    false
                }
            },
            None => false,
        };

        let mut supervisor = self.supervisor.lock().await;
        match supervisor.apply_config(&resp.config, tls_changed).await {
            Ok(outcome) if outcome.ok() => {
                tracing::info!(
                    version = resp.version,
                    created = outcome.created,
                    updated = outcome.updated,
                    removed = outcome.removed,
                    services = supervisor.service_count(),
                    "config applied"
                );
                store::save(&resp);
                PollOutcome::Adopted(resp.version)
            }
            Ok(outcome) => {
                // Partial apply: everything healthy is live; failures show as
                // apply_failed health and retry next poll. The version is NOT
                // adopted so the next poll re-fetches the same config.
                for (name, err) in &outcome.failures {
                    tracing::warn!(service = name, "apply failed: {err}");
                }
                PollOutcome::Unchanged
            }
            Err(err) => {
                tracing::error!("config rejected: {err}");
                PollOutcome::Unchanged
            }
        }
    }

    pub async fn run(mut self, mut wake: tokio::sync::mpsc::Receiver<Wake>, ws: WsChannel) {
        let mut backoff: Option<Duration> = None;
        // Poll-mode heartbeat: while the WS session is down (or WS is
        // disabled) the control loop carries the liveness beat over HTTP.
        // In ws mode the session's own tick sends it — the loop skips.
        let mut heartbeat_tick = tokio::time::interval(agentcfg::HEARTBEAT_INTERVAL);
        heartbeat_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // Consume the immediate first tick: unlike the WS session (whose first
        // beat stamps liveness right after the handshake), a poll-mode agent
        // just started — its first beat rides the normal cadence.
        heartbeat_tick.tick().await;

        loop {
            let base = if ws.mode() == Mode::Ws {
                SAFETY_NET_INTERVAL
            } else {
                self.cfg.poll_interval
            };
            let wait = backoff.map(jittered).unwrap_or(base);

            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = heartbeat_tick.tick() => {
                    if ws.mode() == Mode::Poll {
                        let health = self.supervisor.lock().await.health_snapshot();
                        if let Err(err) = self.cp.upload_heartbeat(&health).await {
                            tracing::warn!("heartbeat upload failed: {err}");
                        }
                    }
                    continue;
                }
                msg = wake.recv() => match msg {
                    Some(Wake::WsEvent(WsEvent::ConfigChanged)) => {
                        tracing::debug!("push: config_changed");
                    }
                    Some(Wake::WsEvent(WsEvent::Connected)) => {
                        tracing::debug!("push: connected — immediate poll");
                    }
                    Some(Wake::WsEvent(WsEvent::ModeChanged(mode))) => {
                        tracing::info!("push channel mode: {mode:?}");
                        continue; // cadence changed; recompute the wait
                    }
                    Some(Wake::WsEvent(WsEvent::RestartService(name))) => {
                        self.supervisor.lock().await.restart(&name).await;
                        continue;
                    }
                    Some(Wake::Shutdown) | None => break,
                }
            }

            match self.poll_once().await {
                PollOutcome::Adopted(version) => {
                    self.version = version;
                    backoff = None;
                }
                PollOutcome::Unchanged => {
                    backoff = None;
                }
                PollOutcome::Failed => {
                    let next = backoff.map_or(self.cfg.poll_interval, |b| (b * 2).min(MAX_BACKOFF));
                    backoff = Some(next);
                }
            }
        }
    }
}

/// Flush loop: snapshot counters, buffer-merge, chunked upload with
/// remainder-keep retry. Traffic samples ONLY — the service snapshot and
/// liveness live on the heartbeat channel. `flush()` is public for the
/// graceful-shutdown final pass and tests.
pub struct Flush {
    pub cp: Arc<CpClient>,
    pub stats: Arc<StatsRegistry>,
    pub interval: Duration,
    buffer: SampleBuffer,
}

impl Flush {
    pub fn new(cp: Arc<CpClient>, stats: Arc<StatsRegistry>, interval: Duration) -> Self {
        Self {
            cp,
            stats,
            interval,
            buffer: SampleBuffer::new(MAX_BUFFERED_SAMPLES),
        }
    }

    pub async fn run(mut self, mut shutdown: tokio::sync::watch::Receiver<bool>) {
        // Random startup phase (0..interval): a fleet started together must
        // not hit the stats endpoint in lockstep.
        let phase = Duration::from_millis(
            rand::thread_rng().gen_range(0..self.interval.as_millis() as u64),
        );
        tokio::select! {
            _ = tokio::time::sleep(phase) => {}
            _ = shutdown.changed() => {}
        }

        let mut ticker = tokio::time::interval(self.interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await; // consume the immediate first tick
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    if let Err(err) = self.flush().await {
                        tracing::warn!("stats flush failed: {err} (retrying next tick)");
                    }
                }
                _ = shutdown.changed() => {
                    let _ = self.flush().await; // best-effort final flush
                    return;
                }
            }
        }
    }

    /// One flush pass: snapshot → merge into buffer → upload in ≤20-sample
    /// chunks (D1's bound-parameter cap); a failed chunk keeps the remainder
    /// buffered for next pass. Idle (empty buffer) uploads nothing.
    pub async fn flush(&mut self) -> Result<(), String> {
        for sample in self.stats.snapshot() {
            self.buffer.push(sample);
        }
        while !self.buffer.is_empty() {
            let chunk = self.buffer.next_chunk();
            match self.cp.upload_stats(&chunk).await {
                Ok(()) => self.buffer.commit_chunk(chunk.len()),
                Err(err) => return Err(err),
            }
        }
        Ok(())
    }
}
