import Fastify, { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
import { GovernanceRequestSchema, IntegrityService, ActionType } from './lib/governance';
import { opaEngine } from './lib/opa-governance';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { auditQueue, initAuditWorker } from './workers/audit.worker';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import crypto from 'crypto';
import { dlpEngine } from './lib/dlp-engine';

// Start worker
initAuditWorker();

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

// Register JWT
fastify.register(fastifyJwt, {
    secret: process.env.JWT_SECRET || 'super-secret-govai-key-in-prod'
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
fastify.register(cors, {
    origin: [
        'http://localhost:3001',                   // Admin UI (dev/docker)
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

    try {
        // 1. RLS: Define context for current org
        await client.query(`SELECT set_config('app.current_org_id', \$1, true)`, [orgId]);

        // 2. Fetch Assistant (RLS ensures it belongs to the Org)
        const assistantRes = await client.query('SELECT * FROM assistants WHERE id = \$1 AND status = \$2', [assistantId, 'published']);
        if (assistantRes.rows.length === 0) {
            return reply.status(404).send({ error: 'Assistente não encontrado, não autorizado, ou não está publicado.' });
        }

        const traceId = request.auditContext?.traceId;

        // 3. Active Governance Validation (OPA + Native Rules)
        const policyContext = {
            rules: {
                pii_filter: true,
                forbidden_topics: ['hack', 'bypass']
            }
        };

        const policyCheck = await opaEngine.evaluate({ message }, policyContext);

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

            // Simulated webhook notification
            fastify.log.warn({
                orgId, assistantId, approvalId, reason: policyCheck.reason,
                webhook: 'SIMULATED — notify assistant owner for human review'
            }, 'HITL: Execution paused — awaiting human approval');

            return reply.status(202).send({
                status: 'PENDING_APPROVAL',
                approvalId,
                message: 'Ação de alto risco detectada. Execução pausada e aguardando aprovação humana.',
                reason: policyCheck.reason,
                traceId,
            });
        }

        if (!policyCheck.allowed) {
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

        fastify.log.info({ orgId, assistantId, tokens: aiResponse.data.usage?.total_tokens }, "Execution Success");

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

// --- ADMIN ROUTES ---

// 0. Login
fastify.post('/v1/admin/login', async (request, reply) => {
    const { email, password } = request.body as any;

    // Hardcoded for demo/MVP
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@govai.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin';

    if (email === adminEmail && password === adminPassword) {
        const token = fastify.jwt.sign({
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
fastify.get('/v1/admin/stats', { preHandler: requireAdminAuth }, async (request, reply) => {
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
        fastify.log.error(error, "Error fetching admin stats");
        reply.status(500).send({ error: "Erro ao buscar métricas" });
    } finally {
        client.release();
    }
});

// 2. Audit Logs (Paginated)
fastify.get('/v1/admin/logs', { preHandler: requireAdminAuth }, async (request, reply) => {
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
        fastify.log.error(error, "Error fetching admin logs");
        reply.status(500).send({ error: "Erro ao buscar logs" });
    } finally {
        client.release();
    }
});

// 3. Assistants List
fastify.get('/v1/admin/assistants', { preHandler: requireAdminAuth }, async (request, reply) => {
    const orgId = request.headers['x-org-id'] as string;

    if (!orgId) {
        return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
    }

    const client = await pgPool.connect();
    try {
        await client.query(`SELECT set_config('app.current_org_id', \$1, true)`, [orgId]);

        const res = await client.query('SELECT id, name, status, created_at FROM assistants ORDER BY created_at DESC');
        return reply.send(res.rows);
    } catch (error) {
        fastify.log.error(error, "Error fetching assistants");
        reply.status(500).send({ error: "Erro ao buscar assistentes" });
    } finally {
        client.release();
    }
});

// --- API KEY MANAGEMENT CRUD ---

// List API Keys
fastify.get('/v1/admin/api-keys', { preHandler: requireAdminAuth }, async (request, reply) => {
    const orgId = request.headers['x-org-id'] as string;
    if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

    const client = await pgPool.connect();
    try {
        await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
        const res = await client.query('SELECT id, name, prefix, is_active, created_at, expires_at FROM api_keys ORDER BY created_at DESC');
        return reply.send(res.rows);
    } catch (error) {
        fastify.log.error(error, "Error fetching API keys");
        reply.status(500).send({ error: "Erro ao buscar chaves" });
    } finally {
        client.release();
    }
});

// Create API Key
fastify.post('/v1/admin/api-keys', { preHandler: requireAdminAuth }, async (request, reply) => {
    const orgId = request.headers['x-org-id'] as string;
    if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

    const { name } = request.body as { name: string };
    if (!name) return reply.status(400).send({ error: "Campo 'name' obrigatório." });

    const rawKey = `sk-govai-${uuidv4().replace(/-/g, '').substring(0, 24)}`;
    const prefix = rawKey.substring(0, 12);
    const keyHash = IntegrityService.signPayload({ key: rawKey }, process.env.SIGNING_SECRET!);

    const client = await pgPool.connect();
    try {
        await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
        const res = await client.query(
            'INSERT INTO api_keys (org_id, name, key_hash, prefix) VALUES ($1, $2, $3, $4) RETURNING id, prefix, created_at',
            [orgId, name, keyHash, prefix]
        );
        // Return the full key ONLY at creation (it's never shown again)
        return reply.status(201).send({ ...res.rows[0], key: rawKey, warning: 'Guarde esta chave! Ela não será exibida novamente.' });
    } catch (error) {
        fastify.log.error(error, "Error creating API key");
        reply.status(500).send({ error: "Erro ao criar chave" });
    } finally {
        client.release();
    }
});

// Revoke API Key
fastify.delete('/v1/admin/api-keys/:keyId', { preHandler: requireAdminAuth }, async (request, reply) => {
    const orgId = request.headers['x-org-id'] as string;
    if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

    const { keyId } = request.params as { keyId: string };
    const client = await pgPool.connect();
    try {
        await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
        await client.query('UPDATE api_keys SET is_active = FALSE WHERE id = $1', [keyId]);
        return reply.send({ message: 'Chave revogada com sucesso.' });
    } catch (error) {
        fastify.log.error(error, "Error revoking API key");
        reply.status(500).send({ error: "Erro ao revogar chave" });
    } finally {
        client.release();
    }
});

// --- ASSISTANT CRUD ---

// Create Assistant
fastify.post('/v1/admin/assistants', { preHandler: requireAdminAuth }, async (request, reply) => {
    const orgId = request.headers['x-org-id'] as string;
    if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

    const { name } = request.body as { name: string };
    if (!name) return reply.status(400).send({ error: "Campo 'name' obrigatório." });

    const client = await pgPool.connect();
    try {
        await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
        const res = await client.query(
            "INSERT INTO assistants (org_id, name, status) VALUES ($1, $2, 'draft') RETURNING id, name, status, created_at",
            [orgId, name]
        );
        return reply.status(201).send(res.rows[0]);
    } catch (error) {
        fastify.log.error(error, "Error creating assistant");
        reply.status(500).send({ error: "Erro ao criar assistente" });
    } finally {
        client.release();
    }
});

// --- RAG KNOWLEDGE BASE ---

// Create Knowledge Base for an assistant
fastify.post('/v1/admin/assistants/:assistantId/knowledge', { preHandler: requireAdminAuth }, async (request, reply) => {
    const orgId = request.headers['x-org-id'] as string;
    if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

    const { assistantId } = request.params as { assistantId: string };
    const { name } = request.body as { name: string };

    const client = await pgPool.connect();
    try {
        await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
        const res = await client.query(
            'INSERT INTO knowledge_bases (org_id, assistant_id, name) VALUES ($1, $2, $3) RETURNING id, name, created_at',
            [orgId, assistantId, name || 'Base Padrão']
        );
        return reply.status(201).send(res.rows[0]);
    } catch (error) {
        fastify.log.error(error, "Error creating knowledge base");
        reply.status(500).send({ error: "Erro ao criar base de conhecimento" });
    } finally {
        client.release();
    }
});

// Upload document to Knowledge Base (RAG Ingestion)
fastify.post('/v1/admin/knowledge/:kbId/documents', { preHandler: requireAdminAuth }, async (request, reply) => {
    const orgId = request.headers['x-org-id'] as string;
    if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

    const { kbId } = request.params as { kbId: string };
    const { content, title } = request.body as { content: string; title?: string };

    if (!content) return reply.status(400).send({ error: "Campo 'content' obrigatório." });

    try {
        const { ingestDocument } = await import('./lib/rag');
        const result = await ingestDocument(pgPool, kbId, content, { title: title || 'Untitled', orgId });
        return reply.status(201).send({
            message: `Documento ingerido com sucesso. ${result.chunksStored} chunks vetorizados.`,
            ...result
        });
    } catch (error: any) {
        fastify.log.error(error, "Error ingesting document");
        reply.status(500).send({ error: "Erro ao ingerir documento", details: error.message });
    }
});

// --- HUMAN-IN-THE-LOOP: APPROVAL MANAGEMENT ---

// List Pending Approvals
fastify.get('/v1/admin/approvals', { preHandler: requireAdminAuth }, async (request, reply) => {
    const orgId = request.headers['x-org-id'] as string;
    if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

    const { status = 'pending' } = request.query as { status?: string };
    const client = await pgPool.connect();
    try {
        await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);

        const res = await client.query(
            `SELECT pa.id, pa.assistant_id, a.name as assistant_name, pa.message, pa.policy_reason, 
                    pa.trace_id, pa.status, pa.reviewer_email, pa.review_note, pa.reviewed_at, pa.created_at
             FROM pending_approvals pa
             LEFT JOIN assistants a ON a.id = pa.assistant_id
             WHERE pa.status = $1
             ORDER BY pa.created_at DESC`,
            [status]
        );
        return reply.send(res.rows);
    } catch (error) {
        fastify.log.error(error, "Error fetching approvals");
        reply.status(500).send({ error: "Erro ao buscar aprovações" });
    } finally {
        client.release();
    }
});

// Approve a pending request (executes the AI call)
fastify.post('/v1/admin/approvals/:approvalId/approve', { preHandler: requireAdminAuth }, async (request, reply) => {
    const orgId = request.headers['x-org-id'] as string;
    if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

    const { approvalId } = request.params as { approvalId: string };
    const user = request.user as { email?: string };

    const client = await pgPool.connect();
    try {
        await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);

        // 1. Fetch and validate pending approval
        const approvalRes = await client.query(
            'SELECT * FROM pending_approvals WHERE id = $1 AND status = $2',
            [approvalId, 'pending']
        );
        if (approvalRes.rows.length === 0) {
            return reply.status(404).send({ error: 'Aprovação não encontrada ou já processada.' });
        }

        const approval = approvalRes.rows[0];

        // 2. Mark as approved
        await client.query(
            `UPDATE pending_approvals SET status = 'approved', reviewer_email = $1, reviewed_at = NOW() WHERE id = $2`,
            [user?.email || 'admin', approvalId]
        );

        // 3. Audit log for approval
        const approvalPayload = { approvalId, action: 'approved', reviewer: user?.email, originalMessage: approval.message, traceId: approval.trace_id };
        const approvalSig = IntegrityService.signPayload(approvalPayload, process.env.SIGNING_SECRET!);
        await auditQueue.add('persist-log', {
            org_id: orgId,
            assistant_id: approval.assistant_id,
            action: 'APPROVAL_GRANTED' satisfies ActionType,
            metadata: approvalPayload,
            signature: approvalSig,
            traceId: approval.trace_id
        }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

        // 4. Execute the original AI call (now approved)
        let ragContext = '';
        try {
            const kbRes = await client.query('SELECT id FROM knowledge_bases WHERE assistant_id = $1 LIMIT 1', [approval.assistant_id]);
            if (kbRes.rows.length > 0) {
                const { searchWithTokenLimit } = await import('./lib/rag');
                const aiModel = process.env.AI_MODEL || 'gemini/gemini-1.5-flash';
                const ragResult = await searchWithTokenLimit(pgPool, kbRes.rows[0].id, approval.message, aiModel, 10);
                if (ragResult.chunksUsed > 0) ragContext = ragResult.context;
            }
        } catch { /* RAG optional */ }

        const messages: { role: string; content: string }[] = [];
        if (ragContext) {
            messages.push({ role: 'system', content: `Use the following proprietary knowledge base context to answer the user's question.\n\n---\n${ragContext}\n---` });
        }
        messages.push({ role: 'user', content: approval.message });

        let aiResponse;
        try {
            aiResponse = await axios.post(`${process.env.LITELLM_URL}/chat/completions`, {
                model: process.env.AI_MODEL || 'gemini/gemini-1.5-flash',
                messages
            }, {
                headers: { 'Authorization': `Bearer ${process.env.LITELLM_KEY}` },
                timeout: 30000
            });
        } catch (error: any) {
            return reply.status(502).send({ error: 'Falha ao executar IA após aprovação', details: error.message });
        }

        // 5. Audit log for execution (after approval)
        const { sanitized: logContent } = dlpEngine.sanitizeObject({
            input: approval.message,
            output: aiResponse.data.choices[0],
            usage: aiResponse.data.usage,
            traceId: approval.trace_id,
            approvedBy: user?.email,
            approvalId,
        });
        const execSig = IntegrityService.signPayload(logContent, process.env.SIGNING_SECRET!);
        await auditQueue.add('persist-log', {
            org_id: orgId,
            assistant_id: approval.assistant_id,
            action: 'EXECUTION_SUCCESS' satisfies ActionType,
            metadata: logContent,
            signature: execSig,
            traceId: approval.trace_id
        }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

        fastify.log.info({ orgId, approvalId, reviewer: user?.email }, 'HITL: Execution approved and completed');

        return reply.send({
            status: 'APPROVED_AND_EXECUTED',
            approvalId,
            response: aiResponse.data,
            _govai: { traceId: approval.trace_id, signature: execSig }
        });
    } catch (error) {
        fastify.log.error(error, "Error processing approval");
        reply.status(500).send({ error: "Erro ao processar aprovação" });
    } finally {
        client.release();
    }
});

// Reject a pending request
fastify.post('/v1/admin/approvals/:approvalId/reject', { preHandler: requireAdminAuth }, async (request, reply) => {
    const orgId = request.headers['x-org-id'] as string;
    if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

    const { approvalId } = request.params as { approvalId: string };
    const { note } = request.body as { note?: string };
    const user = request.user as { email?: string };

    const client = await pgPool.connect();
    try {
        await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);

        const approvalRes = await client.query(
            'SELECT * FROM pending_approvals WHERE id = $1 AND status = $2',
            [approvalId, 'pending']
        );
        if (approvalRes.rows.length === 0) {
            return reply.status(404).send({ error: 'Aprovação não encontrada ou já processada.' });
        }

        const approval = approvalRes.rows[0];

        await client.query(
            `UPDATE pending_approvals SET status = 'rejected', reviewer_email = $1, review_note = $2, reviewed_at = NOW() WHERE id = $3`,
            [user?.email || 'admin', note || 'Rejeitado pelo administrador', approvalId]
        );

        const rejectPayload = { approvalId, action: 'rejected', reviewer: user?.email, note, originalMessage: approval.message, traceId: approval.trace_id };
        const rejectSig = IntegrityService.signPayload(rejectPayload, process.env.SIGNING_SECRET!);
        await auditQueue.add('persist-log', {
            org_id: orgId,
            assistant_id: approval.assistant_id,
            action: 'APPROVAL_REJECTED' satisfies ActionType,
            metadata: rejectPayload,
            signature: rejectSig,
            traceId: approval.trace_id
        }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

        fastify.log.info({ orgId, approvalId, reviewer: user?.email }, 'HITL: Execution rejected');

        return reply.send({ status: 'REJECTED', approvalId, message: 'Solicitação rejeitada pelo administrador.' });
    } catch (error) {
        fastify.log.error(error, "Error rejecting approval");
        reply.status(500).send({ error: "Erro ao rejeitar aprovação" });
    } finally {
        client.release();
    }
});

// --- COMPLIANCE REPORTING ---

// Compliance Report (JSON preview or PDF download)
fastify.get('/v1/admin/reports/compliance', { preHandler: requireAdminAuth }, async (request, reply) => {
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
            const pdfDoc = generateComplianceReport(reportData);

            reply.header('Content-Type', 'application/pdf');
            reply.header('Content-Disposition', `attachment; filename="compliance-report-${reportData.period.start}-${reportData.period.end}.pdf"`);
            return reply.send(pdfDoc);
        }

        return reply.send(reportData);
    } catch (error) {
        fastify.log.error(error, "Error generating compliance report");
        reply.status(500).send({ error: "Erro ao gerar relatório de compliance" });
    } finally {
        client.release();
    }
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
