import 'dotenv/config';
import { initMonitoring, captureError } from './lib/monitoring';
// initMonitoring must be called before any route, worker, or plugin registration
initMonitoring();
import fs from 'fs';
import path from 'path';
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import fastifyJwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import rateLimit from '@fastify/rate-limit';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

import { GovernanceRequestSchema } from './lib/governance';
import { opaEngine } from './lib/opa-governance';
import { dlpEngine } from './lib/dlp-engine';
import { pgPool } from './lib/db';
import { redisCache } from './lib/redis';
import { renderPrometheusMetrics, getMetricsContentType, activePgConnections, updateComplianceConsentedOrgs } from './lib/sre-metrics';
import oidcRoutes from './routes/oidc.routes';
import { executeAssistant } from './services/execution.service';
import { auditQueue, initAuditWorker } from './workers/audit.worker';
import { initNotificationWorker, notificationQueue } from './workers/notification.worker';
import { initTelemetryWorker } from './workers/telemetry.worker';
import { initExpirationWorker } from './workers/expiration.worker';
import { exportTenantData, exportToCSV, generateDueDiligencePDF } from './lib/offboarding';
import { initKeyRotationJob } from './jobs/key-rotation.job';
import { initApiKeyRotationJob } from './jobs/api-key-rotation.job';
import { startShieldWorker } from './workers/shield.worker';
import { startShieldSchedule } from './jobs/shield-schedule.job';

// ---------------------------------------------------------------------------
// Fail-fast guards — must run before anything else
// ---------------------------------------------------------------------------
if (!process.env.SIGNING_SECRET || process.env.SIGNING_SECRET.trim() === '') {
    console.error('\n\x1b[31m[FATAL] SIGNING_SECRET is not defined or is empty.\x1b[0m');
    process.exit(1);
}
if (process.env.SIGNING_SECRET.length < 32) {
    console.error('\n\x1b[31m[FATAL] SIGNING_SECRET is too short (minimum 32 characters required).\x1b[0m');
    process.exit(1);
}
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error('\n\x1b[31m[FATAL] JWT_SECRET is not defined or too short (minimum 32 characters).\x1b[0m');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Workers — started before the HTTP server
// ---------------------------------------------------------------------------
initAuditWorker();
initExpirationWorker();
initNotificationWorker(pgPool);
initTelemetryWorker();
startShieldWorker();

// ---------------------------------------------------------------------------
// Jobs — scheduled tasks (run after server startup via internal delay)
// ---------------------------------------------------------------------------
initKeyRotationJob();
initApiKeyRotationJob();
startShieldSchedule();

// ---------------------------------------------------------------------------
// Fastify instance — pino-pretty only in non-production environments
// ---------------------------------------------------------------------------
const isProduction = process.env.NODE_ENV === 'production';

const fastify: FastifyInstance = Fastify({
    logger: isProduction
        ? { level: process.env.LOG_LEVEL || 'info' }
        : {
            level: process.env.LOG_LEVEL || 'info',
            transport: {
                target: 'pino-pretty',
                options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
            },
        },
    bodyLimit: 1_048_576, // 1 MB — rejects oversized payloads before they reach route handlers
});

declare module 'fastify' {
    interface FastifyRequest {
        auditContext?: { traceId: string };
    }
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

// P-09: Security headers — MUST be registered before any route
fastify.register(helmet, {
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'https:'],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'none'"],
        },
    },
    crossOriginEmbedderPolicy: false,
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
    },
    frameguard: { action: 'deny' },
    noSniff: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
});

// Swagger must be registered before routes to auto-document them
fastify.register(fastifySwagger, {
    openapi: {
        openapi: '3.0.3',
        info: {
            title: 'Gov.AI Platform API',
            description: 'Enterprise AI Governance Gateway — Compliance, Security & Observability',
            version: '1.0.0',
        },
        components: {
            securitySchemes: {
                bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'API Key (sk-govai-...)' }, // gitleaks:allow — swagger doc placeholder
            },
        },
    },
});

fastify.register(fastifySwaggerUi, { routePrefix: '/v1/docs' });

fastify.register(fastifyJwt, {
    secret: process.env.JWT_SECRET!,
    cookie: { cookieName: 'token', signed: false },
});

fastify.register(cookie, {
    secret: process.env.SIGNING_SECRET,
    parseOptions: {},
});

fastify.register(cors, {
    origin: [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:3002',
        process.env.ADMIN_UI_ORIGIN || '',
    ].filter(Boolean),
    credentials: true,
});

// P-12: Global rate limit + Retry-After header in seconds
fastify.register(rateLimit, {
    max: (request: FastifyRequest) => (request.headers.authorization ? 1000 : 50),
    timeWindow: '1 minute',
    redis: redisCache,
    skipOnError: true,
    keyGenerator: (request: FastifyRequest) => request.headers.authorization as string || request.ip,
    addHeaders: { 'retry-after': true },
    errorResponseBuilder: (_request, context) => ({
        statusCode: 429,
        error: 'Rate limit exceeded',
        message: 'Limite de requisições excedido.',
        retryAfter: Math.ceil(context.ttl / 1000),
    }),
});

// ---------------------------------------------------------------------------
// Auth middleware — exported for use in route plugins
// ---------------------------------------------------------------------------

/** requireAuthenticated — verifies JWT and sets x-org-id. No role check. */
export const requireAuthenticated = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        await request.jwtVerify();
        const user = request.user as { orgId?: string };
        if (user?.orgId) request.headers['x-org-id'] = user.orgId;
    } catch {
        return reply.status(401).send({ error: 'Unauthorized: Invalid or expired JWT token.' });
    }
};

/** @deprecated Use requireAuthenticated. Kept as alias during migration. */
export const requireAdminAuth = requireAuthenticated;

/** requireTenantRole — verifies JWT, sets x-org-id, enforces tenant-scoped role list. */
export const requireTenantRole = (allowedRoles: string[]) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            await request.jwtVerify();
            const user = request.user as { orgId?: string; role?: string };
            if (user?.orgId) request.headers['x-org-id'] = user.orgId;
            const userRole = user?.role || 'operator';
            if (userRole === 'admin') return;
            if (!allowedRoles.includes(userRole)) {
                return reply.status(403).send({
                    error: `Acesso negado. Requer um dos seguintes perfis: ${allowedRoles.join(', ')}`,
                });
            }
        } catch {
            return reply.status(401).send({ error: 'Unauthorized: Invalid or expired JWT token.' });
        }
    };

/** @deprecated Use requireTenantRole. Kept as alias during migration. */
export const requireRole = requireTenantRole;

/** requirePlatformAdmin — verifies JWT and enforces role === 'platform_admin'.
 *  Tenant admin roles are explicitly rejected to prevent privilege escalation. */
export const requirePlatformAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        await request.jwtVerify();
        const user = request.user as { role?: string; orgId?: string };
        if (user?.orgId) request.headers['x-org-id'] = user.orgId;
        if (user?.role !== 'platform_admin') {
            return reply.status(403).send({ error: 'Requer privilégio de platform admin' });
        }
    } catch {
        return reply.status(401).send({ error: 'Unauthorized: Invalid or expired JWT token.' });
    }
};

const requireApiKey = async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Unauthorized: Missing or invalid Authorization header.' });
    }
    const token = authHeader.substring(7);
    const tokenHash = crypto
        .createHmac('sha256', process.env.SIGNING_SECRET!)
        .update(JSON.stringify({ key: token }))
        .digest('hex');
    const prefix = token.substring(0, 12);
    // P-01: Consulta api_key_lookup (sem RLS) em vez de api_keys.
    // api_keys_auth_policy não tem mais IS NULL — qualquer query sem contexto
    // org retornaria 0 rows. api_key_lookup é a fonte de verdade pública para
    // resolução de org_id a partir de uma API key (sem bypass de isolamento).
    const client = await pgPool.connect();
    try {
        const res = await client.query(
            `SELECT akl.org_id
             FROM api_key_lookup akl
             WHERE akl.key_hash = $1
               AND akl.prefix = $2
               AND akl.is_active = TRUE
               AND (akl.expires_at IS NULL OR akl.expires_at > NOW())
             LIMIT 1`,
            [tokenHash, prefix]
        );
        if (res.rowCount === 0) {
            return reply.status(403).send({ error: 'Forbidden: Invalid or revoked API Key.' });
        }
        request.headers['x-org-id'] = res.rows[0].org_id;
    } catch (e) {
        request.log.error(e, 'Error checking API key');
        return reply.status(500).send({ error: 'Auth Validation failed' });
    } finally {
        client.release();
    }
};

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------
fastify.addHook('onRequest', async (request, reply) => {
    const traceId = uuidv4();
    request.headers['x-govai-trace-id'] = traceId;
    reply.header('x-govai-trace-id', traceId);
    request.auditContext = { traceId };
});

// Update PG connection gauge periodically (non-blocking)
setInterval(() => {
    activePgConnections.set(pgPool.totalCount - pgPool.idleCount);
}, 15_000);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// P-12: Execute rate limit (100/min, key :execute) — independente do login
fastify.post('/v1/execute/:assistantId', {
    config: {
        rateLimit: {
            max: 100,
            timeWindow: '1 minute',
            keyGenerator: (request: FastifyRequest) => request.ip + ':execute',
            errorResponseBuilder: (_request, context) => ({
                statusCode: 429,
                error: 'Rate limit exceeded',
                message: 'Limite de execuções por minuto excedido.',
                retryAfter: Math.ceil(context.ttl / 1000),
            }),
        }
    },
    preHandler: requireApiKey
}, async (request, reply) => {
    const { assistantId } = request.params as { assistantId: string };
    const orgId = request.headers['x-org-id'] as string;
    const parseResult = GovernanceRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
        return reply.status(400).send({ error: 'Input inválido', details: parseResult.error.format() });
    }
    const result = await executeAssistant({
        assistantId,
        orgId,
        message: parseResult.data.message,
        model: parseResult.data.model,
        traceId: request.auditContext!.traceId,
        log: request.log,
    });
    return reply.status(result.statusCode).send(result.body);
});

// Sandbox: rate limit dedicado (20 req/min/IP) — mais restritivo que o global (50/min).
// Evita enumeração automatizada das regras de política OPA e DLP.
const sandboxRateLimit = async (request: FastifyRequest, reply: FastifyReply) => {
    const ip = request.ip;
    const key = `sandbox_rl:${ip}`;
    const WINDOW_SEC = 60;
    const MAX_REQUESTS = 20;

    if (redisCache.status === 'ready') {
        try {
            const count = await redisCache.incr(key);
            if (count === 1) await redisCache.expire(key, WINDOW_SEC);
            if (count > MAX_REQUESTS) {
                return reply.status(429).send({
                    error: 'Too Many Requests',
                    message: `Sandbox: limite de ${MAX_REQUESTS} requisições por minuto excedido.`,
                });
            }
            return;
        } catch { /* Redis indisponível — cair no fallback in-memory */ }
    }

    // Fallback in-memory simples (single-process)
    const now = Date.now();
    const sandboxStore = (global as any).__sandboxRlStore ||= new Map<string, { count: number; resetAt: number }>();
    const entry = sandboxStore.get(ip);
    if (!entry || now > entry.resetAt) {
        sandboxStore.set(ip, { count: 1, resetAt: now + WINDOW_SEC * 1000 });
        return;
    }
    entry.count++;
    if (entry.count > MAX_REQUESTS) {
        return reply.status(429).send({
            error: 'Too Many Requests',
            message: `Sandbox: limite de ${MAX_REQUESTS} requisições por minuto excedido.`,
        });
    }
};

fastify.post('/v1/sandbox/execute', { preHandler: sandboxRateLimit }, async (request, reply) => {
    const parseResult = GovernanceRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
        return reply.status(400).send({ error: 'Input inválido', details: parseResult.error.format() });
    }
    const policyCheck = await opaEngine.evaluate(
        { message: parseResult.data.message },
        { rules: { pii_filter: true, forbidden_topics: ['hack', 'bypass'] } }
    );
    return reply.send({
        _sandbox: true,
        message: parseResult.data.message,
        policy_result: policyCheck,
        note: 'Sandbox mode — no LLM call was made.',
    });
});

fastify.get('/v1/admin/export/tenant', { preHandler: requireTenantRole(['admin', 'dpo']) }, async (request, reply) => {
    const orgId = request.headers['x-org-id'] as string;
    if (!orgId) return reply.status(401).send({ error: 'x-org-id required' });
    const format = (request.query as any).format || 'json';
    const exportData = await exportTenantData(pgPool, orgId);
    if (format === 'csv') {
        reply.header('Content-Type', 'text/csv; charset=utf-8');
        reply.header('Content-Disposition', `attachment; filename="govai-tenant-export-${orgId}.csv"`);
        return reply.send(exportToCSV(exportData));
    }
    return reply.send({ org_id: orgId, exported_at: new Date().toISOString(), tables: exportData });
});

fastify.get('/v1/admin/export/due-diligence', { preHandler: requireTenantRole(['admin', 'dpo', 'auditor']) }, async (_request, reply) => {
    const pdfBuffer = await generateDueDiligencePDF();
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', 'attachment; filename="govai-security-due-diligence.pdf"');
    return reply.send(pdfBuffer);
});

// Metrics endpoint — requires METRICS_API_KEY bearer token.
// Prometheus telemetry can contain sensitive operational data (queue depths,
// PG connections, DLP detection rates). Never expose it unauthenticated.
const metricsApiKey = process.env.METRICS_API_KEY;
if (!metricsApiKey && isProduction) {
    fastify.log.warn(
        'METRICS_API_KEY not set — /metrics endpoint will be disabled in production. ' +
        'Set METRICS_API_KEY to a strong random value: openssl rand -hex 32'
    );
}

fastify.get('/metrics', async (request, reply) => {
    if (!metricsApiKey) {
        if (isProduction) {
            return reply.status(503).send({ error: 'Metrics endpoint disabled: METRICS_API_KEY not configured.' });
        }
        // Non-production without key: allow access for local dev/test convenience
    } else {
        const authHeader = request.headers.authorization;
        const provided = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
        if (!provided || provided !== metricsApiKey) {
            return reply.status(401).send({ error: 'Unauthorized: valid METRICS_API_KEY bearer token required.' });
        }
    }
    reply.header('Content-Type', getMetricsContentType());
    return reply.send(await renderPrometheusMetrics());
});

fastify.get('/health', async (_request, reply) => {
    let dbStatus: 'connected' | 'disconnected' = 'disconnected';
    let redisStatus: 'connected' | 'disconnected' = 'disconnected';
    let litellmStatus: 'connected' | 'disconnected' = 'disconnected';

    // --- DB ---
    try {
        await pgPool.query('SELECT 1');
        dbStatus = 'connected';
    } catch (_e) { /* already disconnected */ }

    // --- Redis ---
    try {
        const pong = await redisCache.ping();
        redisStatus = pong === 'PONG' ? 'connected' : 'disconnected';
    } catch (_e) { /* already disconnected */ }

    // --- LiteLLM (non-blocking, 2 s timeout) ---
    try {
        const litellmUrl = process.env.LITELLM_URL || 'http://litellm:4000';
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2000);
        const res = await fetch(`${litellmUrl}/health`, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
        litellmStatus = res.ok ? 'connected' : 'disconnected';
    } catch (_e) { /* timeout or unreachable */ }

    const overallStatus =
        dbStatus === 'connected' && redisStatus === 'connected'
            ? 'ok'
            : dbStatus === 'disconnected'
            ? 'error'
            : 'degraded';

    const httpCode = overallStatus === 'error' ? 503 : 200;

    return reply.status(httpCode).send({
        status: overallStatus,
        db: dbStatus,
        redis: redisStatus,
        litellm: litellmStatus,
        uptime: Math.floor(process.uptime()),
        version: process.env.npm_package_version || '1.0.0',
        environment: process.env.NODE_ENV || 'development',
    });
});

// ---------------------------------------------------------------------------
// Public routes — accessible with API key only (no admin JWT required)
// ---------------------------------------------------------------------------

// GET /v1/public/assistant/:assistantId — returns safe public info for the end-user chat UI.
// Uses requireApiKey to resolve org_id (needed for RLS), but does not require admin JWT.
// Returns 404 if the assistant is not in 'official' lifecycle state.
fastify.get('/v1/public/assistant/:assistantId', { preHandler: requireApiKey }, async (request, reply) => {
    const { assistantId } = request.params as { assistantId: string };
    const orgId = request.headers['x-org-id'] as string;

    const client = await pgPool.connect();
    try {
        await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

        const [assistantRes, policyRes] = await Promise.all([
            client.query(
                `SELECT id, name, description, lifecycle_state
                 FROM assistants
                 WHERE id = $1 AND org_id = $2`,
                [assistantId, orgId]
            ),
            client.query(
                `SELECT COUNT(*)::int AS count FROM policy_versions WHERE org_id = $1`,
                [orgId]
            ),
        ]);

        if (assistantRes.rows.length === 0 || assistantRes.rows[0].lifecycle_state !== 'official') {
            return reply.status(404).send({ error: 'Assistente não disponível ou não publicado.' });
        }

        const row = assistantRes.rows[0];
        return reply.send({
            id: row.id,
            name: row.name,
            description: row.description ?? null,
            lifecycle_state: row.lifecycle_state,
            policyCount: policyRes.rows[0].count,
        });
    } catch (error) {
        fastify.log.error(error, 'Error fetching public assistant info');
        return reply.status(500).send({ error: 'Erro ao buscar informações do assistente.' });
    } finally {
        client.release();
    }
});

// ---------------------------------------------------------------------------
// Route plugins
// ---------------------------------------------------------------------------
fastify.register(oidcRoutes, { pgPool }); // GA-005/GA-006: unified OIDC with JIT provisioning + Bearer-only session

import { adminRoutes } from './routes/admin.routes';
import { consultantRoutes } from './routes/consultant.routes';
import { shieldRoutes } from './routes/shield.routes';
import { architectRoutes } from './routes/architect.routes';
import { webhookRoutes } from './routes/webhook.routes';
import { policiesRoutes } from './routes/policies.routes';
import { settingsRoutes } from './routes/settings.routes';
import { complianceHubRoutes } from './routes/compliance-hub.routes';
import { modelCardRoutes } from './routes/model-card.routes';
import { riskAssessmentRoutes } from './routes/risk-assessment.routes';
import { monitoringRoutes } from './routes/monitoring.routes';
import { runRetentionArchiving } from './jobs/retention-archive.job';

fastify.register(adminRoutes, { pgPool, requireAdminAuth: requireAuthenticated, requireRole: requireTenantRole, requirePlatformAdmin });
// assistantsRoutes, approvalsRoutes, reportsRoutes registered internally by adminRoutes

fastify.register(consultantRoutes, { pgPool, requireTenantRole });
fastify.register(shieldRoutes, { pgPool, requireRole: requireTenantRole });
fastify.register(architectRoutes, { pgPool, requireRole: requireTenantRole });
fastify.register(webhookRoutes, { pgPool, requireRole: requireTenantRole });
fastify.register(policiesRoutes, { pgPool, requireRole: requireTenantRole });
fastify.register(settingsRoutes, { pgPool, requireRole: requireTenantRole });
fastify.register(complianceHubRoutes, { pgPool, requireRole: requireTenantRole });
fastify.register(modelCardRoutes, { pgPool, requireRole: requireTenantRole });
fastify.register(riskAssessmentRoutes, { pgPool, requireRole: requireTenantRole });
fastify.register(monitoringRoutes, { pgPool, requireRole: requireTenantRole });

// ---------------------------------------------------------------------------
// Global error handler — captures unhandled 500s to Sentry
// ---------------------------------------------------------------------------
fastify.setErrorHandler((error, request, reply) => {
    fastify.log.error(error, 'Unhandled request error');
    captureError(error instanceof Error ? error : new Error(String(error)), {
        url: request.url,
        method: request.method,
        orgId: (request.headers as Record<string, unknown>)['x-org-id'],
    });
    if (!reply.sent) {
        reply.status(500).send({ error: 'Internal server error' });
    }
});

// ---------------------------------------------------------------------------
// Server startup — OPA WASM initialized here so first request is not penalized
// ---------------------------------------------------------------------------
const start = async () => {
    // Initialize OPA WASM at startup (not lazily on first request)
    const wasmPathProd = path.join(__dirname, 'lib/opa/policy.wasm');
    const wasmPathDev = path.join(process.cwd(), 'src/lib/opa/policy.wasm');
    const wasmPath = fs.existsSync(wasmPathProd) ? wasmPathProd : wasmPathDev;
    if (fs.existsSync(wasmPath)) {
        const wasmBuffer = fs.readFileSync(wasmPath);
        await opaEngine.initialize(wasmBuffer, pgPool);
        fastify.log.info({ wasmPath }, 'OPA WASM policy loaded');
    } else {
        fastify.log.warn('OPA WASM policy not found — using native fallback rules only');
    }

    try {
        const port = parseInt(process.env.PORT || '3000', 10);
        await fastify.listen({ port, host: '0.0.0.0' });
        fastify.log.info(`GovAI Platform listening on port ${port}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }

    // ── Compliance gauge refresh ──────────────────────────────────────────────
    // Atualiza a gauge govai_compliance_consented_orgs a cada 5 min para que o
    // Grafana mostre o número de organizações com consentimento LGPD ativo.
    const refreshComplianceMetrics = async () => {
        try {
            const res = await pgPool.query(
                `SELECT COUNT(*)::int AS count FROM organizations WHERE telemetry_consent = TRUE`
            );
            updateComplianceConsentedOrgs(res.rows[0].count ?? 0);
        } catch (err) {
            fastify.log.warn(err, 'Failed to refresh govai_compliance_consented_orgs gauge');
        }
    };
    // Execute imediatamente ao iniciar e depois periodicamente
    await refreshComplianceMetrics();
    const COMPLIANCE_REFRESH_MS = 5 * 60 * 1000; // 5 minutos
    setInterval(refreshComplianceMetrics, COMPLIANCE_REFRESH_MS).unref();

    // ── Retention archiving cron — daily at ~03:30 ─────────────────────────────
    setInterval(async () => {
        const now = new Date();
        if (now.getHours() === 3 && now.getMinutes() >= 30 && now.getMinutes() < 31) {
            fastify.log.info('[RETENTION] Starting daily retention archiving...');
            await runRetentionArchiving().catch(err =>
                fastify.log.warn(err, '[RETENTION] Archiving job failed')
            );
        }
    }, 60_000).unref();

    // ── Exception expiring cron — daily check for exceptions expiring in <7 days ──
    const checkExpiringExceptions = async () => {
        try {
            const res = await pgPool.query(
                `SELECT pe.id, pe.org_id, pe.assistant_id, pe.exception_type, pe.expires_at
                 FROM policy_exceptions pe
                 WHERE pe.status = 'approved'
                   AND pe.expires_at BETWEEN NOW() AND NOW() + interval '7 days'`
            );
            for (const exc of res.rows) {
                await notificationQueue.add('exception.expiring', {
                    event: 'exception.expiring',
                    orgId: exc.org_id,
                    assistantId: exc.assistant_id,
                    approvalId: exc.id,
                    reason: `Exceção "${exc.exception_type}" expira em ${new Date(exc.expires_at).toLocaleDateString('pt-BR')}`,
                    expiresAt: exc.expires_at,
                    timestamp: new Date().toISOString(),
                    metadata: { exceptionId: exc.id, exceptionType: exc.exception_type },
                }).catch(() => {});
            }
        } catch (err) {
            fastify.log.warn(err, 'Failed to check expiring exceptions');
        }
    };
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    setInterval(checkExpiringExceptions, ONE_DAY_MS).unref();
};

start();

export { fastify };
