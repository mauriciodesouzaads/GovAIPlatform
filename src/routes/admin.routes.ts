import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
import { IntegrityService, ActionType } from '../lib/governance';
import { dlpEngine } from '../lib/dlp-engine';
import { mailer } from '../lib/mailer';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { LoginSchema, ChangePasswordSchema, zodErrors } from '../lib/schemas';


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
        const loginParsed = LoginSchema.safeParse(request.body);
        if (!loginParsed.success) {
            return reply.status(400).send({ error: 'Validation failed', details: zodErrors(loginParsed.error) });
        }
        const { email, password } = loginParsed.data;

        const client = await pgPool.connect();

        try {
            // P-01: Lookup sem RLS para obter org_id antes de setar contexto.
            // user_lookup é uma tabela pública (sem RLS) que mapeia email→org_id
            // para usuários locais. Isso elimina a necessidade do bypass IS NULL
            // na policy users_login_policy (CVE P-01: cross-tenant data leakage).
            const lookupRes = await client.query(
                `SELECT user_id, org_id FROM user_lookup WHERE email = $1`,
                [email]
            );

            if (lookupRes.rows.length === 0) {
                // Falha-rápida sem revelar se o email existe ou não
                return reply.status(401).send({ error: 'Credenciais inválidas.' });
            }

            // Setar contexto de org ANTES de qualquer query em tabelas com RLS
            const orgIdFromLookup: string = lookupRes.rows[0].org_id;
            await client.query(
                `SELECT set_config('app.current_org_id', $1, false)`,
                [orgIdFromLookup]
            );

            // Agora a query em users é 100% isolada pelo RLS (org_id = contexto)
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

            // SEC-AUTH-01: Force password reset applies unconditionally.
            // Removed: `&& password !== 'admin'` bypass that allowed skipping reset with the default password.
            if (user.requires_password_change) {
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

            // Cookie httpOnly: JS não pode ler o token — protege contra XSS.
            // O token também é retornado no corpo JSON para o AuthProvider do frontend.
            reply.setCookie('token', token, {
                path: '/',
                httpOnly: true,
                sameSite: 'lax',
                secure: process.env.NODE_ENV === 'production',
                maxAge: 8 * 60 * 60,
            });

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
        // Validate body structure first — returns 400 before touching auth logic
        const cpParsed = ChangePasswordSchema.safeParse(request.body);
        if (!cpParsed.success) {
            return reply.status(400).send({ error: 'Validation failed', details: zodErrors(cpParsed.error) });
        }
        const { newPassword } = cpParsed.data;

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

    // /v1/admin/logout — limpa o cookie httpOnly de sessão (SSO e login local)
    app.post('/v1/admin/logout', async (request, reply) => {
        reply.clearCookie('token', { path: '/' });
        return reply.send({ message: 'Logout realizado com sucesso.' });
    });

    // /v1/admin/me — retorna os claims do JWT atual (lido do httpOnly cookie ou Bearer token).
    // Necessário para que o frontend obtenha role/email após redirect SSO (Etapa 3).
    app.get('/v1/admin/me', { preHandler: requireAdminAuth }, async (request, reply) => {
        const user = request.user as { email?: string; role?: string; orgId?: string; userId?: string };
        return reply.send({
            email: user.email || null,
            role: user.role || 'operator',
            orgId: user.orgId || null,
            userId: user.userId || null,
        });
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

            const [assistantsRes, totalExecsRes, violationsRes, tokensRes, historyRes] = await Promise.all([
                client.query('SELECT COUNT(*) FROM assistants'),
                client.query("SELECT COUNT(*) FROM audit_logs_partitioned WHERE action = 'EXECUTION_SUCCESS'"),
                client.query("SELECT COUNT(*) FROM audit_logs_partitioned WHERE action = 'POLICY_VIOLATION'"),
                client.query("SELECT SUM((metadata->'usage'->>'total_tokens')::int) as total_tokens FROM audit_logs_partitioned WHERE action = 'EXECUTION_SUCCESS' AND metadata->'usage'->>'total_tokens' IS NOT NULL"),
                client.query(`
                    SELECT 
                        date(created_at) as date,
                        COUNT(*) FILTER (WHERE action = 'EXECUTION_SUCCESS') as requests,
                        COUNT(*) FILTER (WHERE action = 'POLICY_VIOLATION') as violations
                    FROM audit_logs_partitioned
                    WHERE created_at >= NOW() - INTERVAL '7 days'
                    GROUP BY date(created_at)
                    ORDER BY date ASC
                `)
            ]);

            const usage_history = historyRes.rows.map(row => ({
                name: new Date(row.date).toLocaleDateString('pt-BR', { weekday: 'short' }),
                requests: parseInt(row.requests, 10),
                violations: parseInt(row.violations, 10)
            }));

            const totalTokens = parseInt(tokensRes.rows[0].total_tokens || '0', 10);
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
    // SEC-AUDIT-01: limit is capped at MAX_AUDIT_LIMIT to prevent single-request DB dumps.
    const MAX_AUDIT_LIMIT = 500;

    app.get('/v1/admin/audit-logs', { preHandler: requireRole(['admin', 'dpo', 'auditor', 'sre', 'operator']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const { page = '1', limit = '10' } = request.query as { page?: string, limit?: string };

        if (!orgId) {
            return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
        }

        const parsedPage = Math.max(1, parseInt(page, 10) || 1);
        const parsedLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), MAX_AUDIT_LIMIT);
        const offset = (parsedPage - 1) * parsedLimit;
        const client = await pgPool.connect();

        try {
            await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);

            // RLS isolation: only returns logs for the caller's org (set_config above)
            const res = await client.query(
                `SELECT id, action, metadata, signature, created_at 
                 FROM audit_logs_partitioned 
                 ORDER BY created_at DESC 
                 LIMIT $1 OFFSET $2`,
                [parsedLimit, offset]
            );

            const countRes = await client.query('SELECT COUNT(*) FROM audit_logs_partitioned');

            return reply.send({
                logs: res.rows,
                pagination: {
                    total: parseInt(countRes.rows[0].count, 10),
                    page: parsedPage,
                    limit: parsedLimit,
                    pages: Math.ceil(parseInt(countRes.rows[0].count, 10) / parsedLimit),
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
            const res = await client.query(`
                SELECT id, name, status, created_at,
                       telemetry_consent, telemetry_consent_at, telemetry_pii_strip
                FROM organizations
                ORDER BY created_at DESC
            `);
            return reply.send(res.rows);
        } catch (error) {
            app.log.error(error, "Error fetching organizations");
            reply.status(500).send({ error: "Erro ao buscar organizações" });
        } finally {
            client.release();
        }
    });

    // 3a. Compliance Dashboard — tenants com telemetry_consent = TRUE
    // DT-G-02: rota para o painel de compliance LGPD/GDPR listar orgs que consentiram
    app.get('/v1/admin/organizations/telemetry-consented', { preHandler: requireRole(['admin', 'dpo']) }, async (request, reply) => {
        const client = await pgPool.connect();
        try {
            const res = await client.query(`
                SELECT o.id, o.name, o.status,
                       o.telemetry_consent, o.telemetry_consent_at, o.telemetry_pii_strip,
                       u.email AS consented_by_email
                FROM organizations o
                LEFT JOIN users u ON u.id = o.telemetry_consent_by
                WHERE o.telemetry_consent = TRUE
                ORDER BY o.telemetry_consent_at DESC
            `);
            return reply.send({
                total: res.rows.length,
                organizations: res.rows,
            });
        } catch (error) {
            app.log.error(error, "Error fetching telemetry-consented organizations");
            reply.status(500).send({ error: "Erro ao buscar organizações com consentimento" });
        } finally {
            client.release();
        }
    });

    // 3b. Ler estado de consentimento de uma org específica — DT-H-03
    app.get('/v1/admin/organizations/:id/telemetry-consent', {
        preHandler: requireRole(['admin', 'dpo']),
    }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const client = await pgPool.connect();
        try {
            const res = await client.query(
                `SELECT o.id, o.name,
                        o.telemetry_consent, o.telemetry_consent_at, o.telemetry_pii_strip,
                        u.email AS consented_by_email
                 FROM organizations o
                 LEFT JOIN users u ON u.id = o.telemetry_consent_by
                 WHERE o.id = $1`,
                [id]
            );
            if (res.rows.length === 0) {
                return reply.status(404).send({ error: 'Organização não encontrada.' });
            }
            return reply.send(res.rows[0]);
        } catch (error) {
            app.log.error(error, "Error fetching telemetry consent");
            return reply.status(500).send({ error: 'Erro ao buscar consentimento de telemetria.' });
        } finally {
            client.release();
        }
    });

    // 3c. Atualizar consentimento de telemetria — DT-G-01
    // PUT /v1/admin/organizations/:id/telemetry-consent
    // Body: { consent: boolean, pii_strip?: boolean }
    // Requer role admin ou dpo. Persiste auditoria HMAC-SHA256 na tabela audit_logs_partitioned.
    app.put('/v1/admin/organizations/:id/telemetry-consent', {
        preHandler: requireRole(['admin', 'dpo']),
    }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { consent?: boolean; pii_strip?: boolean };

        if (typeof body.consent !== 'boolean') {
            return reply.status(400).send({
                error: 'O campo "consent" (boolean) é obrigatório.',
            });
        }

        const callerUser = (request as any).user as { userId?: string; orgId?: string };
        const signingSecret = process.env.SIGNING_SECRET;
        if (!signingSecret) {
            app.log.error('SIGNING_SECRET não configurado — audit log de consentimento não pode ser assinado');
            return reply.status(500).send({ error: 'Configuração de segurança incompleta.' });
        }

        const client = await pgPool.connect();
        try {
            await client.query('BEGIN');

            // Verifica se a organização existe
            const orgCheck = await client.query(
                'SELECT id, name FROM organizations WHERE id = $1',
                [id]
            );
            if (orgCheck.rows.length === 0) {
                await client.query('ROLLBACK');
                return reply.status(404).send({ error: 'Organização não encontrada.' });
            }

            const orgName = orgCheck.rows[0].name as string;
            const consentAt = body.consent ? new Date() : null;
            const consentBy = body.consent ? (callerUser.userId ?? null) : null;
            const piiStrip = typeof body.pii_strip === 'boolean' ? body.pii_strip : true;

            // 1. Atualiza consentimento
            await client.query(
                `UPDATE organizations
                 SET telemetry_consent      = $1,
                     telemetry_consent_at   = $2,
                     telemetry_consent_by   = $3,
                     telemetry_pii_strip    = $4
                 WHERE id = $5`,
                [body.consent, consentAt, consentBy, piiStrip, id]
            );

            // 2. Grava evento de auditoria imutável com HMAC-SHA256 (LGPD — trilha de consentimento)
            const actionType = body.consent
                ? 'TELEMETRY_CONSENT_GRANTED'
                : 'TELEMETRY_CONSENT_REVOKED';

            const auditPayload = {
                org_id: id,
                org_name: orgName,
                action: actionType,
                consent: body.consent,
                pii_strip: piiStrip,
                performed_by_user_id: callerUser.userId ?? null,
                performed_at: new Date().toISOString(),
            };

            const signature = IntegrityService.signPayload(auditPayload, signingSecret);
            const auditId = crypto.randomUUID();

            await client.query(
                `INSERT INTO audit_logs_partitioned (id, action, metadata, signature, org_id)
                 VALUES ($1, $2, $3, $4, $5)`,
                [auditId, actionType, JSON.stringify(auditPayload), signature, id]
            );

            await client.query('COMMIT');

            app.log.info({
                event: actionType.toLowerCase(),
                org_id: id,
                pii_strip: piiStrip,
                updated_by: callerUser.userId,
                audit_id: auditId,
            }, `Telemetry consent ${body.consent ? 'granted' : 'revoked'} — audit log persisted`);

            // Notificação DPO assíncrona — LGPD Art. 41 (encarregado).
            // Fire-and-forget: a transação já commitou; falha de email NÃO reverte o consentimento.
            // O ID do audit log é incluído no email para rastreabilidade.
            const callerEmail = (request.user as any)?.email ?? null;
            setImmediate(() => {
                mailer.sendConsentChangeNotice({
                    orgId: id,
                    orgName,
                    consent: body.consent as boolean,
                    piiStrip,
                    performedByEmail: callerEmail,
                    performedAt: consentAt ?? new Date(),
                    auditLogId: auditId,
                }).then((result) => {
                    if ('error' in result) {
                        app.log.warn({ audit_id: auditId, smtp_error: result.error }, 'DPO email failed to send');
                    } else if (result.sent === false && 'skipped' in result) {
                        app.log.debug({ audit_id: auditId, reason: result.reason }, 'DPO email skipped (SMTP not configured)');
                    } else if (result.sent === true) {
                        app.log.info({ audit_id: auditId, message_id: result.messageId }, 'DPO consent notice sent');
                    }
                }).catch((err: unknown) => {
                    app.log.error({ err, audit_id: auditId }, 'Unexpected error sending DPO email');
                });
            });

            return reply.send({
                success: true,
                org_id: id,
                telemetry_consent: body.consent,
                telemetry_pii_strip: piiStrip,
                telemetry_consent_at: consentAt,
                updated_by: callerUser.userId ?? null,
                audit_log_id: auditId,
            });
        } catch (error) {
            await client.query('ROLLBACK');
            app.log.error(error, "Error updating telemetry consent");
            return reply.status(500).send({ error: 'Erro ao atualizar consentimento de telemetria.' });
        } finally {
            client.release();
        }
    });

    // 3d. Exportar trilha de auditoria de consentimento LGPD (CSV ou JSON)
    // GET /v1/admin/compliance/audit-trail?from=ISO&to=ISO&format=csv|json
    // Requer role admin ou dpo.
    app.get('/v1/admin/compliance/audit-trail', {
        preHandler: requireRole(['admin', 'dpo']),
    }, async (request, reply) => {
        const query = request.query as { from?: string; to?: string; format?: string };
        const format = query.format === 'json' ? 'json' : 'csv';

        const toDate = query.to ? new Date(query.to) : new Date();
        const fromDate = query.from
            ? new Date(query.from)
            : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 dias padrão

        if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
            return reply.status(400).send({ error: 'Parâmetros "from" e "to" devem ser datas ISO válidas.' });
        }

        const client = await pgPool.connect();
        try {
            const res = await client.query(
                `SELECT
                    al.id,
                    al.created_at,
                    al.org_id,
                    o.name AS org_name,
                    al.action,
                    al.metadata,
                    al.signature
                 FROM audit_logs_partitioned al
                 LEFT JOIN organizations o ON o.id = al.org_id
                 WHERE al.action IN ('TELEMETRY_CONSENT_GRANTED', 'TELEMETRY_CONSENT_REVOKED')
                   AND al.created_at >= $1
                   AND al.created_at <= $2
                 ORDER BY al.created_at DESC
                 LIMIT 10000`,
                [fromDate.toISOString(), toDate.toISOString()]
            );

            if (format === 'json') {
                return reply.send({ total: res.rows.length, from: fromDate, to: toDate, events: res.rows });
            }

            // CSV output
            const csvLines: string[] = [
                'id,created_at,org_id,org_name,action,performed_by_user_id,consent,pii_strip,signature_prefix',
            ];

            for (const row of res.rows) {
                const meta = typeof row.metadata === 'string'
                    ? JSON.parse(row.metadata)
                    : (row.metadata ?? {});
                const performedBy = meta.performed_by_user_id ?? '';
                const consent = meta.consent !== undefined ? String(meta.consent) : '';
                const piiStrip = meta.pii_strip !== undefined ? String(meta.pii_strip) : '';
                const sigPrefix = typeof row.signature === 'string' ? row.signature.substring(0, 16) + '...' : '';
                const orgName = (row.org_name ?? '').replace(/"/g, '""');

                csvLines.push(
                    [
                        row.id,
                        row.created_at instanceof Date
                            ? row.created_at.toISOString()
                            : String(row.created_at),
                        row.org_id,
                        `"${orgName}"`,
                        row.action,
                        performedBy,
                        consent,
                        piiStrip,
                        sigPrefix,
                    ].join(',')
                );
            }

            const filename = `lgpd-audit-trail-${fromDate.toISOString().split('T')[0]}-to-${toDate.toISOString().split('T')[0]}.csv`;
            reply.header('Content-Type', 'text/csv; charset=utf-8');
            reply.header('Content-Disposition', `attachment; filename="${filename}"`);
            return reply.send(csvLines.join('\r\n'));
        } catch (error) {
            app.log.error(error, 'Error exporting compliance audit trail');
            return reply.status(500).send({ error: 'Erro ao exportar trilha de auditoria.' });
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
