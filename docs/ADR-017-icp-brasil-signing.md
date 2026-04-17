# ADR-017: ICP-Brasil Digital Signatures on Evidence

## Status: Accepted

## Context

The HMAC-SHA256 `integrity_hash` we stamp on every `evidence_record`
gives cryptographic tamper evidence, but it does **not** carry formal
legal weight in the Brazilian jurisdiction. Two downstream consumers
matter here:

- **CNJ (Conselho Nacional de Justiça)** — requires documents signed
  with an ICP-Brasil-issued certificate to accept them as judicial
  evidence (Resolução CNJ nº 361/2020 + MP 2.200-2/2001 Art. 10 §1).
- **BACEN** — same bar for evidence submitted during on-site exams of
  regulated institutions.

MP 2.200-2/2001 Art. 10 §1 states that a signature produced with an
ICP-Brasil certificate by a natural person is presumed authentic
against third parties, with the same legal weight as a handwritten
signature. No other crypto scheme we use (HMAC, plain RSA, JWS) has
this presumption in Brazilian courts.

**Competitive landscape:** CredoAI, Holistic AI, IBM Watson OpenScale,
and Microsoft Purview ship various e-signature options (DocuSign,
Adobe Sign) but none support ICP-Brasil natively. The incumbents fall
back to "the export you produce is signed externally" — i.e., the
customer has to copy the audit package through a separate tool. For
Brazilian banks and judicial customers, that extra step is unacceptable.

## Decision

Per-org ICP-Brasil certificate registration + pre-INSERT signature
stamping on `evidence_records`.

### Key shape

`icp_certificates` (migration 082):
- One ACTIVE certificate per org (partial unique index on
  `(org_id) WHERE is_active = true`).
- Soft-disable via `is_active = false` + `deactivated_at` — never hard
  delete, so the audit chain remains reconstructible.
- `cert_type` ∈ {`A1`, `A3`}:
  - **A1**: encrypted PEM file on the host + KMS-derived passphrase.
    Faster to deploy, but private key lives on disk.
  - **A3**: PKCS#11 module path + slot + key label. The private key
    lives in hardware (USB token, smart card, HSM rack). Customer
    compliance teams generally require A3 for production because the
    key can never leave the device.
- A CHECK constraint forbids mixing: A1 needs `encrypted_key_path`,
  A3 needs `pkcs11_module_path + pkcs11_slot_id`.

### Evidence integration

`evidence_records` grows three nullable columns:

- `icp_signature_base64` — detached signature over `integrity_hash`.
- `icp_certificate_id` — reference for retrieval / revocation checks.
- `icp_signed_at` — the signing timestamp.

Populated pre-INSERT by `recordEvidence`, triggered by
`payload.signWithIcp: 'required' | 'optional'`:

- **`required`**: throw `IcpNotConfiguredError` if no active cert.
  Callers wanting legal-grade evidence (e.g., SOC 2 Type II pack
  export for a Brazilian customer) can surface a clear error.
- **`optional`**: best-effort. Sign if a cert exists, proceed unsigned
  otherwise. Useful for background events (policy enforcement, DLP
  blocks) that should be signed when possible but not block on misconfig.
- **`undefined | false`** (default): no ICP signing — the record keeps
  its HMAC integrity hash as today.

Because `evidence_records` has a trigger (`prevent_evidence_mutation`)
that blocks any UPDATE or DELETE, the signature MUST be placed inside
the initial INSERT. The helper pre-computes `integrity_hash`, calls
`signWithIcpBrasil`, and inserts the full row atomically.

### Signer abstraction

`src/lib/icp-brasil-signer.ts` exposes one function:
`signWithIcpBrasil(pool, { orgId, payloadHash })` → `{ signatureBase64,
certificateId, signedAt }`. Internally it dispatches to:

- **`signWithHsm`** — lazy `require('pkcs11js')`, opens a session on
  the configured slot, finds the key by label, and signs with
  `CKM_SHA256_RSA_PKCS`. pkcs11js is listed in `optionalDependencies`
  so hosts without `libcryptoki3` can still build; the code only
  attempts to load it when MOCK_ICP is unset and cert_type='A3'.
- **`signWithA1`** — placeholder that raises
  `A1_KMS_NOT_CONFIGURED` in production. Customers deploying A1 in
  production must wire KMS-based passphrase retrieval at deploy time
  (AWS KMS, Vault, etc.) — this is per-deployment plumbing, not
  something the platform prescribes, because the KMS choice varies by
  customer infra. A follow-up per-customer deploy guide documents
  the integration points.

### MOCK_ICP for dev/CI

Setting `MOCK_ICP=true` short-circuits both signing paths with a
deterministic SHA-256-based mock signature. This lets unit tests and
CI environments exercise the full code path without a real HSM or
decrypted key file. In production, MOCK_ICP must be unset (or
`!= 'true'`); otherwise the "signature" is not cryptographically
meaningful, only for shape validation.

## Trade-offs

- **We only support A1 + A3, not A4 (cloud-based remote signing).**
  Brazilian ACs are starting to offer remote-signing flows similar to
  DocuSign, but the protocol is still evolving (BR-PROFILE work by
  ITI). When a customer asks specifically for A4, we add it — the
  signer interface is the same, just another branch.

- **No CAdES / PAdES packaging.** We emit the raw RSA-PKCS signature
  bytes (base64) and the cert reference. A customer wanting a fully
  CAdES-BES envelope can construct it externally from these two
  fields plus `cert_pem`. Shipping CAdES ourselves would require
  embedding timestamps from an AC Carimbadora — also varies per
  customer and better layered on top.

- **Mock-mode signatures are base64 of a SHA-256 digest, not real
  crypto.** They're designed to test shape and error propagation,
  not to verify. The only risk is if MOCK_ICP leaks into production;
  the platform logs a warning at boot when it detects this.

- **Private key never leaves the HSM in A3.** This is the Brazilian
  compliance baseline — we honor it strictly. The signer never
  exports the key, only asks the HSM to sign.

## Alternatives considered

- **Use a third-party signing service (DocuSign, Adobe Sign).**
  Neither supports ICP-Brasil natively in a way that carries MP
  2.200-2 presumption. They do support "advanced electronic signatures"
  but not the specific ICP-Brasil qualified signature.

- **Ship a Python sidecar with PyKCS11.** The lib is more mature for
  PKCS#11, but adds another runtime + image. pkcs11js is good enough
  for the CKM_SHA256_RSA_PKCS mechanism we need, and keeping
  everything in Node simplifies deploy.

- **Sign on read instead of on write.** Rejected: the signature must
  be part of the immutable record. Signing on read means every
  consumer gets a different timestamp, defeating the non-repudiation
  property auditors care about.

- **Use a separate `evidence_signatures` table.** More flexible but
  adds one JOIN to every evidence query and increases transaction
  complexity. The three denormalized columns on `evidence_records`
  are cheaper, and the link via `icp_certificate_id` still lets us
  reconstruct which cert signed a given record even after it is
  soft-deactivated.

## Consequences

- RFP "Assinatura com ICP-Brasil?" → answerable with live UI demo +
  ADR + SQL DDL.
- Evidence exports for Brazilian judicial use carry MP 2.200-2
  presumption by default (via `signWithIcp: 'optional'`).
- New failure mode: HSM unavailable → evidence record falls back to
  unsigned in optional mode, or fails loudly in required mode. Both
  are better than silently dropping the signature.
- Follow-ups: A4 remote signing, CAdES-BES envelope builder, revocation
  check via CRL / OCSP before every signing (currently we trust
  `valid_until` on upload).
