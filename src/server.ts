import Fastify, { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Pool } from 'pg';
import { GovernanceRequestSchema, IntegrityService, ActionType } from './lib/governance';
import { opaEngine } from './lib/opa-governance';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { auditQueue, initAuditWorker } from './workers/audit.worker';

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

const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });

// Tracing Middleware
fastify.addHook('onRequest', async (request, reply) => {
    const traceId = uuidv4();
    request.headers['x-govai-trace-id'] = traceId;
    reply.header('x-govai-trace-id', traceId);
    request.auditContext = { traceId };
});

fastify.post('/v1/execute/:assistantId', async (request, reply) => {
    const { assistantId } = request.params as { assistantId: string };
    const orgId = request.headers['x-org-id'] as string;

    if (!orgId) {
        return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
    }

    const parseResult = GovernanceRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
        return reply.status(400).send({ error: "Input inválido", details: parseResult.error.format() });
    }

    const { message } = parseResult.data;
    const client = await pgPool.connect();

    try {
        // 1. RLS: Define context for current org
        await client.query(`SET LOCAL app.current_org_id = \$1`, [orgId]);

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

        // 4. LiteLLM Proxy Call (Real AI Execution)
        let aiResponse;
        try {
            aiResponse = await axios.post(`${process.env.LITELLM_URL}/chat/completions`, {
                model: "gpt-4", // Or other configured model
                messages: [{ role: "user", content: message }]
            }, {
                headers: { 'Authorization': `Bearer ${process.env.LITELLM_KEY}` },
                timeout: 10000 // 10s timeout
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
