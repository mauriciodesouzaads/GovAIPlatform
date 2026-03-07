import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
import { IntegrityService, ActionType } from '../lib/governance';
import { dlpEngine } from '../lib/dlp-engine';
import crypto from 'crypto';
import bcrypt from 'bcrypt';


/**
 * Admin Routes Plugin — extracted from server.ts (DT-3 Refactoring)
 * Encapsulates all /v1/admin/* endpoints behind requireAdminAuth or requireRole.
 */
export async function adminRoutes(app: FastifyInstance, opts: { pgPool: Pool; requireAdminAuth: any; requireRole: any }) {
    const { pgPool, requireAdminAuth, requireRole } = opts;

    // --- ADMIN ROUTES ---

    // 0. Login — with robust DB check & Force Password Reset (Sprint 8)
    app.post('/v1/admin/login', {
        config: {
            rateLimit: {
                max: 10,
                timeWindow: '1 minute',
                keyGenerator: (request: FastifyRequest) => request.ip,
                errorResponseBuilder: (_request: FastifyRequest, context: any) => ({
                    statusCode: 429,
                    error: 'Too Many Requests',
                    message: 'Muitas tentativas de login. Tente novamente em 1 minuto.',
                    retryAfter: context.ttl,
                }),
            }
        }
    }, async (request, reply) => {
        const { email, password } = request.body as any;
        const client = await pgPool.connect();

        try {
            const res = await client.query(
                `SELECT id, org_id, password_hash, role, requires_password_change 
                 FROM users WHERE email = $1 AND sso_provider = 'local'`,
                [email]
            );

            if (res.rows.length === 0) {
                return reply.status(401).send({ error: 'Credenciais inválidas.' });
            }

            const user = res.rows[0];

            if (!user.password_hash) {
                return reply.status(401).send({ error: 'Conta não configurada para login local.' });
            }

            const isValid = await bcrypt.compare(password, user.password_hash);
            if (!isValid) {
                return reply.status(401).send({ error: 'Credenciais inválidas.' });
            }

            // Force password reset logic
            // Force password reset logic — Bypass for dev default password 'admin'
            if (user.requires_password_change) {
                // Return a temporary token specifically for password reset
                const resetToken = app.jwt.sign({ email, userId: user.id, orgId: user.org_id, resetOnly: true }, { expiresIn: '15m' });
                return reply.status(403).send({
                    error: 'Troca de senha obrigatória no primeiro login.',
                    requires_password_change: true,
                    resetToken
                });
            }

            const token = app.jwt.sign({
                email,
                role: user.role,
                orgId: user.org_id,
                userId: user.id
            }, { expiresIn: '8h' });

            return reply.send({ token, message: 'Login successful', role: user.role });
        } catch (error) {
            app.log.error(error, "Login error");
            return reply.status(500).send({ error: 'Erro interno ao processar login.' });
        } finally {
            client.release();
        }
    });

    // 0.1 Change Password endpoint for Force Reset
    app.post('/v1/admin/change-password', async (request, reply) => {
        // We use manual inspection instead of requireAdminAuth because the token is resetOnly: true
        const authHeader = request.headers.authorization;
        if (!authHeader) return reply.status(401).send({ error: "Token não fornecido" });

        const token = authHeader.split(' ')[1];
        let decoded: any;
        try {
            decoded = app.jwt.verify(token);
        } catch (e) {
            return reply.status(401).send({ error: "Token de redefinição inválido ou expirado." });
        }

        if (!decoded.resetOnly) {
            return reply.status(400).send({ error: "Este token não é válido para troca de senha obrigatória." });
        }

        const { newPassword } = request.body as any;
        if (!newPassword || newPassword.length < 12) {
            return reply.status(400).send({ error: "A nova senha corporativa deve ter no mínimo 12 caracteres." });
        }

        const client = await pgPool.connect();
        try {
            const hash = await bcrypt.hash(newPassword, 12);
            await client.query(
                `UPDATE users SET password_hash = $1, requires_password_change = false WHERE id = $2`,
                [hash, decoded.userId]
            );
            return reply.send({ success: true, message: "Senha alterada com sucesso. Faça login novamente." });
        } catch (error) {
            app.log.error(error, "Password reset error");
            return reply.status(500).send({ error: 'Erro interno ao atualizar a senha.' });
        } finally {
            client.release();
        }
    });

    // 1. Dashboard Stats
    app.get('/v1/admin/stats', { preHandler: requireAdminAuth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;

        if (!orgId) {
            return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório para visualização administrativa." });
        }

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);

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
    app.get('/v1/admin/logs', { preHandler: requireRole(['admin', 'dpo', 'auditor', 'sre', 'operator']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const { page = '1', limit = '10' } = request.query as { page?: string, limit?: string };

        if (!orgId) {
            return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
        }

        const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const client = await pgPool.connect();

        try {
            await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);

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

    // 3. Organizations List (Tenants)
    app.get('/v1/admin/organizations', { preHandler: requireRole(['admin']) }, async (request, reply) => {
        const client = await pgPool.connect();
        try {
            // No org isolation here because we want to see all tenants as platform admin
            const res = await client.query('SELECT id, name, status, created_at FROM organizations ORDER BY created_at DESC');
            return reply.send(res.rows);
        } catch (error) {
            app.log.error(error, "Error fetching organizations");
            reply.status(500).send({ error: "Erro ao buscar organizações" });
        } finally {
            client.release();
        }
    });

    // 4. Users List
    app.get('/v1/admin/users', { preHandler: requireRole(['admin']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const client = await pgPool.connect();
        try {
            if (orgId) {
                await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);
                const res = await client.query('SELECT id, email, role, status, created_at FROM users ORDER BY created_at DESC');
                return reply.send(res.rows);
            } else {
                // Platform admin view
                const res = await client.query('SELECT id, email, org_id, role, status, created_at FROM users ORDER BY created_at DESC');
                return reply.send(res.rows);
            }
        } catch (error) {
            app.log.error(error, "Error fetching users");
            reply.status(500).send({ error: "Erro ao buscar usuários" });
        } finally {
            client.release();
        }
    });

    // --- Sub-Plugins ---
    const subOpts = { pgPool, requireAdminAuth, requireRole };
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
