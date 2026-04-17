/**
 * ICP-Brasil Certificate management — FASE 13.2
 * ---------------------------------------------------------------------------
 * Endpoints for DPOs/admins to register an ICP-Brasil certificate (A1 or
 * A3) per org and exercise the signing pipeline end-to-end.
 *
 * Security-sensitive rules:
 *   - Only `admin` and `dpo` can write.
 *   - We never accept or store the PRIVATE key material in A1 mode; the
 *     request carries only the PUBLIC PEM + a path reference (the
 *     encrypted key file is mounted at deploy time on the customer host).
 *   - Soft-delete via `is_active = false` + `deactivated_at` — never hard
 *     delete so audit trails remain reconstructible.
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { webcrypto } from 'crypto';
import { X509Certificate, cryptoProvider } from '@peculiar/x509';
import {
    signWithIcpBrasil,
    IcpNotConfiguredError,
    IcpSigningError,
    computeIcpPayloadHash,
} from '../lib/icp-brasil-signer';

// @peculiar/x509 parses certs independently of signature verification,
// but its cryptoProvider must be bound. Node 20+ ships a WebCrypto-
// compatible implementation in the `crypto` module, which is enough for
// our parse-only use (we don't verify the signature here — that is the
// signer's job, and the HSM/A1 paths don't rely on this provider).
cryptoProvider.set(webcrypto as unknown as Crypto);

// ── Request payload shapes ────────────────────────────────────────────────

interface CreateBody {
    cert_pem: string;                  // required (public cert)
    cert_type: 'A1' | 'A3';            // required
    // A3-only:
    pkcs11_module_path?: string;
    pkcs11_slot_id?: number;
    pkcs11_key_label?: string;
    // A1-only:
    encrypted_key_path?: string;
    // Optional override: if omitted, we parse CN / CNPJ from the cert.
    subject_cnpj?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

interface ParsedCert {
    subject_cn: string;
    issuer_cn: string;
    serial_number: string;
    valid_from: Date;
    valid_until: Date;
    subject_cnpj: string | null;
}

/**
 * Parse subject CN, issuer CN, validity window and — best-effort — the
 * Brazilian CNPJ embedded in OID 2.16.76.1.3.3 (ICP-Brasil extension
 * "cadastroJuridicaPF/PJ"). If the cert PEM is malformed, throws.
 */
function parseCertPem(pem: string): ParsedCert {
    const x = new X509Certificate(pem);
    const extractCn = (dn: string): string => {
        // subject string looks like "CN=FOO, OU=...". Split manually — peculiar/x509
        // doesn't expose a helper for this and we want to stay dependency-light.
        const m = dn.match(/CN=([^,]+)/i);
        return m ? m[1].trim() : dn;
    };
    // CNPJ: ICP-Brasil OID 2.16.76.1.3.3 — payload carries the 14-digit CNPJ
    // string. We scan the ASN.1 raw bytes as UTF-8 and extract the first
    // 14-digit run. This is a heuristic; certs that don't expose the OID
    // return null and the DPO can fill it in manually via the form.
    let cnpj: string | null = null;
    try {
        const ext = x.extensions.find(e => e.type === '2.16.76.1.3.3');
        if (ext) {
            const raw = Buffer.from(ext.value).toString('utf8');
            const m = raw.match(/\d{14}/);
            if (m) cnpj = m[0];
        }
    } catch { /* best-effort */ }

    return {
        subject_cn: extractCn(x.subject),
        issuer_cn: extractCn(x.issuer),
        serial_number: x.serialNumber,
        valid_from: new Date(x.notBefore),
        valid_until: new Date(x.notAfter),
        subject_cnpj: cnpj,
    };
}

// ── Routes ────────────────────────────────────────────────────────────────

export async function icpCertificatesRoutes(
    app: FastifyInstance,
    opts: { pgPool: Pool; requireRole: any },
) {
    const { pgPool, requireRole } = opts;
    const authRead = requireRole(['admin', 'dpo', 'auditor', 'compliance']);
    const authWrite = requireRole(['admin', 'dpo']);

    // ── POST /v1/admin/icp-certificates ────────────────────────────────────
    app.post('/v1/admin/icp-certificates', { preHandler: authWrite }, async (request, reply) => {
        const orgId = (request.headers['x-org-id'] as string) || (request.user as any)?.orgId;
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });
        const actor = request.user as { userId?: string; email?: string } | undefined;
        if (!actor?.userId) return reply.status(401).send({ error: 'Actor user_id ausente' });

        const body = request.body as Partial<CreateBody> | undefined;
        if (!body || !body.cert_pem || !body.cert_type) {
            return reply.status(400).send({ error: 'cert_pem + cert_type obrigatórios' });
        }
        if (!['A1', 'A3'].includes(body.cert_type)) {
            return reply.status(400).send({ error: "cert_type deve ser 'A1' ou 'A3'" });
        }
        if (body.cert_type === 'A3') {
            if (!body.pkcs11_module_path || body.pkcs11_slot_id === undefined) {
                return reply.status(400).send({
                    error: 'A3 exige pkcs11_module_path + pkcs11_slot_id',
                });
            }
        }
        if (body.cert_type === 'A1' && !body.encrypted_key_path) {
            return reply.status(400).send({ error: 'A1 exige encrypted_key_path' });
        }

        let parsed: ParsedCert;
        try {
            parsed = parseCertPem(body.cert_pem);
        } catch (e: any) {
            return reply.status(400).send({ error: `PEM inválido: ${e?.message || e}` });
        }

        if (parsed.valid_until < new Date()) {
            return reply.status(400).send({ error: 'Certificado já expirado' });
        }

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            await client.query('BEGIN');

            // Deactivate previous active cert (partial unique index enforces
            // at most one active at a time — we soft-disable instead of
            // failing so the flow is "replace, not conflict").
            await client.query(
                `UPDATE icp_certificates
                    SET is_active = false, deactivated_at = NOW()
                  WHERE org_id = $1 AND is_active = true`,
                [orgId],
            );

            const res = await client.query(
                `INSERT INTO icp_certificates (
                    org_id, subject_cn, subject_cnpj, issuer_cn, serial_number,
                    valid_from, valid_until, cert_type,
                    pkcs11_module_path, pkcs11_slot_id, pkcs11_key_label,
                    encrypted_key_path, cert_pem, is_active, created_by
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14)
                RETURNING id, subject_cn, subject_cnpj, issuer_cn, serial_number,
                          valid_from, valid_until, cert_type, is_active, created_at`,
                [
                    orgId,
                    parsed.subject_cn,
                    body.subject_cnpj ?? parsed.subject_cnpj,
                    parsed.issuer_cn,
                    parsed.serial_number,
                    parsed.valid_from,
                    parsed.valid_until,
                    body.cert_type,
                    body.pkcs11_module_path ?? null,
                    body.pkcs11_slot_id ?? null,
                    body.pkcs11_key_label ?? null,
                    body.encrypted_key_path ?? null,
                    body.cert_pem,
                    actor.userId,
                ],
            );
            await client.query('COMMIT');
            return reply.status(201).send(res.rows[0]);
        } catch (err: any) {
            await client.query('ROLLBACK').catch(() => {});
            app.log.error({ err }, 'icp_certificate_insert_failed');
            return reply.status(500).send({ error: 'Erro ao registrar certificado ICP' });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── GET /v1/admin/icp-certificates ─────────────────────────────────────
    app.get('/v1/admin/icp-certificates', { preHandler: authRead }, async (request, reply) => {
        const orgId = (request.headers['x-org-id'] as string) || (request.user as any)?.orgId;
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const res = await client.query(
                `SELECT c.id, c.subject_cn, c.subject_cnpj, c.issuer_cn, c.serial_number,
                        c.valid_from, c.valid_until, c.cert_type,
                        c.pkcs11_module_path, c.pkcs11_slot_id, c.pkcs11_key_label,
                        c.encrypted_key_path, c.is_active, c.created_at, c.deactivated_at,
                        u.email AS created_by_email,
                        (c.valid_until < NOW()) AS is_expired,
                        (c.valid_until < NOW() + INTERVAL '30 days') AS expires_in_30d
                   FROM icp_certificates c
              LEFT JOIN users u ON u.id = c.created_by
                  WHERE c.org_id = $1
               ORDER BY c.is_active DESC, c.created_at DESC`,
                [orgId],
            );
            return reply.send({
                total: res.rowCount,
                certificates: res.rows,
            });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── DELETE /v1/admin/icp-certificates/:id (soft) ──────────────────────
    app.delete('/v1/admin/icp-certificates/:id', { preHandler: authWrite }, async (request, reply) => {
        const orgId = (request.headers['x-org-id'] as string) || (request.user as any)?.orgId;
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });
        const { id } = request.params as { id: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const res = await client.query(
                `UPDATE icp_certificates
                    SET is_active = false, deactivated_at = NOW()
                  WHERE id = $1 AND org_id = $2 AND is_active = true
                RETURNING id`,
                [id, orgId],
            );
            if (res.rowCount === 0) {
                return reply.status(404).send({ error: 'Certificado não encontrado ou já inativo' });
            }
            return reply.send({ success: true, deactivated_id: id });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── POST /v1/admin/icp-certificates/:id/verify ─────────────────────────
    // Round-trips a synthetic payload through the signer to confirm the
    // cert + HSM/A1 plumbing is operational. Read-only from a data-safety
    // standpoint: no evidence record is written.
    app.post('/v1/admin/icp-certificates/:id/verify', { preHandler: authWrite }, async (request, reply) => {
        const orgId = (request.headers['x-org-id'] as string) || (request.user as any)?.orgId;
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });
        const { id } = request.params as { id: string };

        // Synthetic payload: hash a small marker string bound to the cert id.
        const payloadHash = computeIcpPayloadHash({
            orgId,
            category: 'bias_assessment', // any valid category (verify is a probe)
            eventType: 'ICP_VERIFY_PROBE',
            metadata: { cert_id: id, verified_at: new Date().toISOString() },
        });

        try {
            const result = await signWithIcpBrasil(pgPool, { orgId, payloadHash });
            return reply.send({
                success: true,
                mock_mode: process.env.MOCK_ICP === 'true',
                certificate_id: result.certificateId,
                signature_length: result.signatureBase64.length,
                signed_at: result.signedAt,
            });
        } catch (err) {
            if (err instanceof IcpNotConfiguredError) {
                return reply.status(404).send({
                    error: 'Nenhum certificado ICP ativo para este org',
                    code: err.code,
                });
            }
            if (err instanceof IcpSigningError) {
                return reply.status(502).send({
                    error: err.message,
                    code: err.code,
                });
            }
            app.log.error({ err }, 'icp_verify_unexpected');
            return reply.status(500).send({ error: 'Erro inesperado ao verificar assinatura' });
        }
    });
}
