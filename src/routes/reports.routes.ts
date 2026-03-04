import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
import { IntegrityService, ActionType } from '../lib/governance';
import { dlpEngine } from '../lib/dlp-engine';
import crypto from 'crypto';
import { generateGovernanceReport } from '../lib/compliance-report';

export async function reportsRoutes(app: FastifyInstance, opts: { pgPool: Pool; requireAdminAuth: any }) {
    const { pgPool, requireAdminAuth } = opts;

app.get('/v1/admin/reports/compliance', { preHandler: requireAdminAuth }, async (request, reply) => {
    const orgId = request.headers['x-org-id'] as string;
    if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

    const { startDate, endDate, format } = request.query as { startDate?: string; endDate?: string; format?: string };

    // Default period: last 30 days
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate ? new Date(startDate) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

    const client = await pgPool.connect();
    try {
        await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);

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
            const { generateComplianceReport } = await import('./lib/compliance-report');
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
app.get('/v1/admin/reports/compliance/csv', { preHandler: requireAdminAuth }, async (request, reply) => {
    const orgId = request.headers['x-org-id'] as string;
    if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

    const { startDate, endDate } = request.query as { startDate?: string; endDate?: string };
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate ? new Date(startDate) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

    const client = await pgPool.connect();
    try {
        await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);

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

            const metaStr = JSON.stringify(row.metadata || {}).replace(/"/g, '""');
            csvLines.push(
                `"${row.id}","${row.action}","${new Date(row.created_at).toISOString()}","${row.signature}","${sigValid}","${metaStr}"`
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


}
