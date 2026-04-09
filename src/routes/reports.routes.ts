import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
import { IntegrityService, ActionType } from '../lib/governance';
import { dlpEngine } from '../lib/dlp-engine';
import crypto from 'crypto';
import { generateComplianceReport, generateAuditReport } from '../lib/compliance-report';

/**
 * SEC-CSV-01: Sanitiza campos para evitar formula injection (CSV Injection / Excel Injection).
 * Caracteres de abertura de fórmula (=, +, -, @, TAB, CR/LF) são prefixados com
 * uma aspa simples, que faz o Excel/Google Sheets tratar o valor como texto literal.
 */
function sanitizeCsvField(value: string): string {
    if (/^[=+\-@\t\r\n]/.test(value)) {
        return `'${value}`;
    }
    return value;
}

export async function reportsRoutes(app: FastifyInstance, opts: { pgPool: Pool; requireAdminAuth: any; requireRole: any }) {
    const { pgPool, requireAdminAuth, requireRole } = opts;

    app.get('/v1/admin/reports/compliance', { preHandler: requireRole(['admin', 'dpo', 'auditor', 'sre']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { startDate, endDate, format } = request.query as { startDate?: string; endDate?: string; format?: string };

        // Default period: last 30 days
        const end = endDate ? new Date(endDate) : new Date();
        const start = startDate ? new Date(startDate) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);

            // 1. Assistants inventory
            const assistantsRes = await client.query(
                'SELECT id, name, status, created_at FROM assistants ORDER BY created_at DESC'
            );

            // 2. API Keys
            const apiKeysRes = await client.query(
                'SELECT id, name, is_active, created_at FROM api_keys ORDER BY created_at DESC'
            );

            // 3. Audit logs for the period
            const logsRes = await client.query(
                `SELECT id, action, metadata, signature, created_at 
             FROM audit_logs_partitioned 
             WHERE created_at >= $1 AND created_at <= $2 
             ORDER BY created_at DESC`,
                [start.toISOString(), end.toISOString()]
            );

            // 4. Aggregate counts
            const totalExecutions = logsRes.rows.filter(r => r.action === 'EXECUTION_SUCCESS').length;
            const totalViolations = logsRes.rows.filter(r => r.action === 'POLICY_VIOLATION').length;
            const totalErrors = logsRes.rows.filter(r => r.action === 'EXECUTION_ERROR').length;
            const total = totalExecutions + totalViolations + totalErrors || 1;
            const complianceRate = (((total - totalViolations) / total) * 100).toFixed(1);

            // 5. Violations grouped by reason
            const violationMap: Record<string, number> = {};
            logsRes.rows
                .filter(r => r.action === 'POLICY_VIOLATION')
                .forEach(r => {
                    const reason = r.metadata?.reason || 'Desconhecido';
                    violationMap[reason] = (violationMap[reason] || 0) + 1;
                });
            const violationsByType = Object.entries(violationMap)
                .map(([reason, count]) => ({ reason, count }))
                .sort((a, b) => b.count - a.count);

            // 6. Verify signatures on each log
            const signingSecret = process.env.SIGNING_SECRET!;
            const executions = logsRes.rows.map(row => {
                let signatureValid = false;
                try {
                    const recomputedSig = IntegrityService.signPayload(row.metadata, signingSecret);
                    signatureValid = row.signature === recomputedSig;
                } catch { /* sig verification failed */ }

                return {
                    id: row.id,
                    action: row.action,
                    created_at: row.created_at,
                    signature: row.signature || '',
                    signatureValid,
                    metadata: row.metadata,
                };
            });

            // Organization info
            const orgRes = await client.query('SELECT name FROM organizations WHERE id = $1', [orgId]);
            const orgName = orgRes.rows[0]?.name || 'Organização';

            const reportData = {
                organization: { id: orgId, name: orgName },
                period: { start: start.toISOString().split('T')[0], end: end.toISOString().split('T')[0] },
                generatedAt: new Date().toLocaleString('pt-BR'),
                assistants: assistantsRes.rows,
                apiKeys: apiKeysRes.rows,
                summary: { totalExecutions, totalViolations, totalErrors, complianceRate },
                violationsByType,
                executions,
            };

            // Return PDF or JSON
            if (format === 'pdf') {
                const pdfBuffer = await generateComplianceReport(reportData);

                reply.header('Content-Type', 'application/pdf');
                reply.header('Content-Disposition', `attachment; filename="compliance-report-${reportData.period.start}-${reportData.period.end}.pdf"`);
                return reply.send(pdfBuffer);
            }

            return reply.send(reportData);
        } catch (error) {
            app.log.error(error, "Error generating compliance report");
            reply.status(500).send({ error: "Erro ao gerar relatório de compliance" });
        } finally {
            client.release();
        }
    });

    // CSV Export — Full audit log without record limits
    app.get('/v1/admin/reports/compliance/csv', { preHandler: requireRole(['admin', 'dpo', 'auditor']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { startDate, endDate } = request.query as { startDate?: string; endDate?: string };
        const end = endDate ? new Date(endDate) : new Date();
        const start = startDate ? new Date(startDate) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);

            const logsRes = await client.query(
                `SELECT id, action, metadata, signature, created_at 
             FROM audit_logs_partitioned 
             WHERE created_at >= $1 AND created_at <= $2 
             ORDER BY created_at DESC`,
                [start.toISOString(), end.toISOString()]
            );

            const signingSecret = process.env.SIGNING_SECRET!;

            // CSV header
            const csvLines = ['"ID","Ação","Data/Hora","Assinatura","Verificação","Metadados"'];

            for (const row of logsRes.rows) {
                let sigValid = 'INVÁLIDA';
                try {
                    const recomputed = IntegrityService.signPayload(row.metadata, signingSecret);
                    if (row.signature === recomputed) sigValid = 'VÁLIDA';
                } catch { /* sig check failed */ }

                const metaStr = sanitizeCsvField(
                    JSON.stringify(row.metadata || {}).replace(/"/g, '""')
                );
                csvLines.push(
                    `"${sanitizeCsvField(row.id)}","${sanitizeCsvField(row.action)}","${new Date(row.created_at).toISOString()}","${sanitizeCsvField(row.signature)}","${sigValid}","${metaStr}"`
                );
            }

            reply.header('Content-Type', 'text/csv; charset=utf-8');
            reply.header('Content-Disposition', `attachment; filename="audit-log-${start.toISOString().split('T')[0]}-${end.toISOString().split('T')[0]}.csv"`);
            return reply.send(csvLines.join('\n'));
        } catch (error) {
            app.log.error(error, "Error generating CSV export");
            reply.status(500).send({ error: "Erro ao exportar CSV" });
        } finally {
            client.release();
        }
    });

    // ── Compliance Audit Report (7 sections + SHA-256 integrity hash) ────────
    app.get('/v1/admin/reports/compliance-audit', { preHandler: requireRole(['admin', 'dpo', 'auditor']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { from, to, format } = request.query as { from?: string; to?: string; format?: string };
        const end   = to   ? new Date(to)   : new Date();
        const start = from ? new Date(from) : new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000);

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

            // 1. Organization
            const orgRes = await client.query('SELECT name FROM organizations WHERE id = $1', [orgId]);
            const orgName = orgRes.rows[0]?.name || 'Organização';

            // 2. Assistant inventory (lifecycle_state in official/approved/under_review)
            const assistantsRes = await client.query(`
                SELECT id, name, status, lifecycle_state, risk_level, data_classification, created_at
                FROM assistants
                WHERE lifecycle_state IN ('official', 'approved', 'under_review')
                ORDER BY created_at DESC
            `);

            // 3. Posture history (last 10 snapshots)
            const postureRes = await client.query(`
                SELECT generated_at, summary_score, open_findings, unresolved_critical
                FROM shield_posture_snapshots
                ORDER BY generated_at DESC
                LIMIT 10
            `);

            // 4. Shadow AI findings grouped by severity + status
            const findingsRes = await client.query(`
                SELECT severity, status, COUNT(*) as count
                FROM shield_findings
                GROUP BY severity, status
                ORDER BY count DESC
            `);

            // 5. Execution metrics grouped by action for period
            const metricsRes = await client.query(`
                SELECT action, COUNT(*) as count
                FROM audit_logs_partitioned
                WHERE created_at >= $1 AND created_at <= $2
                GROUP BY action
                ORDER BY count DESC
            `, [start.toISOString(), end.toISOString()]);

            // 6. Audit trail (last 50 entries in period)
            const auditRes = await client.query(`
                SELECT id, action, metadata, signature, created_at
                FROM audit_logs_partitioned
                WHERE created_at >= $1 AND created_at <= $2
                ORDER BY created_at DESC
                LIMIT 50
            `, [start.toISOString(), end.toISOString()]);

            // Verify signatures
            const signingSecret = process.env.SIGNING_SECRET!;
            const auditTrail = auditRes.rows.map(row => {
                let signatureValid = false;
                try {
                    const recomputedSig = IntegrityService.signPayload(row.metadata, signingSecret);
                    signatureValid = row.signature === recomputedSig;
                } catch { /* sig check failed */ }
                return { id: row.id, action: row.action, created_at: row.created_at, signature: row.signature || '', signatureValid, metadata: row.metadata };
            });

            // Aggregations
            const byAction: Record<string, number> = {};
            metricsRes.rows.forEach(r => { byAction[r.action] = Number(r.count); });

            const totalExecutions = byAction['EXECUTION_SUCCESS'] || 0;
            const totalViolations = byAction['POLICY_VIOLATION'] || 0;
            const pendingApprovals = byAction['PENDING_APPROVAL'] || 0;
            const total = totalExecutions + totalViolations || 1;
            const complianceRate = (((total - totalViolations) / total) * 100).toFixed(1);

            const shadowBySeverity: Record<string, number> = {};
            const shadowByStatus: Record<string, number> = {};
            findingsRes.rows.forEach(r => {
                shadowBySeverity[r.severity] = (shadowBySeverity[r.severity] || 0) + Number(r.count);
                shadowByStatus[r.status]     = (shadowByStatus[r.status]     || 0) + Number(r.count);
            });
            const totalShadow = Object.values(shadowBySeverity).reduce((s, v) => s + v, 0);

            const latestPosture = postureRes.rows[0];
            const postureScore  = latestPosture ? Number(latestPosture.summary_score) : 0;

            const reportContent = {
                organization: { id: orgId, name: orgName },
                period: { from: start.toISOString().split('T')[0], to: end.toISOString().split('T')[0] },
                generatedAt: new Date().toISOString(),
                sections: {
                    executiveSummary: {
                        totalAssistants:  assistantsRes.rows.length,
                        activeAssistants: assistantsRes.rows.filter((a: any) => a.status === 'published').length,
                        postureScore,
                        complianceRate,
                        totalExecutions,
                        totalViolations,
                        pendingApprovals,
                    },
                    assistantInventory: assistantsRes.rows,
                    postureHistory: postureRes.rows.reverse().map((r: any) => ({
                        generated_at:        r.generated_at,
                        summary_score:       Number(r.summary_score),
                        open_findings:       Number(r.open_findings),
                        unresolved_critical: Number(r.unresolved_critical),
                    })),
                    shadowAI: { total: totalShadow, bySeverity: shadowBySeverity, byStatus: shadowByStatus },
                    executionMetrics: { byAction, period: { from: start.toISOString().split('T')[0], to: end.toISOString().split('T')[0] } },
                    auditTrail,
                },
            };

            // Integrity hash over full content
            const hash = crypto.createHash('sha256').update(JSON.stringify(reportContent)).digest('hex');
            const fullReport = { ...reportContent, integrity: { hash, algorithm: 'SHA-256' } };

            if (format === 'pdf') {
                const pdfBuffer = await generateAuditReport(fullReport);
                reply.header('Content-Type', 'application/pdf');
                reply.header('Content-Disposition', `attachment; filename="audit-report-${fullReport.period.from}-${fullReport.period.to}.pdf"`);
                return reply.send(pdfBuffer);
            }

            return reply.send(fullReport);
        } catch (error) {
            app.log.error(error, "Error generating compliance audit report");
            reply.status(500).send({ error: "Erro ao gerar relatório de auditoria" });
        } finally {
            client.release();
        }
    });

}
