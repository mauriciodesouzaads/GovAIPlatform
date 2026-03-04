import Fastify, { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
import { GovernanceRequestSchema, IntegrityService, ActionType } from './lib/governance';
import { opaEngine } from './lib/opa-governance';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { auditQueue, initAuditWorker } from './workers/audit.worker';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import crypto from 'crypto';
import { dlpEngine } from './lib/dlp-engine';
import { notificationQueue, initNotificationWorker } from './workers/notification.worker';
import { telemetryQueue, initTelemetryWorker } from './workers/telemetry.worker';
import { initExpirationWorker } from './workers/expiration.worker';
import { registerOidcRoutes } from './lib/auth-oidc';
import { recordRequest, recordDlpDetection } from './lib/sre-metrics';

// ---------------------------------------------------------------------------
// C1 FIX: Hard-fail if SIGNING_SECRET is missing — prevents silent crypto failures
// ---------------------------------------------------------------------------
if (!process.env.SIGNING_SECRET || process.env.SIGNING_SECRET.trim() === '') {
    console.error('\n\x1b[31m[FATAL] SIGNING_SECRET is not defined or is empty.\x1b[0m');
    console.error('The server CANNOT start without a valid signing secret.');
    console.error('Set SIGNING_SECRET in your .env file or environment variables.\n');
    process.exit(1);
}
if (process.env.SIGNING_SECRET.length < 32) {
    console.error('\n\x1b[31m[FATAL] SIGNING_SECRET is too short (minimum 32 characters required).\x1b[0m');
    console.error(`Current length: ${process.env.SIGNING_SECRET.length} characters.`);
    console.error('Use a cryptographically strong secret: openssl rand -hex 32\n');
    process.exit(1);
}

// Start workers
initAuditWorker();
initExpirationWorker();
initNotificationWorker();

declare module 'fastify' {
    interface FastifyRequest {
        auditContext?: { traceId: string };
    }
}

const fastify: FastifyInstance = Fastify({
    logger: {
        level: process.env.LOG_LEVEL || 'info',
        transport: {
            target: 'pino-pretty',
            options: {
                translateTime: 'HH:MM:ss Z',
                ignore: 'pid,hostname',
            },
        },
    }
});

// ---------------------------------------------------------------------------
// B2 FIX: Hard-fail if JWT_SECRET is missing — prevents forged admin tokens
// ---------------------------------------------------------------------------
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error('\n\x1b[31m[FATAL] JWT_SECRET is not defined or too short (minimum 32 characters).\x1b[0m');
    console.error('Use a cryptographically strong secret: openssl rand -hex 32\n');
    process.exit(1);
}

// Register JWT
fastify.register(fastifyJwt, {
    secret: process.env.JWT_SECRET
});

// Admin Auth Hook — enforces JWT and injects orgId from token claims
export const requireAdminAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        await request.jwtVerify();
        // Extract orgId from JWT claims and inject into headers for downstream RLS
        const user = request.user as { orgId?: string; email?: string; role?: string };
        if (user?.orgId) {
            request.headers['x-org-id'] = user.orgId;
        }
    } catch (err) {
        return reply.status(401).send({ error: 'Unauthorized: Invalid or expired JWT token.' });
    }
};

// Register CORS (restricted to admin UI origins)
// Configure cookies for OIDC state tracking
fastify.register(cookie, {
    secret: process.env.SIGNING_SECRET || 'fallback-secret-for-dev',
    parseOptions: {}
});

fastify.register(cors, {
    origin: [
        'http://localhost:3000',                   // Admin UI (free port)
        'http://localhost:3001',                   // Admin UI (dev/docker)
        'http://localhost:3002',                   // Admin UI (alternative local dev)
        process.env.ADMIN_UI_ORIGIN || ''          // Production override via env
    ].filter(Boolean),
    credentials: true,
});

// Register Rate Limiting (Redis-backed)
import rateLimit from '@fastify/rate-limit';
import Redis from 'ioredis';

fastify.register(rateLimit, {
    max: 100,           // Max 100 requests per window
    timeWindow: '1 minute',
    redis: new Redis(process.env.REDIS_URL || 'redis://localhost:6379'),
    keyGenerator: (request: FastifyRequest) => {
        // Rate limit by API key or IP
        return request.headers.authorization || request.ip;
    },
});

const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });

// Tracing Middleware
fastify.addHook('onRequest', async (request, reply) => {
    const traceId = uuidv4();
    request.headers['x-govai-trace-id'] = traceId;
    reply.header('x-govai-trace-id', traceId);
    request.auditContext = { traceId };
});

// --- AUTHENTICATION MIDDLEWARE ---
const requireApiKey = async (request: FastifyRequest, reply: FastifyReply) => {
    // 1. Extract API Key from Bearer token
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({ error: "Unauthorized: Missing or invalid Authorization header (Bearer token required)." });
    }
    const token = authHeader.substring(7);

    // 2. Compute SHA-256 hash of provided token and compare against DB
    const tokenHash = crypto.createHmac('sha256', process.env.SIGNING_SECRET || 'govai-default-secret')
        .update(JSON.stringify({ key: token }))
        .digest('hex');
    const prefix = token.substring(0, 12);

    const client = await pgPool.connect();
    try {
        const res = await client.query(
            'SELECT org_id FROM api_keys WHERE key_hash = $1 AND prefix = $2 AND is_active = TRUE LIMIT 1',
            [tokenHash, prefix]
        );

        if (res.rowCount === 0) {
            return reply.status(403).send({ error: "Forbidden: Invalid or revoked API Key." });
        }

        // 3. Inject org context for downstream RLS
        request.headers['x-org-id'] = res.rows[0].org_id;

    } catch (e) {
        request.log.error(e, "Error checking API key");
        return reply.status(500).send({ error: "Auth Validation failed" });
    } finally {
        client.release();
    }
};

fastify.post('/v1/execute/:assistantId', { preHandler: requireApiKey }, async (request, reply) => {
    const { assistantId } = request.params as { assistantId: string };

    // Auth middleware (requireApiKey) automatically injects the verified x-org-id
    const orgId = request.headers['x-org-id'] as string;

    const parseResult = GovernanceRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
        return reply.status(400).send({ error: "Input inválido", details: parseResult.error.format() });
    }

    const { message } = parseResult.data;
    const client = await pgPool.connect();
    const execStart = Date.now();

    try {
        // 1. RLS: Define context for current org
        await client.query(`SELECT set_config('app.current_org_id', \$1, true)`, [orgId]);

        // 2. Fetch Active Assistant Version & Policy (RLS ensures it belongs to the Org)
        const versionRes = await client.query(`
            SELECT av.id as version_id, pv.rules_jsonb as policy_rules
            FROM assistant_versions av
            JOIN policy_versions pv ON av.policy_version_id = pv.id
            WHERE av.assistant_id = \$1 AND av.status = 'published'
            ORDER BY av.version DESC LIMIT 1
        `, [assistantId]);

        let policyRules = { pii_filter: true, forbidden_topics: ['hack', 'bypass'] };

        if (versionRes.rows.length > 0) {
            policyRules = versionRes.rows[0].policy_rules;
        } else {
            const assistantRes = await client.query('SELECT id FROM assistants WHERE id = \$1 AND status = \$2', [assistantId, 'published']);
            if (assistantRes.rows.length === 0) {
                return reply.status(404).send({ error: 'Assistente não encontrado.' });
            }
        }

        const traceId = request.auditContext?.traceId;

        // 3. Active Governance Validation (OPA + Native Rules)
        // Initialize OPA with pgPool for DB-driven keyword lookup
        if (!opaEngine['pool']) {
            await opaEngine.initialize(undefined, pgPool);
        }

        const policyContext = {
            orgId, // Passed to OPA for per-tenant keyword lookup from org_hitl_keywords
            rules: policyRules
        };

        const policyCheck = await opaEngine.evaluate({ message, orgId }, policyContext);

        // HITL: If OPA says PENDING_APPROVAL, pause execution and queue for human review
        if (policyCheck.action === 'PENDING_APPROVAL') {
            const sanitizedMessage = dlpEngine.sanitize(message).sanitizedText;

            // Save to pending_approvals table
            const approvalRes = await client.query(
                `INSERT INTO pending_approvals (org_id, assistant_id, message, policy_reason, trace_id) 
                 VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
                [orgId, assistantId, sanitizedMessage, policyCheck.reason, traceId]
            );
            const approvalId = approvalRes.rows[0].id;

            // Audit log
            const hitlPayload = { reason: policyCheck.reason, input: sanitizedMessage, approvalId, traceId };
            const signature = IntegrityService.signPayload(hitlPayload, process.env.SIGNING_SECRET!);

            await auditQueue.add('persist-log', {
                org_id: orgId,
                assistant_id: assistantId,
                action: 'PENDING_APPROVAL' satisfies ActionType,
                metadata: hitlPayload,
                signature,
                traceId
            }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

            // Structured webhook notification via notification queue
            await notificationQueue.add('send-notification', {
                event: 'PENDING_APPROVAL',
                orgId, assistantId, approvalId,
                reason: policyCheck.reason || 'Ação de alto risco',
                traceId,
                expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
                timestamp: new Date().toISOString(),
            }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

            return reply.status(202).send({
                status: 'PENDING_APPROVAL',
                approvalId,
                message: 'Ação de alto risco detectada. Execução pausada e aguardando aprovação humana.',
                reason: policyCheck.reason,
                traceId,
            });
        }

        if (!policyCheck.allowed) {
            recordRequest('blocked', Date.now() - execStart);
            // DLP-sanitize even the violation payload before signing
            const sanitizedMessage = policyCheck.sanitizedInput || dlpEngine.sanitize(message).sanitizedText;
            const violationPayload = { reason: policyCheck.reason, input: sanitizedMessage, traceId };
            const signature = IntegrityService.signPayload(violationPayload, process.env.SIGNING_SECRET!);

            await auditQueue.add('persist-log', {
                org_id: orgId,
                assistant_id: assistantId,
                action: 'POLICY_VIOLATION' satisfies ActionType,
                metadata: violationPayload,
                signature,
                traceId
            }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

            fastify.log.warn({ orgId, assistantId, reason: policyCheck.reason }, "Policy Violation");
            return reply.status(403).send({ error: policyCheck.reason, traceId });
        }

        // If DLP flagged PII, use the sanitized (masked) version for downstream processing
        const safeMessage = policyCheck.sanitizedInput || message;
        if (policyCheck.action === 'FLAG') {
            fastify.log.info({
                orgId, assistantId,
                dlpDetections: policyCheck.dlpReport?.totalDetections,
                dlpTypes: policyCheck.dlpReport?.types
            }, 'DLP: PII detected and masked before pipeline');
            if (policyCheck.dlpReport) {
                recordDlpDetection(policyCheck.dlpReport.totalDetections);
            }
        }

        // 4. RAG Context Retrieval (token-aware)
        let ragContext = '';
        let ragMeta = { chunksUsed: 0, estimatedTokens: 0, truncated: false };
        try {
            const kbRes = await client.query(
                'SELECT id FROM knowledge_bases WHERE assistant_id = $1 LIMIT 1',
                [assistantId]
            );
            if (kbRes.rows.length > 0) {
                const { searchWithTokenLimit } = await import('./lib/rag');
                const aiModel = process.env.AI_MODEL || 'gemini/gemini-1.5-flash';
                const ragResult = await searchWithTokenLimit(pgPool, kbRes.rows[0].id, message, aiModel, 10);
                ragContext = ragResult.context;
                ragMeta = { chunksUsed: ragResult.chunksUsed, estimatedTokens: ragResult.estimatedTokens, truncated: ragResult.truncated };
                if (ragResult.chunksUsed > 0) {
                    fastify.log.info({
                        assistantId,
                        chunksUsed: ragResult.chunksUsed,
                        chunksAvailable: ragResult.chunksAvailable,
                        estimatedTokens: ragResult.estimatedTokens,
                        tokenBudget: ragResult.tokenBudget,
                        truncated: ragResult.truncated,
                    }, 'RAG context injected (token-aware)');
                }
            }
        } catch (ragError) {
            fastify.log.warn(ragError, 'RAG retrieval failed, proceeding without context');
        }

        // 5. LiteLLM Proxy Call (Real AI Execution)
        const messages: { role: string; content: string }[] = [];

        if (ragContext) {
            messages.push({
                role: 'system',
                content: `Use the following proprietary knowledge base context to answer the user's question. If the context doesn't contain the answer, say you don't have enough information.\n\n---\n${ragContext}\n---`
            });
        }
        messages.push({ role: 'user', content: safeMessage });

        let aiResponse;
        try {
            aiResponse = await axios.post(`${process.env.LITELLM_URL}/chat/completions`, {
                model: process.env.AI_MODEL || "gemini/gemini-1.5-flash",
                messages
            }, {
                headers: { 'Authorization': `Bearer ${process.env.LITELLM_KEY}` },
                timeout: 30000 // 30s timeout (RAG prompts can be longer)
            });
        } catch (error: any) {
            fastify.log.error(error, "Error communicating with LiteLLM");
            return reply.status(502).send({ error: "Falha ao comunicar com o provedor de IA", details: error.message, traceId });
        }

        // 5. DLP: Sanitize the ENTIRE audit payload (input + AI output) before signing
        const rawLogContent = {
            input: safeMessage,
            output: aiResponse.data.choices[0],
            usage: aiResponse.data.usage,
            traceId,
            ...(policyCheck.dlpReport ? { dlp: policyCheck.dlpReport } : {})
        };
        const { sanitized: logContent } = dlpEngine.sanitizeObject(rawLogContent);
        const signature = IntegrityService.signPayload(logContent, process.env.SIGNING_SECRET!);

        // 6. Persist Audit Log (contains ONLY masked data)
        await auditQueue.add('persist-log', {
            org_id: orgId,
            assistant_id: assistantId,
            action: 'EXECUTION_SUCCESS' satisfies ActionType,
            metadata: logContent,
            signature,
            traceId
        }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

        // 7. Fire-and-forget Delegated Observability (Langfuse)
        await telemetryQueue.add('export-metrics', {
            org_id: orgId,
            assistant_id: assistantId,
            traceId: traceId,
            tokens: aiResponse.data.usage,
            cost: aiResponse.data.usage?.total_tokens ? aiResponse.data.usage.total_tokens * 0.000002 : 0, // Mock cost per token logic
            latency_ms: 250 // Mock latency for the time being
        }, { removeOnComplete: true });

        fastify.log.info({ orgId, assistantId, tokens: aiResponse.data.usage?.total_tokens }, "Execution Success");

        recordRequest('success', Date.now() - execStart);

        return reply.status(200).send({
            ...aiResponse.data,
            _govai: { traceId, signature }
        });

    } catch (error) {
        fastify.log.error(error, "Unexpected server error");
        reply.status(500).send({ error: "Erro interno do servidor" });
    } finally {
        client.release();
    }
});

// --- SSO OIDC ROUTES ---
registerOidcRoutes(fastify, pgPool);

// --- ADMIN ROUTES (Plugin) ---
import { adminRoutes } from './routes/admin.routes';
fastify.register(adminRoutes, { pgPool, requireAdminAuth });

// --- SRE OBSERVABILITY: Prometheus Metrics (Pilar 3) ---
import { renderPrometheusMetrics } from './lib/sre-metrics';
fastify.get('/metrics', async (_request, reply) => {
    reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return reply.send(renderPrometheusMetrics());
});

// --- DEVELOPER PORTAL: Sandbox Endpoint (Pilar 2) ---
fastify.post('/v1/sandbox/execute', async (request, reply) => {
    const parseResult = GovernanceRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
        return reply.status(400).send({ error: 'Input inválido', details: parseResult.error.format() });
    }
    // Dry-run: OPA + DLP validation WITHOUT calling LLM
    const policyCheck = await opaEngine.evaluate(
        { message: parseResult.data.message },
        { rules: { pii_filter: true, forbidden_topics: ['hack', 'bypass'] } }
    );
    return reply.send({
        _sandbox: true,
        message: parseResult.data.message,
        policy_result: policyCheck,
        note: 'Sandbox mode — no LLM call was made. Use /v1/execute/:assistantId for production.'
    });
});

// --- DEVELOPER PORTAL: OpenAPI Spec (Pilar 2) ---
fastify.get('/v1/docs/openapi.json', async (_request, reply) => {
    return reply.send({
        openapi: '3.0.3',
        info: {
            title: 'GOVERN.AI Platform API',
            version: '1.0.0',
            description: 'Enterprise AI Governance Gateway — Compliance, Security & Observability'
        },
        servers: [{ url: process.env.APP_BASE_URL || 'http://localhost:3000' }],
        paths: {
            '/v1/execute/{assistantId}': {
                post: {
                    summary: 'Execute an AI assistant with full governance pipeline',
                    security: [{ BearerAuth: [] }],
                    parameters: [{ name: 'assistantId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
                    requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string', maxLength: 10000 } }, required: ['message'] } } } },
                    responses: { '200': { description: 'Execution result with trace ID' }, '401': { description: 'Unauthorized' }, '429': { description: 'Quota exceeded' } }
                }
            },
            '/v1/sandbox/execute': {
                post: {
                    summary: 'Sandbox: test OPA/DLP policies without calling LLM',
                    requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } } } },
                    responses: { '200': { description: 'Policy evaluation result (dry-run)' } }
                }
            },
            '/health': { get: { summary: 'Health check', responses: { '200': { description: 'Service status' } } } },
            '/metrics': { get: { summary: 'Prometheus metrics', responses: { '200': { description: 'Text exposition format' } } } }
        },
        components: { securitySchemes: { BearerAuth: { type: 'http', scheme: 'bearer', description: 'API Key (sk-govai-...)' } } }
    });
});

// --- OFFBOARDING: Tenant Data Export (Pilar 4) ---
import { exportTenantData, exportToCSV, generateDueDiligencePDF } from './lib/offboarding';

fastify.get('/v1/admin/export/tenant', { preHandler: requireAdminAuth }, async (request, reply) => {
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

fastify.get('/v1/admin/export/due-diligence', { preHandler: requireAdminAuth }, async (_request, reply) => {
    const pdfBuffer = await generateDueDiligencePDF();
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', 'attachment; filename="govai-security-due-diligence.pdf"');
    return reply.send(pdfBuffer);
});

// Health check endpoint
fastify.get('/health', async () => {
    try {
        await pgPool.query('SELECT 1');
        return { status: 'ok', db: 'connected' };
    } catch (e) {
        fastify.log.error(e, "Health check failed");
        return { status: 'error', db: 'disconnected' };
    }
});

const start = async () => {
    try {
        const port = parseInt(process.env.PORT || '3000', 10);
        await fastify.listen({ port, host: '0.0.0.0' });
        fastify.log.info(`GovAI Platform listening on port ${port}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
