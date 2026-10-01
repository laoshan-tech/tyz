//! RealmNodeConfig → desired service set. All validation happens here so the
//! runtime only ever sees well-formed services; a rejected config keeps the
//! previous one serving (and the version is not adopted).

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use realm_lb::{Balancer, Strategy};

use crate::ratelimit::RateLimiter;

use crate::model::{BalanceStrategy, RealmNodeConfig, RealmService, TlsMaterial, TlsSide};

#[derive(Debug, thiserror::Error)]
pub enum TranslateError {
    #[error("service {name:?}: invalid listen address {host}:{port}")]
    BadListen {
        name: String,
        host: String,
        port: u16,
    },
    #[error("service {name:?}: empty target host")]
    EmptyTarget { name: String },
    #[error("service {name:?}: tls_side set but the payload carries no tls_material")]
    TlsWithoutMaterial { name: String },
    #[error("service {name:?}: extra_targets requires more than one target")]
    BadLbShape { name: String },
}

#[derive(Debug, Clone)]
pub struct DesiredService {
    /// The raw payload entry — equality (diffing) keys off this alone.
    pub raw: RealmService,
    pub listen: SocketAddr,
    /// Primary target first, extras after (LB picks by index).
    pub targets: Vec<TargetAddr>,
    pub balancer: Option<Balancer>,
    pub tls: Option<TlsSide>,
    pub connect_timeout: Duration,
    /// Rate/connection limits (None when the payload carried no enforceable
    /// limit at all).
    pub limit: Option<Arc<ServiceLimiters>>,
}

/// The runtime enforcement set built from the payload's `limit` object.
#[derive(Debug, Default)]
pub struct ServiceLimiters {
    /// Rejected at accept when the live connection count reaches the cap.
    pub max_conns: Option<usize>,
    /// Service-level buckets, shared by every connection of the service.
    pub service_in: Option<Arc<RateLimiter>>,
    pub service_out: Option<Arc<RateLimiter>>,
    /// Per-connection rates (a fresh bucket per accepted connection).
    pub conn_in: Option<u64>,
    pub conn_out: Option<u64>,
}

impl ServiceLimiters {
    fn is_empty(&self) -> bool {
        self.max_conns.is_none()
            && self.service_in.is_none()
            && self.service_out.is_none()
            && self.conn_in.is_none()
            && self.conn_out.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetAddr {
    pub host: String,
    pub port: u16,
}

impl std::fmt::Display for TargetAddr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.host.contains(':') {
            write!(f, "[{}]:{}", self.host, self.port)
        } else {
            write!(f, "{}:{}", self.host, self.port)
        }
    }
}

/// Translate + validate. Services come back sorted by name so snapshots and
/// diffs are deterministic.
pub fn translate(config: &RealmNodeConfig) -> Result<Vec<DesiredService>, TranslateError> {
    let material: Option<&TlsMaterial> = config.tls_material.as_ref();
    let mut out = Vec::with_capacity(config.services.len());
    for svc in &config.services {
        let listen: SocketAddr = format!("{}:{}", svc.listen_host, svc.listen_port)
            .parse()
            .map_err(|_| TranslateError::BadListen {
                name: svc.name.clone(),
                host: svc.listen_host.clone(),
                port: svc.listen_port,
            })?;

        let mut targets = vec![TargetAddr {
            host: svc.target_host.clone(),
            port: svc.target_port,
        }];
        for extra in &svc.extra_targets {
            targets.push(TargetAddr {
                host: extra.host.clone(),
                port: extra.port,
            });
        }
        if targets.iter().any(|t| t.host.is_empty()) {
            return Err(TranslateError::EmptyTarget {
                name: svc.name.clone(),
            });
        }
        if targets.len() < 2 && svc.balance.is_some() {
            return Err(TranslateError::BadLbShape {
                name: svc.name.clone(),
            });
        }

        if svc.tls_side.is_some() && material.is_none() {
            return Err(TranslateError::TlsWithoutMaterial {
                name: svc.name.clone(),
            });
        }

        let balancer = match (svc.balance, targets.len() > 1) {
            (Some(strategy), true) => {
                let strategy = match strategy {
                    BalanceStrategy::Roundrobin => Strategy::RoundRobin,
                    BalanceStrategy::Iphash => Strategy::IpHash,
                };
                Some(Balancer::new(strategy, &vec![1; targets.len()]))
            }
            _ => None,
        };

        let limit = svc.limit.as_ref().and_then(|l| {
            let limiters = ServiceLimiters {
                max_conns: l.max_conns.map(|n| n as usize),
                service_in: l.service_in.map(RateLimiter::new),
                service_out: l.service_out.map(RateLimiter::new),
                conn_in: l.conn_in,
                conn_out: l.conn_out,
            };
            if limiters.is_empty() {
                None
            } else {
                Some(Arc::new(limiters))
            }
        });

        out.push(DesiredService {
            raw: svc.clone(),
            listen,
            targets,
            balancer,
            tls: svc.tls_side,
            connect_timeout: Duration::from_secs(svc.connect_timeout_s.unwrap_or(5)),
            limit,
        });
    }

    out.sort_by(|a, b| a.raw.name.cmp(&b.raw.name));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{NodeInfo, RealmTarget};

    fn base_service(name: &str) -> RealmService {
        RealmService {
            name: name.into(),
            listen_host: "0.0.0.0".into(),
            listen_port: 16500,
            target_host: "10.0.0.2".into(),
            target_port: 26500,
            extra_targets: vec![],
            balance: None,
            tls_side: None,
            alpn: vec![],
            connect_timeout_s: None,
            limit: None,
        }
    }

    fn config(services: Vec<RealmService>, material: bool) -> RealmNodeConfig {
        RealmNodeConfig {
            node: NodeInfo {
                id: 1,
                name: "n".into(),
            },
            services,
            tls_material: material.then(|| TlsMaterial {
                sni: "relay.example.test".into(),
                ca_cert: "ca".into(),
                server_cert: "sc".into(),
                server_key: "sk".into(),
                client_cert: "cc".into(),
                client_key: "ck".into(),
            }),
        }
    }

    #[test]
    fn tls_side_requires_material() {
        let mut svc = base_service("service-1");
        svc.tls_side = Some(TlsSide::Connect);
        assert!(matches!(
            translate(&config(vec![svc], false)),
            Err(TranslateError::TlsWithoutMaterial { .. })
        ));
    }

    #[test]
    fn limit_is_built_into_desired_services() {
        let mut svc = base_service("service-1");
        svc.limit = Some(crate::model::ServiceLimit {
            service_in: Some(1_000_000),
            max_conns: Some(3),
            ..Default::default()
        });
        let out = translate(&config(vec![svc], false)).unwrap();
        let limit = out[0].limit.as_ref().unwrap();
        assert_eq!(limit.max_conns, Some(3));
        assert_eq!(limit.service_in.as_ref().unwrap().rate(), 1_000_000);
        assert!(limit.service_out.is_none() && limit.conn_in.is_none() && limit.conn_out.is_none());

        // an empty limit object carries nothing enforceable → None
        let mut empty = base_service("service-2");
        empty.limit = Some(Default::default());
        let out = translate(&config(vec![empty], false)).unwrap();
        assert!(out[0].limit.is_none());
    }

    #[test]
    fn sorted_output_and_defaults() {
        let mut a = base_service("service-9");
        a.connect_timeout_s = Some(9);
        let b = base_service("service-2");
        let out = translate(&config(vec![a, b], false)).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].raw.name, "service-2");
        assert_eq!(out[0].connect_timeout, Duration::from_secs(5));
        assert_eq!(out[1].connect_timeout, Duration::from_secs(9));
        assert_eq!(out[0].listen.port(), 16500);
        assert!(out[0].balancer.is_none());
    }

    #[test]
    fn lb_requires_multiple_targets() {
        let mut svc = base_service("service-1");
        svc.balance = Some(BalanceStrategy::Roundrobin);
        assert!(matches!(
            translate(&config(vec![svc], false)),
            Err(TranslateError::BadLbShape { .. })
        ));
    }

    #[test]
    fn lb_builds_balancer_with_equal_weights() {
        let mut svc = base_service("service-1");
        svc.balance = Some(BalanceStrategy::Iphash);
        svc.extra_targets = vec![RealmTarget {
            host: "10.0.0.3".into(),
            port: 26500,
        }];
        let out = translate(&config(vec![svc], false)).unwrap();
        assert!(out[0].balancer.is_some());
        assert_eq!(out[0].targets.len(), 2);
        assert_eq!(out[0].targets[1].to_string(), "10.0.0.3:26500");
    }
}
