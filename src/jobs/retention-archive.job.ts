import { Pool } from 'pg';

// Superuser connection bypasses the immutability trigger on audit_logs_partitioned
const SU_URL = process.env.POSTGRES_SUPERUSER_URL
    || `postgresql://postgres:${process.env.DB_PASSWORD || 'postgres'}@database:5432/govai_platform`;

export async function runRetentionArchiving(): Promise<void> {
    const suPool = new Pool({ connectionString: SU_URL, max: 2 });

    try {
        // Query without RLS — superuser sees all orgs
        const orgs = await suPool.query(`
            SELECT org_id, audit_log_retention_days
            FROM org_retention_config
            WHERE archive_enabled = true
        `);

        for (const org of orgs.rows) {
            const threshold = `${org.audit_log_retention_days} days`;
            try {
                // Step 1: Copy to archive (explicit column list — archive has extra archived_at)
                const moved = await suPool.query(`
                    INSERT INTO audit_logs_archive
                        (id, org_id, assistant_id, action, metadata, signature, created_at, trace_id, archived_at)
                    SELECT id, org_id, assistant_id, action, metadata, signature, created_at, trace_id, NOW()
                    FROM audit_logs_partitioned
                    WHERE org_id = $1 AND created_at < NOW() - $2::INTERVAL
                    ON CONFLICT DO NOTHING
                `, [org.org_id, threshold]);

                // Step 2: Delete originals only if archiving succeeded
                if (moved.rowCount && moved.rowCount > 0) {
                    await suPool.query(`
                        DELETE FROM audit_logs_partitioned
                        WHERE org_id = $1 AND created_at < NOW() - $2::INTERVAL
                    `, [org.org_id, threshold]);
                }

                // Step 3: Update run metadata
                await suPool.query(`
                    UPDATE org_retention_config
                    SET last_archive_run_at = NOW(), last_archive_count = $1
                    WHERE org_id = $2
                `, [moved.rowCount || 0, org.org_id]);

                console.log(`[RETENTION] Org ${org.org_id}: archived ${moved.rowCount || 0} logs older than ${threshold}`);
            } catch (err) {
                console.error(`[RETENTION] Org ${org.org_id}: archiving failed`, err);
            }
        }
    } catch (err) {
        console.error('[RETENTION] Failed to run archiving job', err);
    } finally {
        await suPool.end();
    }
}
