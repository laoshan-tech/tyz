//! kaminari TLS assembly — the same layer realm's binary conf code performs
//! (realm/src/conf/endpoint.rs::build_transport, an unpublished crate), using
//! kaminari's public conf types and option-string parser verbatim.

use kaminari::mix::{MixAccept, MixClientConf, MixConnect, MixServerConf};
use kaminari::opt;
use kaminari::tls::TlsClientConf;

use crate::model::TlsMaterial;

/// Exit leg: serve the platform server cert. The option string format is
/// kaminari's own (`tls;cert=…;key=…`), identical to what a stock realm
/// binary would be given.
pub fn server_acceptor() -> Result<MixAccept, String> {
    let opts = format!(
        "tls;cert={};key={}",
        crate::certs::server_cert_path(),
        crate::certs::server_key_path()
    );
    let tls = opt::get_tls_server_conf(&opts).ok_or("kaminari rejected the tls server conf")?;
    Ok(MixAccept::new_shared(MixServerConf { ws: None, tls: Some(tls) }))
}

/// Entry leg: dial with SNI = platform domain. kaminari's client has no
/// custom-CA option, so a platform-issued self-signed server cert can only be
/// reached with `insecure` — encryption without server verification (an
/// accepted decision; see docs/agent-realm-rust-refactor.md §0.1/§11).
pub fn client_connector(material: &TlsMaterial, alpn: &[String]) -> MixConnect {
    let tls = TlsClientConf {
        sni: material.sni.clone(),
        alpn: alpn.iter().map(|a| a.as_bytes().to_vec()).collect(),
        insecure: true,
        early_data: false,
    };
    MixConnect::new_shared(MixClientConf { ws: None, tls: Some(tls) })
}
