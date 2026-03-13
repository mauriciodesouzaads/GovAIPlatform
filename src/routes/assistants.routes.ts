import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
import { IntegrityService, ActionType } from '../lib/governance';
import { dlpEngine } from '../lib/dlp-engine';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { redisCache } from '../lib/redis';
import { CreateAssistantSchema, CreateApiKeySchema, zodErrors } from '../lib/schemas';


export async function assistantsRoutes(app: FastifyInstance, opts: { pgPool: Pool; requireAdminAuth: any; requireRole: any }) {
    const { pgPool, requireAdminAuth, requireRole } = opts;

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
                       (SELECT v.id FROM assistant_versions v WHERE v.assistant_id = a.id AND v.status = 'draft' ORDER BY v.created_at DESC LIMIT 1) as draft_version_id
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
    app.get('/v1/admin/api-keys', { preHandler: requireAdminAuth }, async (request, reply) => {
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

    // Create API Key
    app.post('/v1/admin/api-keys', { preHandler: requireAdminAuth }, async (request, reply) => {
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
    app.delete('/v1/admin/api-keys/:keyId', { preHandler: requireRole(['admin']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { keyId } = request.params as { keyId: string };
        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);
            await client.query('UPDATE api_keys SET is_active = FALSE WHERE id = $1', [keyId]);
            return reply.send({ message: 'Chave revogada com sucesso.' });
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
            const assistantId = res.rows[0].id;

            // 2. Criar a versão do assistente se política foi fornecida
            const { policy_version_id, mcp_server_id, allowed_tools } = request.body as any;

            if (policy_version_id) {
                const versionRes = await client.query(
                    `INSERT INTO assistant_versions (org_id, assistant_id, policy_version_id, prompt, version, status) 
                 VALUES ($1, $2, $3, 'Você é um assistente da GovAI.', 1, 'draft') RETURNING id`,
                    [orgId, assistantId, policy_version_id]
                );
                const versionId = versionRes.rows[0].id;

                // 3. Se um MCP Server foi selecionado, conceder o Alvará
                if (mcp_server_id && allowed_tools && Array.isArray(allowed_tools) && allowed_tools.length > 0) {
                    await client.query(
                        `INSERT INTO connector_version_grants (org_id, assistant_version_id, mcp_server_id, allowed_tools_jsonb)
                     VALUES ($1, $2, $3, $4)`,
                        [orgId, versionId, mcp_server_id, JSON.stringify(allowed_tools)]
                    );
                }
            }

            // Finalizar Transação
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
        const { policy_json } = request.body as any;

        if (!policy_json) return reply.status(400).send({ error: "Campo 'policy_json' obrigatório." });

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
                 VALUES ($1, $2, $3, 'Você é um assistente da GovAI.', $4, 'draft') RETURNING id`,
                [orgId, assistantId, policyVersionId, nextVersion]
            );

            await client.query('COMMIT');
            return reply.status(201).send({ id: newVerRes.rows[0].id, status: 'draft', version: nextVersion });
        } catch (error) {
            await client.query('ROLLBACK');
            app.log.error(error, "Error creating assistant version");
            reply.status(500).send({ error: "Erro ao criar nova versão do assistente." });
        } finally {
            client.release();
        }
    });

    // --- ASSISTANT HOMOLOGATION ---

    app.post('/v1/admin/assistants/:assistantId/versions/:versionId/approve', { preHandler: requireRole(['admin']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        // The token payload is attached to the request by the Auth Middleware if configured correctly.
        // Assuming `request.user.email` exists or fallback to dummy email. Let's extract the JWT payload to get the publisher identity.
        let email = 'system@govai.com';
        try {
            const authHeader = request.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.split(' ')[1];
                const decoded = app.jwt.decode(token) as any;
                if (decoded && decoded.email) email = decoded.email;
            }
        } catch { } // fallback to system

        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { assistantId, versionId } = request.params as { assistantId: string, versionId: string };
        const { checklist } = request.body as { checklist: Record<string, boolean> };

        // INT-03: Validate that all checklist items are true
        if (!checklist || Object.keys(checklist).length === 0 || Object.values(checklist).some(val => val !== true)) {
            return reply.status(400).send({ error: "O checklist regulatório deve estar integralmente aprovado." });
        }

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, [orgId]);

            await client.query('BEGIN');

            // 1. Mark version as published
            const res = await client.query(
                `UPDATE assistant_versions 
                 SET status = 'published', 
                     published_by = $1, 
                     published_at = NOW(), 
                     checklist_jsonb = $2 
                 WHERE id = $3 AND assistant_id = $4 AND org_id = $5 
                 RETURNING id`,
                [email, JSON.stringify(checklist || {}), versionId, assistantId, orgId]
            );

            if (res.rowCount === 0) {
                await client.query('ROLLBACK');
                return reply.status(404).send({ error: "Versão não encontrada ou não pertence a esta organização." });
            }

            // 2. Archive older versions
            await client.query(
                `UPDATE assistant_versions 
                 SET status = 'archived' 
                 WHERE assistant_id = $1 AND id != $2 AND org_id = $3`,
                [assistantId, versionId, orgId]
            );

            // 3. Update main assistant pointer
            await client.query(
                `UPDATE assistants 
                 SET current_version_id = $1, status = 'published' 
                 WHERE id = $2 AND org_id = $3`,
                [versionId, assistantId, orgId]
            );

            await client.query('COMMIT');
            // Invalidar cache do assistente publicado
            await redisCache.del(`assistant:${assistantId}:rules`);

            return reply.send({ success: true, message: `Versão ${versionId} do assistente ${assistantId} aprovada e publicada.`, approved_by: email });
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
            const { ingestDocument } = await import('../lib/rag');
            const result = await ingestDocument(pgPool, kbId, content, { title: title || 'Untitled', orgId });
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
