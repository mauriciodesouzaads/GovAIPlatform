/**
 * GovAI Platform — DEK Key Rotation Scheduler
 *
 * Garante forward secrecy re-criptografando DEKs (Data Encryption Keys) de
 * registros em run_content_encrypted com mais de 90 dias desde a última rotação.
 *
 * Algoritmo por ciclo:
 *   1. Consulta org_ids distintos com registros elegíveis (nunca rotacionados
 *      OU rotacionados há > KEY_ROTATION_DAYS dias).
 *   2. Para cada org_id (em série), processa em lotes de BATCH_SIZE registros:
 *      a. SET app.current_org_id = org_id  → RLS ativo por tenant
 *      b. Decripta conteúdo com DEK atual (via CryptoService)
 *      c. Re-criptografa com nova DEK aleatória
 *      d. UPDATE atômico da linha (iv, auth_tag, content, encrypted_dek,
 *         key_version, key_rotated_at)
 *   3. Registra métricas: govai_dek_rotations_total / govai_dek_rotation_errors_total
 *   4. Loga um resumo estruturado ao final de cada ciclo
 *
 * Segurança:
 *   - Cada linha recebe uma DEK diferente (randomBytes(32)) — comprometimento de
 *     uma chave não expõe dados de outras linhas.
 *   - Falhas individuais são tratadas como skip: o registro será tentado no próximo
 *     ciclo. O processo nunca para por erro de linha isolada.
 *   - O scheduler usa setInterval(...).unref() para não manter o processo vivo se
 *     o servidor Fastify decidir encerrar gracefully.
 *
 * Config:
 *   KEY_ROTATION_DAYS   Intervalo de rotação em dias (padrão: 90)
 *   KEY_ROTATION_CRON   Intervalo entre ciclos em ms (padrão: 24h)
 */

import { pgPool } from '../lib/db';
import { CryptoService } from '../lib/crypto-service';
import { getKmsAdapter } from '../lib/kms';
import { dekRotationsTotal, dekRotationErrorsTotal } from '../lib/sre-metrics';

// ── Config ────────────────────────────────────────────────────────────────────

const KEY_ROTATION_DAYS = parseInt(process.env.KEY_ROTATION_DAYS || '90', 10);
const KEY_ROTATION_INTERVAL_MS = parseInt(
    process.env.KEY_ROTATION_INTERVAL_MS || String(24 * 60 * 60 * 1000), // 24h
    10
);
const BATCH_SIZE = 50;

// ── Row type from DB ──────────────────────────────────────────────────────────

interface EncryptedRunRow {
    id: string;
    org_id: string;
    iv_bytes: string;
    auth_tag_bytes: string;
    content_encrypted_bytes: string;
    encrypted_dek: string;
    key_version: string;
}

// ── Key version helper ────────────────────────────────────────────────────────

function nextKeyVersion(current: string): string {
    const match = current.match(/^v(\d+)$/);
    if (match) {
        return `v${parseInt(match[1], 10) + 1}`;
    }
    return 'v2';
}

// ── Core rotation logic ───────────────────────────────────────────────────────

async function rotateBatchForOrg(
    orgId: string,
    cryptoService: CryptoService,
    logger: (msg: string, data?: Record<string, unknown>) => void
): Promise<{ rotated: number; errors: number }> {
    let rotated = 0;
    let errors = 0;

    // Fetch one batch of eligible rows for this org (RLS enforced by set_config)
    const client = await pgPool.connect();
    try {
        // Set RLS context for this tenant
        await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

        const res = await client.query<EncryptedRunRow>(
            `SELECT id, org_id, iv_bytes, auth_tag_bytes, content_encrypted_bytes,
                    encrypted_dek, key_version
             FROM run_content_encrypted
             WHERE org_id = $1
               AND encrypted_dek IS NOT NULL
               AND (
                   key_rotated_at IS NULL
                   OR key_rotated_at < NOW() - ($2 || ' days')::INTERVAL
               )
               AND created_at < NOW() - INTERVAL '1 hour'
             ORDER BY created_at ASC
             LIMIT $3`,
            [orgId, KEY_ROTATION_DAYS, BATCH_SIZE]
        );

        for (const row of res.rows) {
            try {
                // 1. Decrypt existing content using current DEK
                const plaintext = await cryptoService.decryptPayload(
                    row.content_encrypted_bytes,
                    row.iv_bytes,
                    row.auth_tag_bytes,
                    row.encrypted_dek
                );

                // 2. Re-encrypt with a fresh DEK
                const {
                    content_encrypted_bytes: newContent,
                    iv_bytes: newIv,
                    auth_tag_bytes: newAuthTag,
                    encrypted_dek: newEncryptedDek,
                } = await cryptoService.encryptPayload(plaintext);

                const newKeyVersion = nextKeyVersion(row.key_version || 'v1');

                // 3. Atomic update — single row, within the same tenant context
                await client.query(
                    `UPDATE run_content_encrypted
                     SET content_encrypted_bytes = $1,
                         iv_bytes                = $2,
                         auth_tag_bytes          = $3,
                         encrypted_dek           = $4,
                         key_version             = $5,
                         key_rotated_at          = NOW()
                     WHERE id = $6 AND org_id = $7`,
                    [newContent, newIv, newAuthTag, newEncryptedDek, newKeyVersion, row.id, orgId]
                );

                dekRotationsTotal.inc();
                rotated++;
            } catch (rowErr: unknown) {
                const msg = rowErr instanceof Error ? rowErr.message : String(rowErr);
                logger('DEK rotation failed for row — skipping', { row_id: row.id, org_id: orgId, error: msg });
                dekRotationErrorsTotal.inc();
                errors++;
            }
        }
    } finally {
        client.release();
    }

    return { rotated, errors };
}

// ── Rotation cycle ────────────────────────────────────────────────────────────

async function runRotationCycle(
    logger: (msg: string, data?: Record<string, unknown>) => void
): Promise<void> {
    const cycleStart = Date.now();
    let totalRotated = 0;
    let totalErrors = 0;
    let totalOrgs = 0;

    try {
        const cryptoService = new CryptoService(getKmsAdapter());

        // Fetch distinct org_ids with eligible rows (no RLS restriction needed for this query
        // since we're querying with a WHERE clause that identifies eligible orgs).
        // We use pgPool directly here (not a tenant-scoped client) to get the full list.
        const orgsRes = await pgPool.query<{ org_id: string }>(
            `SELECT DISTINCT org_id
             FROM run_content_encrypted
             WHERE encrypted_dek IS NOT NULL
               AND created_at < NOW() - INTERVAL '1 hour'
               AND (
                   key_rotated_at IS NULL
                   OR key_rotated_at < NOW() - ($1 || ' days')::INTERVAL
               )
             ORDER BY org_id`,
            [KEY_ROTATION_DAYS]
        );

        totalOrgs = orgsRes.rows.length;

        for (const { org_id } of orgsRes.rows) {
            const { rotated, errors } = await rotateBatchForOrg(org_id, cryptoService, logger);
            totalRotated += rotated;
            totalErrors += errors;
        }

        logger('DEK key rotation cycle completed', {
            orgs_processed: totalOrgs,
            deks_rotated: totalRotated,
            errors: totalErrors,
            duration_ms: Date.now() - cycleStart,
            rotation_threshold_days: KEY_ROTATION_DAYS,
        });
    } catch (cycleErr: unknown) {
        const msg = cycleErr instanceof Error ? cycleErr.message : String(cycleErr);
        logger('DEK key rotation cycle FAILED', {
            error: msg,
            duration_ms: Date.now() - cycleStart,
        });
    }
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initKeyRotationJob(
    logger: (msg: string, data?: Record<string, unknown>) => void = (msg, data) => {
        console.log(`[KeyRotation] ${msg}`, data ?? '');
    }
): void {
    logger('Key rotation scheduler initialized', {
        rotation_threshold_days: KEY_ROTATION_DAYS,
        cycle_interval_ms: KEY_ROTATION_INTERVAL_MS,
        batch_size: BATCH_SIZE,
    });

    // Execute once immediately on startup (catches backlog from before scheduler existed)
    // Delay by 30s to let the server fully start and DB pool warm up
    const startupDelay = setTimeout(() => {
        void runRotationCycle(logger);
    }, 30_000);
    startupDelay.unref();

    // Then run periodically
    const interval = setInterval(() => {
        void runRotationCycle(logger);
    }, KEY_ROTATION_INTERVAL_MS);
    interval.unref();
}
