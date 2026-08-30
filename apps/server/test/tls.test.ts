import { describe, expect, test } from "bun:test";
import { generateTlsMaterial, type TlsProfile } from "../src/services/tls";

/**
 * Structural self-checks for the hand-rolled DER encoder: the certificates it
 * produces must parse as DER and their ECDSA signatures must verify with
 * WebCrypto.
 */

const PROFILE: TlsProfile = {
  ca_common_name: "Example Service CA",
  ca_organization: "example.com",
  ca_validity_days: 3650,
  leaf_validity_days: 365,
};

interface Tlv {
  tag: number;
  content: Uint8Array;
  /** The complete TLV bytes (header + content) — what importKey etc. need. */
  raw: Uint8Array;
  next: number;
}

function readTLV(buf: Uint8Array, at: number): Tlv {
  let pos = at;
  const start = pos;
  const tag = buf[pos++]!;
  let length = buf[pos++]!;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buf[pos++]!;
  }
  const end = pos + length;
  return { tag, content: buf.subarray(pos, end), raw: buf.subarray(start, end), next: end };
}

function children(tlv: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let at = 0;
  while (at < tlv.content.length) {
    const child = readTLV(tlv.content, at);
    out.push(child);
    at = child.next;
  }
  return out;
}

/** Certificate ::= SEQUENCE { tbs, sigAlg, signature BIT STRING } */
function parseCert(der: Uint8Array): { tbs: Uint8Array; spki: Uint8Array; extensions: Map<string, Uint8Array> } {
  const cert = readTLV(der, 0);
  if (cert.tag !== 0x30) throw new Error("certificate is not a SEQUENCE");
  const [tbs] = children(cert);
  if (!tbs || tbs.tag !== 0x30) throw new Error("missing tbsCertificate");
  const fields = children(tbs);
  // [0] version, serial, sigAlg, issuer, validity, subject, spki, [3] extensions
  const spki = fields[6];
  if (!spki || spki.tag !== 0x30) throw new Error("missing subjectPublicKeyInfo");
  const extensions = new Map<string, Uint8Array>();
  const extField = fields[7];
  if (extField && extField.tag === 0xa3) {
    for (const ext of children(readTLV(extField.content, 0))) {
      const parts = children(ext);
      const oidTlv = parts[0];
      const value = parts[parts.length - 1]; // OCTET STRING wrapper; critical (if any) sits between
      if (oidTlv && value) extensions.set(oidText(oidTlv.content), value.content);
    }
  }
  return { tbs: tbs.raw, spki: spki.raw, extensions };
}

/** OID content bytes -> dotted decimal (only what extension lookup needs). */
function oidText(content: Uint8Array): string {
  const arcs: number[] = [Math.floor(content[0]! / 40), content[0]! % 40];
  for (let i = 1; i < content.length; i++) {
    let v = 0;
    while (i < content.length && content[i]! & 0x80) v = v * 128 + (content[i++]! & 0x7f);
    v = v * 128 + content[i]!;
    arcs.push(v);
  }
  return arcs.join(".");
}

/** DER SEQUENCE { r INTEGER, s INTEGER } -> raw r||s (2 x 32 bytes) as
 * expected by WebCrypto verify. */
function ecdsaDerToRaw(sigDer: Uint8Array): Uint8Array {
  const [r, s] = children(readTLV(sigDer, 0));
  const out = new Uint8Array(64);
  const pad = (int: Tlv, at: number) => {
    const slot = new Uint8Array(32);
    slot.set(int.content.subarray(Math.max(0, int.content.length - 32)), 32 - Math.min(32, int.content.length));
    out.set(slot, at);
  };
  if (!r || !s) throw new Error("malformed ECDSA signature");
  pad(r, 0);
  pad(s, 32);
  return out;
}

function pemToDer(pem: string): Uint8Array {
  const base64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function verifySignedBy(certPem: string, caSpki: Uint8Array): Promise<boolean> {
  const der = pemToDer(certPem);
  const { tbs } = parseCert(der);
  const cert = readTLV(der, 0);
  const sigField = children(cert)[2];
  if (!sigField || sigField.tag !== 0x03) throw new Error("missing signature BIT STRING");
  // BIT STRING content = unused-bits byte + DER ECDSA-Sig-value
  const rawSig = ecdsaDerToRaw(sigField.content.subarray(1));
  const key = await crypto.subtle.importKey("spki", caSpki, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, rawSig, tbs);
}

describe("tls material generation", () => {
  test("CA is self-signed and leaves are signed by the CA", async () => {
    const material = await generateTlsMaterial("relay.example.com", PROFILE);
    const caSpki = parseCert(pemToDer(material.ca.cert_pem)).spki;

    expect(await verifySignedBy(material.ca.cert_pem, caSpki)).toBe(true);
    expect(await verifySignedBy(material.server.cert_pem, caSpki)).toBe(true);
    expect(await verifySignedBy(material.client.cert_pem, caSpki)).toBe(true);
  });

  test("server cert embeds the domain; private keys are PKCS#8", async () => {
    const material = await generateTlsMaterial("relay.example.com", PROFILE);
    // SAN dNSName is raw bytes inside DER — search the decoded certificate.
    const der = pemToDer(material.server.cert_pem);
    const needle = new TextEncoder().encode("relay.example.com");
    const found = der.some((_, i) => needle.every((b, j) => der[i + j] === b));
    expect(found).toBe(true);
    expect(material.ca.key_pem).toContain("BEGIN PRIVATE KEY");
    expect(material.server.key_pem).toContain("BEGIN PRIVATE KEY");
    expect(material.client.key_pem).toContain("BEGIN PRIVATE KEY");
  });

  test("profile identity strings land in CA subject and leaf issuer DNs", async () => {
    const material = await generateTlsMaterial("relay.example.com", PROFILE);
    const encoder = new TextEncoder();
    for (const pem of [material.ca.cert_pem, material.server.cert_pem, material.client.cert_pem]) {
      const der = pemToDer(pem);
      for (const needleText of [PROFILE.ca_common_name, PROFILE.ca_organization]) {
        const needle = encoder.encode(needleText);
        expect(der.some((_, i) => needle.every((b, j) => der[i + j] === b))).toBe(true);
      }
    }
  });

  test("leaves carry SKI/AKI; leaf AKI equals the CA SKI (RFC 5280 method 1)", async () => {
    const material = await generateTlsMaterial("relay.example.com", PROFILE);
    const sha1 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
    const skiOf = (pem: string) => {
      const ext = parseCert(pemToDer(pem)).extensions.get("2.5.29.14");
      if (!ext) throw new Error("missing subjectKeyIdentifier");
      const inner = readTLV(ext, 0); // KeyIdentifier OCTET STRING inside extnValue
      return inner.content;
    };
    const akiOf = (pem: string) => {
      const ext = parseCert(pemToDer(pem)).extensions.get("2.5.29.35");
      if (!ext) throw new Error("missing authorityKeyIdentifier");
      const seq = readTLV(ext, 0); // AuthorityKeyIdentifier SEQUENCE
      const keyId = readTLV(seq.content, 0); // [0] IMPLICIT KeyIdentifier
      if (keyId.tag !== 0x80) throw new Error("missing keyIdentifier in AKI");
      return keyId.content;
    };

    const caDer = pemToDer(material.ca.cert_pem);
    const caSki = skiOf(material.ca.cert_pem);
    expect(new Uint8Array(caSki)).toEqual(new Uint8Array(await sha1(parseCert(caDer).spki)));
    // self-signed: AKI == SKI
    expect(new Uint8Array(akiOf(material.ca.cert_pem))).toEqual(new Uint8Array(caSki));
    for (const leaf of [material.server.cert_pem, material.client.cert_pem]) {
      expect(new Uint8Array(akiOf(leaf))).toEqual(new Uint8Array(caSki));
      expect(new Uint8Array(skiOf(leaf))).not.toEqual(new Uint8Array(caSki));
    }
  });

  test("the stored CA private key can sign (renewal path)", async () => {
    const material = await generateTlsMaterial("relay.example.com", PROFILE);
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pemToDer(material.ca.key_pem),
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    );
    const message = new TextEncoder().encode("round-trip");
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, message);
    const pub = await crypto.subtle.importKey(
      "spki",
      parseCert(pemToDer(material.ca.cert_pem)).spki,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, signature, message)).toBe(true);
  });
});
