/**
 * Shield Google Collector — Google Workspace OAuth Token Activities
 *
 * Coleta atividades de OAuth grants via Google Admin SDK Reports API.
 *
 * Referência oficial:
 *   https://developers.google.com/admin-sdk/reports/v1/reference/activities/list
 *   Activity type: token — captura authorize/deauthorize events
 *
 * Permissões necessárias (domain-wide delegation):
 *   - https://www.googleapis.com/auth/admin.reports.audit.readonly
 *
 * REGRAS:
 *   - admin_email_hash = SHA-256(admin email) — nunca email plain
 *   - user_identifier_hash = SHA-256(user email) — nunca email plain
 *   - access_token_encrypted = token criptografado — nunca token puro direto
 *   - token_hash = SHA-256(access_token) para deduplicação sem exposição
 *   - sourceType = 'oauth' (CHECK constraint em shield_observations_raw)
 */

import { createHash } from 'crypto';
import { Pool } from 'pg';
import { recordShieldObservation } from './shield';

// ── Hashing utilitário ────────────────────────────────────────────────────────

function sha256(value: string): string {
    return createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
}

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface GoogleCollectorConfig {
    orgId: string;
    collectorName: string;
    adminEmail: string;   // hash armazenado, email usado apenas para configuração
    scopes: string[];
}

export interface GoogleCollectorRecord {
    id: string;
    orgId: string;
    collectorName: string;
    adminEmailHash: string;
    scopes: string[];
    status: string;
}

export interface GoogleTokenRecord {
    id: string;
    collectorId: string;
    orgId: string;
    tokenHash: string;
    expiresAt: Date | null;
}

// ── storeGoogleCollector ──────────────────────────────────────────────────────

/**
 * Persiste configuração de coletor Google Workspace.
 * adminEmail é hashed — nunca armazenado plain.
 */
export async function storeGoogleCollector(
    pgPool: Pool,
    config: GoogleCollectorConfig
): Promise<GoogleCollectorRecord> {
    const adminEmailHash = sha256(config.adminEmail);

    const result = await pgPool.query(
        `INSERT INTO shield_google_collectors
         (org_id, collector_name, admin_email_hash, scopes, status)
         VALUES ($1, $2, $3, $4, 'active')
         ON CONFLICT DO NOTHING
         RETURNING id, org_id, collector_name, admin_email_hash, scopes, status`,
        [config.orgId, config.collectorName, adminEmailHash, JSON.stringify(config.scopes)]
    );

    if (result.rows.length === 0) {
        // ON CONFLICT — retornar existente
        const existing = await pgPool.query(
            `SELECT id, org_id, collector_name, admin_email_hash, scopes, status
             FROM shield_google_collectors
             WHERE org_id = $1 AND collector_name = $2`,
            [config.orgId, config.collectorName]
        );
        const r = existing.rows[0];
        return {
            id:             r.id as string,
            orgId:          r.org_id as string,
            collectorName:  r.collector_name as string,
            adminEmailHash: r.admin_email_hash as string,
            scopes:         r.scopes as string[],
            status:         r.status as string,
        };
    }

    const r = result.rows[0];
    return {
        id:             r.id as string,
        orgId:          r.org_id as string,
        collectorName:  r.collector_name as string,
        adminEmailHash: r.admin_email_hash as string,
        scopes:         r.scopes as string[],
        status:         r.status as string,
    };
}

// ── storeGoogleToken ──────────────────────────────────────────────────────────

/**
 * Persiste token OAuth Google de forma protegida.
 *
 * Em produção: access_token_encrypted deve conter o token criptografado
 * com a chave de dados (DEK) do org. Nesta implementação, o caller é
 * responsável pela criptografia antes de chamar esta função.
 *
 * token_hash = SHA-256(accessToken) para deduplicação sem exposição.
 * Nunca armazenar accessToken plain fora de access_token_encrypted.
 */
export async function storeGoogleToken(
    pgPool: Pool,
    collectorId: string,
    orgId: string,
    accessTokenEncrypted: string,  // token já criptografado pelo caller
    refreshTokenEncrypted: string | null,
    tokenHash: string,             // SHA-256(accessToken) para deduplicação
    expiresAt: Date | null
): Promise<GoogleTokenRecord> {
    const result = await pgPool.query(
        `INSERT INTO shield_google_tokens
         (collector_id, org_id, access_token_encrypted,
          refresh_token_encrypted, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, collector_id, org_id, token_hash, expires_at`,
        [collectorId, orgId, accessTokenEncrypted,
         refreshTokenEncrypted, tokenHash, expiresAt]
    );
    const r = result.rows[0];
    return {
        id:          r.id as string,
        collectorId: r.collector_id as string,
        orgId:       r.org_id as string,
        tokenHash:   r.token_hash as string,
        expiresAt:   r.expires_at as Date | null,
    };
}

// ── fetchGoogleObservations ───────────────────────────────────────────────────

/**
 * Busca atividades de autorização OAuth via Google Admin SDK Reports API.
 *
 * Endpoint: GET .../admin/reports/v1/activity/users/all/applications/token
 * Documentação: https://developers.google.com/admin-sdk/reports/v1/reference/activities/list
 *
 * accessToken: token já resolvido pelo caller (via domain-wide delegation).
 * Retorna eventos brutos de autorização — use ingestGoogleObservations para processar.
 */
export async function fetchGoogleObservations(
    accessToken: string,
    daysBack = 7
): Promise<{ activities: any[]; errors: string[] }> {
    const errors: string[] = [];
    const activities: any[] = [];

    const since = new Date();
    since.setDate(since.getDate() - daysBack);
    const startTime = since.toISOString();

    let pageToken: string | null = null;

    do {
        const url = new URL(
            'https://www.googleapis.com/admin/reports/v1/activity/users/all/applications/token'
        );
        url.searchParams.set('startTime', startTime);
        url.searchParams.set('maxResults', '100');
        url.searchParams.set('eventName', 'authorize');
        if (pageToken) url.searchParams.set('pageToken', pageToken);

        let response: Response;
        try {
            response = await fetch(url.toString(), {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
        } catch (err: any) {
            errors.push(`Network error: ${err.message}`);
            break;
        }

        if (!response.ok) {
            errors.push(`Reports API ${response.status}: ${response.statusText}`);
            break;
        }

        const data = await response.json();
        const items: any[] = data.items ?? [];
        activities.push(...items);
        pageToken = data.nextPageToken ?? null;

    } while (pageToken);

    return { activities, errors };
}

// ── ingestGoogleObservations ──────────────────────────────────────────────────

/**
 * Transforma atividades brutas da Google Reports API em observações Shield.
 *
 * user_identifier_hash: SHA-256(actor.email) — nunca email plain.
 * sourceType: 'oauth' — único valor válido no CHECK constraint.
 *
 * Pode receber mockActivities para testes de adaptação de payload.
 */
export async function ingestGoogleObservations(
    pgPool: Pool,
    orgId: string,
    collectorId: string,
    activities: any[]
): Promise<{ ingested: number; errors: string[] }> {
    const errors: string[] = [];
    let ingested = 0;

    for (const activity of activities) {
        try {
            const events: any[] = activity.events ?? [];
            const actorEmail: string = activity.actor?.email ?? '';
            // SHA-256 do email — NUNCA armazenar plain
            const userHash = actorEmail ? sha256(actorEmail) : sha256('unknown');

            for (const event of events) {
                if (event.name !== 'authorize') continue;

                const params: any[] = event.parameters ?? [];
                const appName = params.find((p: any) => p.name === 'app_name')?.value ?? 'unknown-google-app';
                const scopes  = (params.find((p: any) => p.name === 'scope')?.value ?? '')
                    .split(' ')
                    .filter(Boolean);

                await recordShieldObservation(pgPool, {
                    orgId,
                    sourceType:    'oauth',          // CHECK constraint
                    toolName:      appName,
                    userIdentifier: userHash,        // já hashed
                    observedAt:    new Date(activity.id?.time ?? Date.now()),
                    rawData: {
                        scopes,
                        appName,
                        collectorId,
                        provider: 'google',
                    },
                });

                ingested++;
            }
        } catch (err: any) {
            errors.push(`Activity error: ${err.message}`);
        }
    }

    // Atualizar last_collected_at do coletor
    await pgPool.query(
        `UPDATE shield_google_collectors
         SET last_collected_at = NOW(),
             last_error        = $1,
             last_error_at     = CASE WHEN $1 IS NOT NULL THEN NOW() ELSE NULL END,
             updated_at        = NOW()
         WHERE id = $2`,
        [errors.length > 0 ? errors[0] : null, collectorId]
    );

    return { ingested, errors };
}
