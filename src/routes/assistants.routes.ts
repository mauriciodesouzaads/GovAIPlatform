import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
import { IntegrityService, ActionType } from '../lib/governance';
import { dlpEngine } from '../lib/dlp-engine';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { redisCache } from '../lib/redis';
import { CreateAssistantSchema, CreateApiKeySchema, zodErrors } from '../lib/schemas';


export async function assistantsRoutes(app: FastifyInstance, opts: { pgPool: Pool; requireAdminAuth: any; requireRole: any; requireTenantRole?: any; requirePlatformAdmin?: any }) {
    const { pgPool, requireAdminAuth, requireRole } = opts;
    // GA-001/GA-003: prefer requireTenantRole if provided; fall back to requireRole for compat
    const requireTenantRole = opts.requireTenantRole ?? requireRole;

    app.get('/v1/admin/assistants', { preHandler: requireRole(['admin', 'sre', 'operator']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;

        if (!orgId) {
            return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
        }

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);

            const res = await client.query(`
                SELECT a.id, a.name, a.status, a.created_at, 
                       (
                           SELECT v.id
                           FROM assistant_versions v
                           WHERE v.assistant_id = a.id
                             AND v.status = 'draft'
                             AND NOT EXISTS (
                                 SELECT 1 FROM assistant_publication_events e WHERE e.version_id = v.id
                             )
                           ORDER BY v.created_at DESC
                           LIMIT 1
                       ) as draft_version_id
                FROM assistants a 
                ORDER BY a.created_at DESC
            `);
            return reply.send(res.rows);
        } catch (error) {
            app.log.error(error, "Error fetching assistants");
            reply.status(500).send({ error: "Erro ao buscar assistentes" });
        } finally {
            client.release();
        }
    });

    // --- API KEY MANAGEMENT CRUD ---

    // List API Keys
    // GA-003: only admins may list or create API keys
    app.get('/v1/admin/api-keys', { preHandler: requireTenantRole(['admin']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);
            const res = await client.query('SELECT id, name, prefix, is_active, created_at, expires_at FROM api_keys ORDER BY created_at DESC');
            return reply.send(res.rows);
        } catch (error) {
            app.log.error(error, "Error fetching API keys");
            reply.status(500).send({ error: "Erro ao buscar chaves" });
        } finally {
            client.release();
        }
    });

    // Create API Key — P-12: 20/hr, key :api-keys
    app.post('/v1/admin/api-keys', {
        config: {
            rateLimit: {
                max: 20,
                timeWindow: '1 hour',
                keyGenerator: (request: FastifyRequest) => request.ip + ':api-keys',
                errorResponseBuilder: (_request, context: any) => ({
                    statusCode: 429,
                    error: 'Rate limit exceeded',
                    message: 'Limite de criação de chaves por hora excedido.',
                    retryAfter: Math.ceil(context.ttl / 1000),
                }),
            }
        },
        // GA-003: only admins may create API keys
        preHandler: requireTenantRole(['admin'])
    }, async (request, reply) => {
        const apiKeyParsed = CreateApiKeySchema.safeParse(request.body);
        if (!apiKeyParsed.success) {
            return reply.status(400).send({ error: 'Validation failed', details: zodErrors(apiKeyParsed.error) });
        }
        const { name, expiresAt } = apiKeyParsed.data;

        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const rawKey = `sk-govai-${uuidv4().replace(/-/g, '').substring(0, 24)}`; // gitleaks:allow — key format string, not a credential
        const prefix = rawKey.substring(0, 12);
        const keyHash = IntegrityService.signPayload({ key: rawKey }, process.env.SIGNING_SECRET!);

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);
            const res = await client.query(
                `INSERT INTO api_keys (org_id, name, key_hash, prefix, expires_at)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, prefix, created_at, expires_at`,
                [orgId, name, keyHash, prefix, expiresAt ?? null]
            );
            // Return the full key ONLY at creation (it's never shown again)
            return reply.status(201).send({ ...res.rows[0], key: rawKey, warning: 'Guarde esta chave! Ela não será exibida novamente.' });
        } catch (error) {
            app.log.error(error, "Error creating API key");
            reply.status(500).send({ error: "Erro ao criar chave" });
        } finally {
            client.release();
        }
    });

    // Revoke API Key
    app.delete('/v1/admin/api-keys/:keyId', { preHandler: requireTenantRole(['admin']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { keyId } = request.params as { keyId: string };
        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);
            const res = await client.query(
                `UPDATE api_keys
                 SET is_active = FALSE, revoked_at = NOW(), revoke_reason = COALESCE(revoke_reason, 'revoked_by_tenant_admin')
                 WHERE id = $1
                 RETURNING id, revoked_at, revoke_reason`,
                [keyId]
            );
            if ((res.rowCount ?? 0) === 0) {
                return reply.status(404).send({ error: 'Chave não encontrada para esta organização.' });
            }
            return reply.send({ message: 'Chave revogada com sucesso.', ...res.rows[0] });
        } catch (error) {
            app.log.error(error, "Error revoking API key");
            reply.status(500).send({ error: "Erro ao revogar chave" });
        } finally {
            client.release();
        }
    });

    // --- MCP & POLICIES (UI LOOKUPS) ---
    app.get('/v1/admin/policy_versions', { preHandler: requireAdminAuth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);
            const res = await client.query("SELECT id, name, version FROM policy_versions ORDER BY created_at DESC");
            return reply.send(res.rows);
        } finally { client.release(); }
    });

    app.get('/v1/admin/mcp_servers', { preHandler: requireAdminAuth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);
            const res = await client.query("SELECT id, name, base_url, status FROM mcp_servers WHERE status = 'active' ORDER BY name ASC");
            return reply.send(res.rows);
        } finally { client.release(); }
    });

    // --- ASSISTANT CRUD ---

    // Create Assistant
    app.post('/v1/admin/assistants', { preHandler: requireRole(['admin', 'sre']) }, async (request, reply) => {
        const assistantParsed = CreateAssistantSchema.safeParse(request.body);
        if (!assistantParsed.success) {
            return reply.status(400).send({ error: 'Validation failed', details: zodErrors(assistantParsed.error) });
        }
        const { name } = assistantParsed.data;

        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);

            // Iniciar Transação SQL (Atômica)
            await client.query('BEGIN');

            // 1. Criar o Assistente
            const res = await client.query(
                "INSERT INTO assistants (org_id, name, status) VALUES ($1, $2, 'draft') RETURNING id, name, status, created_at",
                [orgId, name]
            );
            // Finalizar Transação (GA-011: only schema-validated fields used, no request.body as any)
            await client.query('COMMIT');
            return reply.status(201).send(res.rows[0]);
        } catch (error) {
            await client.query('ROLLBACK');
            app.log.error(error, "Error creating assistant (transaction rolled back)");
            reply.status(500).send({ error: "Erro ao publicar assistente. Rollback executado." });
        } finally {
            client.release();
        }
    });

    // Create new assistant version (Draft)
    app.post('/v1/admin/assistants/:assistantId/versions', { preHandler: requireRole(['admin']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { assistantId } = request.params as { assistantId: string };
        const { policy_json, publish } = request.body as any;

        if (!policy_json) return reply.status(400).send({ error: "Campo 'policy_json' obrigatório." });

        const shouldPublish = publish === true;
        if (shouldPublish) {
            return reply.status(400).send({
                error: 'Publicação direta não é permitida. Crie a versão em rascunho e use o endpoint formal de homologação.',
            });
        }
        const versionStatus = 'draft';

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            await client.query('BEGIN');

            const astRes = await client.query('SELECT name FROM assistants WHERE id = $1 AND org_id = $2', [assistantId, orgId]);
            if (astRes.rowCount === 0) {
                await client.query('ROLLBACK');
                return reply.status(404).send({ error: "Assistente não encontrado." });
            }

            const polRes = await client.query(
                `INSERT INTO policy_versions (org_id, name, rules_jsonb, version)
                 VALUES ($1, $2, $3, 1) RETURNING id`,
                [orgId, `Policy Custom - ${astRes.rows[0].name}`, JSON.stringify(policy_json)]
            );
            const policyVersionId = polRes.rows[0].id;

            const verRes = await client.query(
                'SELECT COALESCE(MAX(version), 0) as max_v FROM assistant_versions WHERE assistant_id = $1 AND org_id = $2',
                [assistantId, orgId]
            );
            const nextVersion = verRes.rows[0].max_v + 1;

            const newVerRes = await client.query(
                `INSERT INTO assistant_versions (org_id, assistant_id, policy_version_id, prompt, version, status)
                 VALUES ($1, $2, $3, 'Você é um assistente da GovAI.', $4, $5) RETURNING id`,
                [orgId, assistantId, policyVersionId, nextVersion, versionStatus]
            );
            const newVersionId = newVerRes.rows[0].id;

            await client.query('COMMIT');
            return reply.status(201).send({ id: newVersionId, status: versionStatus, version: nextVersion, assistant_id: assistantId });
        } catch (error) {
            await client.query('ROLLBACK');
            app.log.error(error, "Error creating assistant version");
            reply.status(500).send({ error: "Erro ao criar nova versão do assistente." });
        } finally {
            client.release();
        }
    });

    // --- ASSISTANT HOMOLOGATION ---
    // Fluxo formal de publicação: cria-se versão em rascunho e a homologação
    // publica a versão por meio de evento imutável + atualização do ponteiro do assistente.

    app.post('/v1/admin/assistants/:assistantId/versions/:versionId/approve', { preHandler: requireTenantRole(['admin']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const authUser = request.user as { userId?: string; email?: string };

        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
        if (!authUser?.userId) return reply.status(401).send({ error: 'Sessão inválida para homologação.' });

        const { assistantId, versionId } = request.params as { assistantId: string, versionId: string };
        const { checklist } = request.body as { checklist: Record<string, boolean> };

        // INT-03: Validate that all checklist items are true
        if (!checklist || Object.keys(checklist).length === 0 || Object.values(checklist).some(val => val !== true)) {
            return reply.status(400).send({ error: "O checklist regulatório deve estar integralmente aprovado." });
        }

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

            // GA-009: Verify version exists; immutability trigger prohibits any mutation of assistant_versions
            const verRes = await client.query(
                `SELECT v.id,
                        v.status,
                        EXISTS (
                            SELECT 1 FROM assistant_publication_events e WHERE e.version_id = v.id
                        ) AS already_published
                 FROM assistant_versions v
                 WHERE v.id = $1 AND v.assistant_id = $2 AND v.org_id = $3`,
                [versionId, assistantId, orgId]
            );

            if (verRes.rowCount === 0) {
                return reply.status(404).send({ error: "Versão não encontrada ou não pertence a esta organização." });
            }

            if (verRes.rows[0].status !== 'draft' || verRes.rows[0].already_published === true) {
                return reply.status(409).send({
                    error: 'Somente versões em rascunho ainda não publicadas podem ser homologadas.',
                    versionId,
                    currentStatus: verRes.rows[0].status,
                });
            }

            await client.query('BEGIN');

            // Update main assistant pointer (assistants table only — never assistant_versions)
            await client.query(
                `UPDATE assistants SET current_version_id = $1, status = 'published' WHERE id = $2 AND org_id = $3`,
                [versionId, assistantId, orgId]
            );

            await client.query(
                `INSERT INTO assistant_publication_events
                     (assistant_id, version_id, org_id, published_by, checklist_jsonb, published_at, notes)
                 VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), $6)`,
                [assistantId, versionId, orgId, authUser.userId, JSON.stringify(checklist), `approved_by:${authUser.email || authUser.userId}`]
            );

            await client.query('COMMIT');
            await redisCache.del(`assistant:${assistantId}:rules`);

            return reply.send({ success: true, message: `Versão ${versionId} do assistente ${assistantId} aprovada e publicada.`, approved_by: authUser.email || authUser.userId });
        } catch (error) {
            await client.query('ROLLBACK');
            app.log.error(error, "Error homologating assistant version");
            reply.status(500).send({ error: "Erro ao aprovar versão do assistente." });
        } finally {
            client.release();
        }
    });

    // --- RAG KNOWLEDGE BASE ---

    // Create Knowledge Base for an assistant
    app.post('/v1/admin/assistants/:assistantId/knowledge', { preHandler: requireAdminAuth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { assistantId } = request.params as { assistantId: string };
        const { name } = request.body as { name: string };

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);
            const res = await client.query(
                'INSERT INTO knowledge_bases (org_id, assistant_id, name) VALUES ($1, $2, $3) RETURNING id, name, created_at',
                [orgId, assistantId, name || 'Base Padrão']
            );
            return reply.status(201).send(res.rows[0]);
        } catch (error) {
            app.log.error(error, "Error creating knowledge base");
            reply.status(500).send({ error: "Erro ao criar base de conhecimento" });
        } finally {
            client.release();
        }
    });

    // Upload document to Knowledge Base (RAG Ingestion)
    app.post('/v1/admin/knowledge/:kbId/documents', { preHandler: requireAdminAuth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { kbId } = request.params as { kbId: string };
        const { content, title } = request.body as { content: string; title?: string };

        if (!content) return reply.status(400).send({ error: "Campo 'content' obrigatório." });

        try {
            const client = await pgPool.connect();
            try {
                await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
                const kbRes = await client.query(
                    'SELECT id FROM knowledge_bases WHERE id = $1 AND org_id = $2 LIMIT 1',
                    [kbId, orgId]
                );
                if ((kbRes.rowCount ?? 0) === 0) {
                    return reply.status(404).send({ error: 'Base de conhecimento não encontrada para esta organização.' });
                }
            } finally {
                client.release();
            }
            const { ingestDocument } = await import('../lib/rag');
            const result = await ingestDocument(pgPool, kbId, orgId, content, { title: title || 'Untitled' });
            return reply.status(201).send({
                message: `Documento ingerido com sucesso. ${result.chunksStored} chunks vetorizados.`,
                ...result
            });
        } catch (error: any) {
            app.log.error(error, "Error ingesting document");
            reply.status(500).send({ error: "Erro ao ingerir documento", details: error.message });
        }
    });

    // --- HUMAN-IN-THE-LOOP: APPROVAL MANAGEMENT ---

    // List Pending Approvals

}
