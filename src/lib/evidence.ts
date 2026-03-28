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

export type EvidenceCategory =
  | 'execution'
  | 'policy_enforcement'
  | 'approval'
  | 'publication'
  | 'policy_exception'
  | 'oidc_session'
  | 'api_key_lifecycle'
  | 'data_access';

export interface EvidencePayload {
  orgId: string;
  category: EvidenceCategory;
  eventType: string;
  actorId?: string | null;
  actorEmail?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface EvidenceRecord {
  id: string;
  createdAt: Date;
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
  ];
  const sql = `INSERT INTO evidence_records
       (org_id, category, event_type, actor_id, actor_email,
        resource_type, resource_id, metadata, integrity_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, created_at`;

  // Pool path: acquire a dedicated client and set app.current_org_id for RLS
  if (typeof (db as Pool).connect === 'function') {
    const client = await (db as Pool).connect();
    try {
      await client.query("SELECT set_config('app.current_org_id', $1, false)", [payload.orgId]);
      const result = await client.query(sql, params);
      return {
        id: result.rows[0].id as string,
        createdAt: result.rows[0].created_at as Date,
      };
    } catch {
      // Non-fatal: evidence failure must not block execution or approvals
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
    };
  } catch {
    // Non-fatal: evidence failure must not block execution or approvals
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
