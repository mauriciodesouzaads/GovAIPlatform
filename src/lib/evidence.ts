/**
 * Evidence Service — records immutable, cross-referenced audit evidence.
 *
 * Every significant governance event (execution, policy enforcement, approval,
 * publication, exception) generates an evidence_record with:
 *   - SHA-256 integrity hash (org_id | category | event_type | metadata)
 *   - Optional link to other evidence records (evidence_links)
 *   - RLS isolation per tenant (app.current_org_id must be set on the connection)
 */

import { Pool, PoolClient } from 'pg';
import { createHash } from 'crypto';
import {
  signWithIcpBrasil,
  IcpNotConfiguredError,
  type IcpSigningResult,
} from './icp-brasil-signer';

export type EvidenceCategory =
  | 'execution'
  | 'policy_enforcement'
  | 'approval'
  | 'publication'
  | 'policy_exception'
  | 'oidc_session'
  | 'api_key_lifecycle'
  | 'data_access'
  | 'bias_assessment';

export interface EvidencePayload {
  orgId: string;
  category: EvidenceCategory;
  eventType: string;
  actorId?: string | null;
  actorEmail?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * Request an ICP-Brasil digital signature on the integrity_hash. Modes:
   *   - 'required'  — throw IcpNotConfiguredError if no active cert
   *   - 'optional'  — best-effort: sign if a cert exists, skip silently otherwise
   *   - false/undefined (default) — no ICP signing
   * When enabled, the signature is produced over the same SHA-256 hex
   * digest used for `integrity_hash`, so one value represents both the
   * record fingerprint and the signed payload.
   */
  signWithIcp?: 'required' | 'optional' | false;
}

export interface EvidenceRecord {
  id: string;
  createdAt: Date;
  icpSignatureBase64?: string | null;
  icpCertificateId?: string | null;
  icpSignedAt?: Date | null;
}

type DbClient = Pool | PoolClient | { query: (...args: any[]) => Promise<any> };

/**
 * Records an immutable evidence entry.
 * Non-fatal: catches DB errors silently so evidence failure never blocks the hot path.
 *
 * RLS handling:
 *  - If db is a Pool (has .connect()), acquires a dedicated client and sets
 *    app.current_org_id before INSERT so the evidence_isolation RLS policy is satisfied.
 *  - If db is a PoolClient, the caller is responsible for having already called
 *    set_config('app.current_org_id', ...) on that client (e.g. inside a transaction).
 *
 * ICP-Brasil signing:
 *  - Triggered by `payload.signWithIcp`. When active, we sign the
 *    `integrity_hash` BEFORE the INSERT so all three ICP columns
 *    (signature, cert id, signed_at) land inside the same immutable
 *    row — the evidence_records trigger blocks any UPDATE afterwards.
 *  - In 'optional' mode we swallow IcpNotConfiguredError and continue
 *    without a signature. In 'required' mode we propagate so the caller
 *    can return a 409 / 503.
 */
export async function recordEvidence(
  db: DbClient,
  payload: EvidencePayload
): Promise<EvidenceRecord | null> {
  const metadata = payload.metadata ?? {};
  const integrityHash = createHash('sha256')
    .update(
      [
        payload.orgId,
        payload.category,
        payload.eventType,
        JSON.stringify(metadata),
      ].join('|')
    )
    .digest('hex');

  // ── Optional ICP-Brasil signing (pre-INSERT so columns land atomically) ──
  let icp: IcpSigningResult | null = null;
  if (payload.signWithIcp === 'required' || payload.signWithIcp === 'optional') {
    // ICP signing needs a Pool (it manages its own connection + set_config).
    // When the caller hands us a PoolClient mid-transaction we can't reuse
    // it safely, so we require the Pool for any caller that wants signing.
    const isPool = typeof (db as PoolClient).release !== 'function';
    if (!isPool) {
      if (payload.signWithIcp === 'required') {
        throw new Error('signWithIcp=required requires a Pool (not a PoolClient)');
      }
      // optional → degrade to unsigned, same as "no cert"
    } else {
      try {
        icp = await signWithIcpBrasil(db as Pool, {
          orgId: payload.orgId,
          payloadHash: integrityHash,
        });
      } catch (err) {
        if (err instanceof IcpNotConfiguredError) {
          if (payload.signWithIcp === 'required') throw err;
          // optional: proceed unsigned
        } else {
          if (payload.signWithIcp === 'required') throw err;
          // optional: log-and-proceed; callers log at a higher layer
        }
      }
    }
  }

  const params = [
    payload.orgId,
    payload.category,
    payload.eventType,
    payload.actorId ?? null,
    payload.actorEmail ?? null,
    payload.resourceType ?? null,
    payload.resourceId ?? null,
    JSON.stringify(metadata),
    integrityHash,
    icp?.signatureBase64 ?? null,
    icp?.certificateId ?? null,
    icp?.signedAt ?? null,
  ];
  const sql = `INSERT INTO evidence_records
       (org_id, category, event_type, actor_id, actor_email,
        resource_type, resource_id, metadata, integrity_hash,
        icp_signature_base64, icp_certificate_id, icp_signed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, created_at, icp_signature_base64, icp_certificate_id, icp_signed_at`;

  // Pool path: acquire a dedicated client and set app.current_org_id for RLS
  // Distinguish Pool from PoolClient by presence of .release (only PoolClient has it)
  if (typeof (db as PoolClient).release !== 'function') {
    const client = await (db as Pool).connect();
    try {
      await client.query("SELECT set_config('app.current_org_id', $1, false)", [payload.orgId]);
      const result = await client.query(sql, params);
      return {
        id: result.rows[0].id as string,
        createdAt: result.rows[0].created_at as Date,
        icpSignatureBase64: result.rows[0].icp_signature_base64 ?? null,
        icpCertificateId: result.rows[0].icp_certificate_id ?? null,
        icpSignedAt: result.rows[0].icp_signed_at ?? null,
      };
    } catch (err) {
      // Non-fatal: evidence failure must not block execution or approvals
      // EXCEPT when ICP signing was required — caller expects the throw.
      if (payload.signWithIcp === 'required') throw err;
      return null;
    } finally {
      await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
      client.release();
    }
  }

  // PoolClient path: caller already set app.current_org_id on this client
  try {
    const result = await (db as Pool).query(sql, params);
    return {
      id: result.rows[0].id as string,
      createdAt: result.rows[0].created_at as Date,
      icpSignatureBase64: result.rows[0].icp_signature_base64 ?? null,
      icpCertificateId: result.rows[0].icp_certificate_id ?? null,
      icpSignedAt: result.rows[0].icp_signed_at ?? null,
    };
  } catch (err) {
    if (payload.signWithIcp === 'required') throw err;
    return null;
  }
}

/**
 * Creates a directional link between two evidence records.
 * Idempotent via ON CONFLICT DO NOTHING.
 */
export async function linkEvidence(
  db: DbClient,
  fromId: string,
  toId: string,
  linkType: string
): Promise<void> {
  try {
    await (db as Pool).query(
      `INSERT INTO evidence_links (from_record_id, to_record_id, link_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (from_record_id, to_record_id, link_type) DO NOTHING`,
      [fromId, toId, linkType]
    );
  } catch {
    // Non-fatal
  }
}

/**
 * Returns the full evidence chain for a resource, ordered chronologically.
 * Caller must ensure app.current_org_id is set on the pool connection (RLS).
 * Accepts Pool or PoolClient to allow transactional callers (e.g. Shield promote).
 */
export async function getEvidenceChain(
  db: DbClient,
  orgId: string,
  resourceType: string,
  resourceId: string
): Promise<EvidenceRecord[]> {
  const result = await (db as Pool).query(
    `SELECT id, category, event_type, actor_email,
            resource_type, resource_id, metadata, created_at
     FROM evidence_records
     WHERE org_id = $1
       AND resource_type = $2
       AND resource_id = $3
     ORDER BY created_at ASC`,
    [orgId, resourceType, resourceId]
  );
  return result.rows as EvidenceRecord[];
}
