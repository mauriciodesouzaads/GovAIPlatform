/**
 * ICP-Brasil Digital Signatures — FASE 13.2
 * ---------------------------------------------------------------------------
 * Produces a detached digital signature over a payload hash using an
 * ICP-Brasil-issued certificate (A1 file or A3 PKCS#11 HSM). Output is
 * base64-encoded raw signature bytes suitable for attaching to an
 * evidence_record.
 *
 * Legal basis: Medida Provisória 2.200-2/2001 establishes that signatures
 * produced with ICP-Brasil certificates carry the same legal weight as
 * handwritten signatures for documents in the Brazilian jurisdiction.
 * The CNJ (Conselho Nacional de Justiça) and BACEN accept only
 * ICP-Brasil-signed artifacts as formal judicial/financial evidence.
 *
 * Supported paths:
 *   - A1 (cert_type = 'A1'): encrypted PEM key file + KMS-derived
 *     passphrase. Production requires customer-specific integration
 *     (deploy-time key mount + KMS access). We ship the interface and
 *     the MOCK path; the real KMS plumbing is per-deployment.
 *   - A3 (cert_type = 'A3'): PKCS#11 module (SoftHSM2 for test, hardware
 *     HSM for production). `pkcs11js` is an OPTIONAL dependency — the
 *     library loads it lazily via `require()` inside the HSM branch, so
 *     environments without libcryptoki3 can still build and run with
 *     MOCK_ICP=true.
 *
 * Environment flags:
 *   - `MOCK_ICP=true` forces a deterministic base64-encoded mock signature
 *     so tests/CI without HSM access can exercise the full code path.
 *   - `MOCK_ICP` unset (or != 'true') hits the real signing code; A1 will
 *     raise until customer KMS plumbing lands.
 */

import { createHash } from 'crypto';
import type { Pool } from 'pg';

// ── Public error + result types ────────────────────────────────────────────

export class IcpNotConfiguredError extends Error {
    public readonly code = 'ICP_NOT_CONFIGURED';
    constructor(msg = 'No active ICP-Brasil certificate for this org') {
        super(msg);
        this.name = 'IcpNotConfiguredError';
    }
}

export class IcpSigningError extends Error {
    public readonly code: string;
    constructor(msg: string, code = 'ICP_SIGNING_FAILED') {
        super(msg);
        this.name = 'IcpSigningError';
        this.code = code;
    }
}

export interface IcpSigningInput {
    orgId: string;
    /** hex-encoded SHA-256 of the payload (same shape as evidence_records.integrity_hash) */
    payloadHash: string;
}

export interface IcpSigningResult {
    signatureBase64: string;
    certificateId: string;
    signedAt: Date;
}

// Row shape mirrored from the icp_certificates table (narrow type — we
// only consume the fields the signer needs).
export interface IcpCertRow {
    id: string;
    cert_type: 'A1' | 'A3';
    pkcs11_module_path: string | null;
    pkcs11_slot_id: number | null;
    pkcs11_key_label: string | null;
    encrypted_key_path: string | null;
    cert_pem: string;
    is_active: boolean;
    valid_until: Date | string;
}

// ── Entry point ────────────────────────────────────────────────────────────

/**
 * Sign `input.payloadHash` with the org's active ICP certificate.
 *
 * Throws:
 *   IcpNotConfiguredError — no active cert for the org
 *   IcpSigningError       — HSM/A1 path failure (message carries detail)
 */
export async function signWithIcpBrasil(
    pool: Pool,
    input: IcpSigningInput,
): Promise<IcpSigningResult> {
    if (!/^[0-9a-f]{64}$/i.test(input.payloadHash)) {
        throw new IcpSigningError('payloadHash must be a 64-char hex SHA-256', 'INVALID_PAYLOAD_HASH');
    }

    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [input.orgId]);
        const r = await client.query<IcpCertRow>(
            `SELECT id, cert_type, pkcs11_module_path, pkcs11_slot_id, pkcs11_key_label,
                    encrypted_key_path, cert_pem, is_active, valid_until
               FROM icp_certificates
              WHERE org_id = $1 AND is_active = true AND valid_until > NOW()
           ORDER BY created_at DESC
              LIMIT 1`,
            [input.orgId],
        );
        if (r.rows.length === 0) {
            throw new IcpNotConfiguredError();
        }
        const cert = r.rows[0];
        const signatureBase64 = cert.cert_type === 'A3'
            ? await signWithHsm(cert, input.payloadHash)
            : await signWithA1(cert, input.payloadHash);
        return {
            signatureBase64,
            certificateId: cert.id,
            signedAt: new Date(),
        };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── A3 / PKCS#11 HSM path ──────────────────────────────────────────────────

async function signWithHsm(cert: IcpCertRow, payloadHash: string): Promise<string> {
    if (isMockMode()) return mockSignature('A3', payloadHash);
    if (!cert.pkcs11_module_path || cert.pkcs11_slot_id === null) {
        throw new IcpSigningError('A3 certificate missing PKCS#11 config', 'INVALID_A3_CONFIG');
    }

    // Lazy require — pkcs11js is an optional native dep. Hosts without
    // libcryptoki3 will have it unavailable; real HSM deployments must
    // install it themselves.
    let pkcs11js: any;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        pkcs11js = require('pkcs11js');
    } catch (e: any) {
        throw new IcpSigningError(
            `pkcs11js not available on this host: ${e?.message || e}. Install it or set MOCK_ICP=true.`,
            'PKCS11_UNAVAILABLE',
        );
    }

    const pkcs11 = new pkcs11js.PKCS11();
    try {
        pkcs11.load(cert.pkcs11_module_path);
        pkcs11.C_Initialize();
    } catch (e: any) {
        throw new IcpSigningError(
            `Failed to load PKCS#11 module ${cert.pkcs11_module_path}: ${e?.message || e}`,
            'PKCS11_LOAD_FAILED',
        );
    }

    try {
        const session = pkcs11.C_OpenSession(cert.pkcs11_slot_id, pkcs11js.CKF_SERIAL_SESSION);
        try {
            pkcs11.C_FindObjectsInit(session, [
                { type: pkcs11js.CKA_LABEL, value: cert.pkcs11_key_label ?? '' },
                { type: pkcs11js.CKA_CLASS, value: pkcs11js.CKO_PRIVATE_KEY },
            ]);
            const keys = pkcs11.C_FindObjects(session, 1);
            pkcs11.C_FindObjectsFinal(session);
            if (!keys.length) {
                throw new IcpSigningError(
                    `Private key with label '${cert.pkcs11_key_label}' not found in HSM slot ${cert.pkcs11_slot_id}`,
                    'HSM_KEY_NOT_FOUND',
                );
            }
            pkcs11.C_SignInit(session, { mechanism: pkcs11js.CKM_SHA256_RSA_PKCS }, keys[0]);
            const payloadBuffer = Buffer.from(payloadHash, 'hex');
            const signature = pkcs11.C_Sign(session, payloadBuffer, Buffer.alloc(512));
            return signature.toString('base64');
        } finally {
            try { pkcs11.C_CloseSession(session); } catch { /* ignore */ }
        }
    } finally {
        try { pkcs11.C_Finalize(); } catch { /* ignore */ }
    }
}

// ── A1 / file path ─────────────────────────────────────────────────────────

async function signWithA1(cert: IcpCertRow, payloadHash: string): Promise<string> {
    if (isMockMode()) return mockSignature('A1', payloadHash);

    // Production A1 requires: encrypted PEM at `cert.encrypted_key_path`,
    // a passphrase derived from org-specific KMS material, and
    // `node-forge` (already a dependency) for RSA signing.
    //
    // We ship the interface but leave the KMS step to customer deployment
    // because passphrase sourcing varies (Vault, AWS Secrets Manager,
    // Azure Key Vault, GCP Secret Manager, on-prem HSM-backed KMS). A
    // follow-up per-customer deploy guide documents the plumbing.
    throw new IcpSigningError(
        'A1 signing requires customer-specific KMS integration. '
        + 'Configure MOCK_ICP=true for dev, or deploy with KMS wired for A1 passphrase retrieval.',
        'A1_KMS_NOT_CONFIGURED',
    );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isMockMode(): boolean {
    return process.env.MOCK_ICP === 'true';
}

/**
 * Deterministic mock signature — for dev/CI. SHA-256 of the cert-type +
 * payload hash, base64-encoded. Not cryptographically secure; do NOT use
 * in production (MOCK_ICP must be unset outside dev).
 */
function mockSignature(type: 'A1' | 'A3', payloadHash: string): string {
    const digest = createHash('sha256')
        .update(`MOCK_ICP|${type}|${payloadHash}`)
        .digest();
    return digest.toString('base64');
}

// ── Utility for callers ────────────────────────────────────────────────────

/**
 * Compute the canonical SHA-256 hex hash used for ICP signing. Mirrors
 * the `integrity_hash` computed in src/lib/evidence.ts so that a single
 * hash value represents the record integrity AND the signed payload.
 */
export function computeIcpPayloadHash(parts: {
    orgId: string;
    category: string;
    eventType: string;
    metadata: Record<string, unknown>;
}): string {
    return createHash('sha256')
        .update([parts.orgId, parts.category, parts.eventType, JSON.stringify(parts.metadata)].join('|'))
        .digest('hex');
}
