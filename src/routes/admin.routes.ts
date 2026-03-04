import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
import { IntegrityService, ActionType } from '../lib/governance';
import { dlpEngine } from '../lib/dlp-engine';
import crypto from 'crypto';
import { generateGovernanceReport } from '../lib/compliance-report';

/**
 * Admin Routes Plugin — extracted from server.ts (DT-3 Refactoring)
 * Encapsulates all /v1/admin/* endpoints behind requireAdminAuth.
 */
export async function adminRoutes(app: FastifyInstance, opts: { pgPool: Pool; requireAdminAuth: any }) {
    const { pgPool, requireAdminAuth } = opts;

// --- ADMIN ROUTES ---

// 0. Login — with strict brute-force protection (R5 FIX)
app.post('/v1/admin/login', {
    config: {
        rateLimit: {
            max: 5,                    // Max 5 login attempts per minute per IP
            timeWindow: '1 minute',
            keyGenerator: (request: FastifyRequest) => request.ip,
            errorResponseBuilder: (_request: FastifyRequest, context: any) => ({
                error: 'Muitas tentativas de login. Tente novamente em 1 minuto.',
                retryAfter: context.ttl,
            }),
        }
    }
}, async (request, reply) => {
    const { email, password } = request.body as any;

    // Hardcoded for demo/MVP
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@govai.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin';

    if (email === adminEmail && password === adminPassword) {
        const token = app.jwt.sign({
            email,
            role: 'admin',
            // Hardcode orgId for demo
            orgId: '00000000-0000-0000-0000-000000000001'
        }, { expiresIn: '8h' });

        return reply.send({ token, message: 'Login successful' });
    }

    return reply.status(401).send({ error: 'Invalid credentials' });
});

// 1. Dashboard Stats
app.get('/v1/admin/stats', { preHandler: requireAdminAuth }, async (request, reply) => {
    const orgId = request.headers['x-org-id'] as string;

    if (!orgId) {
        return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório para visualização administrativa." });
    }

    const client = await pgPool.connect();
    try {
        await client.query(`SELECT set_config('app.current_org_id', \$1, true)`, [orgId]);

        const [assistantsRes, totalExecsRes, violationsRes, tokensRes] = await Promise.all([
            client.query('SELECT COUNT(*) FROM assistants'),
            client.query("SELECT COUNT(*) FROM audit_logs_partitioned WHERE action = 'EXECUTION_SUCCESS'"),
            client.query("SELECT COUNT(*) FROM audit_logs_partitioned WHERE action = 'POLICY_VIOLATION'"),
            client.query("SELECT SUM((metadata->'usage'->>'total_tokens')::int) as total_tokens FROM audit_logs_partitioned WHERE action = 'EXECUTION_SUCCESS' AND metadata->'usage'->>'total_tokens' IS NOT NULL")
        ]);

        // Mock usage history for charts (Last 7 days)
        const usage_history = Array.from({ length: 7 }).map((_, i) => {
            const date = new Date();
            date.setDate(date.getDate() - (6 - i));
            return {
                name: date.toLocaleDateString('pt-BR', { weekday: 'short' }),
                requests: Math.floor(Math.random() * 500) + 100,
                violations: Math.floor(Math.random() * 50)
            };
        });

        const totalTokens = parseInt(tokensRes.rows[0].total_tokens || '0', 10);
        // Estimate cost (assume averaged $0.15 per 1M tokens)
        const estimatedCost = (totalTokens / 1000000) * 0.15;

        return reply.send({
            total_assistants: parseInt(assistantsRes.rows[0].count, 10),
            total_executions: parseInt(totalExecsRes.rows[0].count, 10),
            total_violations: parseInt(violationsRes.rows[0].count, 10),
            total_tokens: totalTokens,
            estimated_cost_usd: estimatedCost.toFixed(4),
            usage_history
        });
    } catch (error) {
        app.log.error(error, "Error fetching admin stats");
        reply.status(500).send({ error: "Erro ao buscar métricas" });
    } finally {
        client.release();
    }
});

// 2. Audit Logs (Paginated)
app.get('/v1/admin/logs', { preHandler: requireAdminAuth }, async (request, reply) => {
    const orgId = request.headers['x-org-id'] as string;
    const { page = '1', limit = '10' } = request.query as { page?: string, limit?: string };

    if (!orgId) {
        return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
    }

    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const client = await pgPool.connect();

    try {
        await client.query(`SELECT set_config('app.current_org_id', \$1, true)`, [orgId]);

        // Security: List only logs from my organization using RLS isolation
        const res = await client.query(
            `SELECT id, action, metadata, signature, created_at 
             FROM audit_logs_partitioned 
             ORDER BY created_at DESC 
             LIMIT \$1 OFFSET \$2`,
            [parseInt(limit, 10), offset]
        );

        const countRes = await client.query('SELECT COUNT(*) FROM audit_logs_partitioned');

        return reply.send({
            logs: res.rows,
            pagination: {
                total: parseInt(countRes.rows[0].count, 10),
                page: parseInt(page, 10),
                pages: Math.ceil(parseInt(countRes.rows[0].count, 10) / parseInt(limit, 10))
            }
        });
    } catch (error) {
        app.log.error(error, "Error fetching admin logs");
        reply.status(500).send({ error: "Erro ao buscar logs" });
    } finally {
        client.release();
    }
});

// 3. Assistants List

    // --- Sub-Plugins ---
    const subOpts = { pgPool, requireAdminAuth };
    // Assistants, Policies, MCP, Knowledge routes
    const { assistantsRoutes } = await import('./assistants.routes');
    app.register(assistantsRoutes, subOpts);
    // Approvals (HITL) routes
    const { approvalsRoutes } = await import('./approvals.routes');
    app.register(approvalsRoutes, subOpts);
    // Reports (PDF, CSV) routes
    const { reportsRoutes } = await import('./reports.routes');
    app.register(reportsRoutes, subOpts);
}
