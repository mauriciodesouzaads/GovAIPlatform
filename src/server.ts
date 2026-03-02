import Fastify, { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
import { GovernanceRequestSchema, IntegrityService, ActionType } from './lib/governance';
import { opaEngine } from './lib/opa-governance';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { auditQueue, initAuditWorker } from './workers/audit.worker';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';

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

// Admin Auth Hook
export const requireAdminAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        await request.jwtVerify();
    } catch (err) {
        // Fallback for demo ease: allow x-org-id for now while we transition
        if (!request.headers['x-org-id']) {
            return reply.status(401).send({ error: 'Unauthorized: Missing valid JWT token or x-org-id' });
        }
    }
};

// Register CORS
fastify.register(cors, {
    origin: '*', // For demo purposes, allow all origins
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
    // 1. Extract API Key
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({ error: "Unauthorized: Missing or invalid Authorization header (Bearer token required)." });
    }
    const token = authHeader.substring(7);

    // 2. Validate against Database
    const client = await pgPool.connect();
    try {
        // In a real prod environment we'd hash the token (e.g., SHA256) to compare with DB's key_hash.
        // For this demo, we mock the validation using the mock value inserted in init.sql by checking the prefix
        const res = await client.query(
            "SELECT org_id FROM api_keys WHERE prefix = 'sk-go' AND is_active = TRUE LIMIT 1"
        );

        if (res.rowCount === 0) {
            return reply.status(403).send({ error: "Forbidden: Invalid or revoked API Key." });
        }

        // 3. Inject Context
        request.headers['x-org-id'] = res.rows[0].org_id; // Set orgId dynamically for downstream RLS

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

        if (!policyCheck.allowed) {
            const violationPayload = { reason: policyCheck.reason, input: message, traceId };
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

        // 4. RAG Context Retrieval (if assistant has a knowledge base)
        let ragContext = '';
        try {
            const kbRes = await client.query(
                'SELECT id FROM knowledge_bases WHERE assistant_id = $1 LIMIT 1',
                [assistantId]
            );
            if (kbRes.rows.length > 0) {
                const { searchSimilarChunks } = await import('./lib/rag');
                const chunks = await searchSimilarChunks(pgPool, kbRes.rows[0].id, message, 3);
                if (chunks.length > 0) {
                    ragContext = chunks.map(c => c.content).join('\n---\n');
                    fastify.log.info({ assistantId, chunksFound: chunks.length }, 'RAG context injected');
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
        messages.push({ role: 'user', content: message });

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

        // 5. Digital Signature for Audit Log
        const logContent = {
            input: message,
            output: aiResponse.data.choices[0],
            usage: aiResponse.data.usage,
            traceId
        };
        const signature = IntegrityService.signPayload(logContent, process.env.SIGNING_SECRET!);

        // 6. Persist Audit Log
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
fastify.get('/v1/admin/stats', async (request, reply) => {
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
fastify.get('/v1/admin/logs', async (request, reply) => {
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
fastify.get('/v1/admin/assistants', async (request, reply) => {
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
fastify.get('/v1/admin/api-keys', async (request, reply) => {
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
fastify.post('/v1/admin/api-keys', async (request, reply) => {
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
fastify.delete('/v1/admin/api-keys/:keyId', async (request, reply) => {
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
fastify.post('/v1/admin/assistants', async (request, reply) => {
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
fastify.post('/v1/admin/assistants/:assistantId/knowledge', async (request, reply) => {
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
fastify.post('/v1/admin/knowledge/:kbId/documents', async (request, reply) => {
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
