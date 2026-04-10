import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

export async function complianceHubRoutes(
    app: FastifyInstance,
    opts: { pgPool: Pool; requireRole: any }
) {
    const { pgPool, requireRole } = opts;
    const auth = requireRole(['admin', 'dpo', 'auditor', 'compliance']);

    // GET /v1/admin/compliance-hub/frameworks
    app.get('/v1/admin/compliance-hub/frameworks', { preHandler: auth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const result = await client.query(`
                SELECT cf.*,
                    (SELECT COUNT(*) FROM compliance_controls cc WHERE cc.framework_id = cf.id) as total_controls,
                    (SELECT COUNT(*) FROM compliance_assessments ca
                     JOIN compliance_controls cc2 ON ca.control_id = cc2.id
                     WHERE cc2.framework_id = cf.id AND ca.org_id = $1 AND ca.status = 'compliant') as compliant_count,
                    (SELECT COUNT(*) FROM compliance_assessments ca2
                     JOIN compliance_controls cc3 ON ca2.control_id = cc3.id
                     WHERE cc3.framework_id = cf.id AND ca2.org_id = $1 AND ca2.status = 'partial') as partial_count,
                    (SELECT COUNT(*) FROM compliance_assessments ca3
                     JOIN compliance_controls cc4 ON ca3.control_id = cc4.id
                     WHERE cc4.framework_id = cf.id AND ca3.org_id = $1 AND ca3.status = 'non_compliant') as non_compliant_count
                FROM compliance_frameworks cf
                WHERE cf.is_active = true
                ORDER BY cf.name
            `, [orgId]);

            return result.rows.map(row => ({
                ...row,
                total_controls: parseInt(row.total_controls),
                compliant_count: parseInt(row.compliant_count),
                partial_count: parseInt(row.partial_count),
                non_compliant_count: parseInt(row.non_compliant_count),
                compliance_rate: parseInt(row.total_controls) > 0
                    ? Math.round((parseInt(row.compliant_count) / parseInt(row.total_controls)) * 100)
                    : 0,
            }));
        } finally {
            client.release();
        }
    });

    // GET /v1/admin/compliance-hub/frameworks/:frameworkId/controls
    app.get('/v1/admin/compliance-hub/frameworks/:frameworkId/controls', { preHandler: auth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const { frameworkId } = request.params as { frameworkId: string };
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const result = await client.query(`
                SELECT cc.*,
                    ca.status as assessment_status,
                    ca.evidence_notes,
                    ca.assessed_by,
                    ca.assessed_at
                FROM compliance_controls cc
                LEFT JOIN compliance_assessments ca ON cc.id = ca.control_id AND ca.org_id = $1
                WHERE cc.framework_id = $2
                ORDER BY cc.sort_order
            `, [orgId, frameworkId]);

            return result.rows;
        } finally {
            client.release();
        }
    });

    // PUT /v1/admin/compliance-hub/assessments/:controlId
    app.put('/v1/admin/compliance-hub/assessments/:controlId', { preHandler: auth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const userId = (request.user as any)?.userId;
        const { controlId } = request.params as { controlId: string };
        const { status, evidence_notes } = request.body as { status: string; evidence_notes?: string };
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const result = await client.query(`
                INSERT INTO compliance_assessments (org_id, control_id, status, evidence_notes, assessed_by, assessed_at)
                VALUES ($1, $2, $3, $4, $5, NOW())
                ON CONFLICT (org_id, control_id) DO UPDATE SET
                    status = EXCLUDED.status,
                    evidence_notes = EXCLUDED.evidence_notes,
                    assessed_by = EXCLUDED.assessed_by,
                    assessed_at = NOW(),
                    updated_at = NOW()
                RETURNING *
            `, [orgId, controlId, status, evidence_notes || null, userId]);

            return result.rows[0];
        } finally {
            client.release();
        }
    });

    // POST /v1/admin/compliance-hub/auto-assess/:frameworkId
    app.post('/v1/admin/compliance-hub/auto-assess/:frameworkId', { preHandler: auth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const userId = (request.user as any)?.userId;
        const { frameworkId } = request.params as { frameworkId: string };
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const controls = await client.query(`
                SELECT id, govai_feature, auto_assessment FROM compliance_controls
                WHERE framework_id = $1 AND auto_assessment = 'auto_pass' AND govai_feature IS NOT NULL
            `, [frameworkId]);

            const autoChecks: Record<string, () => Promise<boolean>> = {
                audit_trail: async () => {
                    const r = await client.query('SELECT COUNT(*) FROM audit_logs_partitioned WHERE org_id = $1', [orgId]);
                    return parseInt(r.rows[0].count) > 0;
                },
                dlp: async () => true,
                hitl: async () => {
                    const r = await client.query('SELECT hitl_timeout_hours FROM organizations WHERE id = $1', [orgId]);
                    return (r.rows[0]?.hitl_timeout_hours ?? 0) > 0;
                },
                lifecycle: async () => {
                    const r = await client.query("SELECT COUNT(*) FROM assistants WHERE org_id = $1 AND lifecycle_state = 'official'", [orgId]);
                    return parseInt(r.rows[0].count) > 0;
                },
                evidence: async () => true,
                shield: async () => {
                    const r = await client.query('SELECT COUNT(*) FROM shield_findings WHERE org_id = $1', [orgId]);
                    return parseInt(r.rows[0].count) > 0;
                },
                policy_engine: async () => {
                    const r = await client.query('SELECT COUNT(*) FROM policy_versions WHERE org_id = $1', [orgId]);
                    return parseInt(r.rows[0].count) > 0;
                },
                retention: async () => {
                    const r = await client.query('SELECT COUNT(*) FROM org_retention_config WHERE org_id = $1', [orgId]);
                    return r.rows.length > 0;
                },
                risk_scoring: async () => true,
            };

            let assessed = 0;
            let passed = 0;
            let failed = 0;

            for (const control of controls.rows) {
                const checkFn = autoChecks[control.govai_feature];
                if (!checkFn) continue;

                const isCompliant = await checkFn();
                const status = isCompliant ? 'compliant' : 'non_compliant';

                await client.query(`
                    INSERT INTO compliance_assessments (org_id, control_id, status, evidence_notes, assessed_by, assessed_at)
                    VALUES ($1, $2, $3, $4, $5, NOW())
                    ON CONFLICT (org_id, control_id) DO UPDATE SET
                        status = EXCLUDED.status,
                        evidence_notes = EXCLUDED.evidence_notes,
                        assessed_by = EXCLUDED.assessed_by,
                        assessed_at = NOW(),
                        updated_at = NOW()
                `, [
                    orgId, control.id, status,
                    `Auto-assessed: GovAI feature "${control.govai_feature}" ${isCompliant ? 'ativa' : 'não detectada'}`,
                    userId,
                ]);

                assessed++;
                if (isCompliant) passed++;
                else failed++;
            }

            return { assessed, passed, failed };
        } finally {
            client.release();
        }
    });

    // GET /v1/admin/compliance-hub/summary
    app.get('/v1/admin/compliance-hub/summary', { preHandler: auth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const result = await client.query(`
                SELECT
                    (SELECT COUNT(*) FROM compliance_frameworks WHERE is_active = true) as total_frameworks,
                    (SELECT COUNT(*) FROM compliance_controls cc JOIN compliance_frameworks cf ON cc.framework_id = cf.id WHERE cf.is_active = true) as total_controls,
                    (SELECT COUNT(*) FROM compliance_assessments WHERE org_id = $1 AND status = 'compliant') as compliant,
                    (SELECT COUNT(*) FROM compliance_assessments WHERE org_id = $1 AND status = 'partial') as partial,
                    (SELECT COUNT(*) FROM compliance_assessments WHERE org_id = $1 AND status = 'non_compliant') as non_compliant
            `, [orgId]);

            const row = result.rows[0];
            const total = parseInt(row.total_controls);
            const compliant = parseInt(row.compliant);
            const partial = parseInt(row.partial);
            const nonCompliant = parseInt(row.non_compliant);

            return {
                total_frameworks: parseInt(row.total_frameworks),
                total_controls: total,
                compliant,
                partial,
                non_compliant: nonCompliant,
                not_assessed: Math.max(0, total - compliant - partial - nonCompliant),
                compliance_rate: total > 0 ? Math.round((compliant / total) * 100 * 10) / 10 : 0,
            };
        } finally {
            client.release();
        }
    });
}
