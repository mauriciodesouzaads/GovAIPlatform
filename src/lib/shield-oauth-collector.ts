/**
 * Shield OAuth Collector — Microsoft Graph
 *
 * Coleta OAuth permission grants via Microsoft Graph API.
 *
 * Referência oficial:
 *   https://learn.microsoft.com/en-us/graph/api/oauth2permissiongrant-list
 *
 * Permissões necessárias no app registration:
 *   - Directory.Read.All (application permission)
 *   O accessToken é obtido externamente via client_credentials flow.
 *   Esta função NÃO gerencia credenciais — recebe token já resolvido.
 *
 * REGRAS:
 *   - user_identifier_hash = SHA-256(principalId) — NUNCA plain
 *   - sourceType = 'oauth' (único valor válido no CHECK constraint)
 *   - Toda identidade de usuário é hasheada antes de persistir
 */

import { createHash } from 'crypto';
import { Pool } from 'pg';
import { recordShieldObservation } from './shield';

/**
 * Deriva hash SHA-256 de um identificador de usuário.
 * Nunca armazenar email ou principalId plain.
 */
function hashIdentity(value: string): string {
    return createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
}

/**
 * Coleta OAuth grants do tenant Microsoft via Graph API.
 *
 * Endpoint: GET https://graph.microsoft.com/v1.0/oauth2PermissionGrants
 * Documentação: https://learn.microsoft.com/en-us/graph/api/oauth2permissiongrant-list
 *
 * Paginação: segue @odata.nextLink até esgotar.
 * user_identifier_hash: SHA-256(principalId) — NUNCA email plain.
 */
export async function collectMicrosoftOAuthGrants(
    pgPool: Pool,
    orgId: string,
    collectorId: string,
    accessToken: string
): Promise<{ collected: number; normalized: number; errors: string[] }> {
    const errors: string[] = [];
    let collected = 0;
    let normalized = 0;

    let nextLink: string | null =
        'https://graph.microsoft.com/v1.0/oauth2PermissionGrants?$top=100';

    while (nextLink) {
        let response: Response;
        try {
            response = await fetch(nextLink, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: 'application/json',
                },
            });
        } catch (err: any) {
            errors.push(`Network error: ${err.message}`);
            break;
        }

        if (!response.ok) {
            errors.push(`Graph API ${response.status}: ${response.statusText}`);
            break;
        }

        const data = await response.json();
        const grants: any[] = data.value ?? [];
        collected += grants.length;

        for (const grant of grants) {
            try {
                const scopes = (grant.scope ?? '').split(' ').filter(Boolean);

                // REGRA: hash do principalId — NUNCA plain
                const identityInput = grant.principalId ?? 'unknown';
                const userHash = hashIdentity(identityInput);

                // Persistir grant com hash
                await pgPool.query(
                    `INSERT INTO shield_oauth_grants
                     (org_id, collector_id, provider, external_app_id,
                      user_identifier_hash, scopes, grant_type, raw_data)
                     VALUES ($1, $2, 'microsoft', $3, $4, $5, $6, $7)
                     ON CONFLICT DO NOTHING`,
                    [
                        orgId,
                        collectorId,
                        grant.clientId ?? null,
                        userHash,                     // SHA-256, nunca plain
                        scopes,
                        grant.consentType === 'AllPrincipals' ? 'application' : 'delegated',
                        JSON.stringify({
                            clientId:    grant.clientId,
                            scope:       grant.scope,
                            consentType: grant.consentType,
                        }),
                    ]
                );

                // Criar observação normalizada — source_type = 'oauth' (CHECK constraint)
                await recordShieldObservation(pgPool, {
                    orgId,
                    sourceType:      'oauth',       // CHECK constraint: 'oauth', não 'microsoft_oauth'
                    toolName:        grant.clientId ?? 'unknown-ms-app',
                    userIdentifier:  userHash,       // já hashed — shield.ts re-hasha, mas é idempotente
                    observedAt:      new Date(),
                    rawData: {
                        scopes,
                        grantType: grant.consentType,
                        clientId:  grant.clientId,
                    },
                });

                normalized++;
            } catch (err: any) {
                errors.push(`Grant processing error: ${err.message}`);
            }
        }

        nextLink = data['@odata.nextLink'] ?? null;
    }

    // Atualizar estado do coletor — registrar último sucesso ou erro
    await pgPool.query(
        `UPDATE shield_oauth_collectors
         SET last_collected_at = NOW(),
             last_error        = $1,
             last_error_at     = CASE WHEN $1 IS NOT NULL THEN NOW() ELSE NULL END
         WHERE id = $2`,
        [errors.length > 0 ? errors[0] : null, collectorId]
    );

    return { collected, normalized, errors };
}
