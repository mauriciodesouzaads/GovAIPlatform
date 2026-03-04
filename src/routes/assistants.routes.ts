import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
import { IntegrityService, ActionType } from '../lib/governance';
import { dlpEngine } from '../lib/dlp-engine';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';


export async function assistantsRoutes(app: FastifyInstance, opts: { pgPool: Pool; requireAdminAuth: any }) {
    const { pgPool, requireAdminAuth } = opts;

    app.get('/v1/admin/assistants', { preHandler: requireAdminAuth }, async (request, reply) => {
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
            await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
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
            app.log.error(error, "Error creating API key");
            reply.status(500).send({ error: "Erro ao criar chave" });
        } finally {
            client.release();
        }
    });

    // Revoke API Key
    app.delete('/v1/admin/api-keys/:keyId', { preHandler: requireAdminAuth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { keyId } = request.params as { keyId: string };
        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
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
            await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
            const res = await client.query("SELECT id, name, version FROM policy_versions ORDER BY created_at DESC");
            return reply.send(res.rows);
        } finally { client.release(); }
    });

    app.get('/v1/admin/mcp_servers', { preHandler: requireAdminAuth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
            const res = await client.query("SELECT id, name, base_url, status FROM mcp_servers WHERE status = 'active' ORDER BY name ASC");
            return reply.send(res.rows);
        } finally { client.release(); }
    });

    // --- ASSISTANT CRUD ---

    // Create Assistant
    app.post('/v1/admin/assistants', { preHandler: requireAdminAuth }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { name } = request.body as { name: string };
        if (!name) return reply.status(400).send({ error: "Campo 'name' obrigatório." });

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);

            // Iniciar Transação SQL (Atômica)
            await client.query('BEGIN');

            // 1. Criar o Assistente
            const res = await client.query(
                "INSERT INTO assistants (org_id, name, status) VALUES ($1, $2, 'published') RETURNING id, name, status, created_at",
                [orgId, name]
            );
            const assistantId = res.rows[0].id;

            // 2. Criar a versão do assistente se política foi fornecida
            const { policy_version_id, mcp_server_id, allowed_tools } = request.body as any;

            if (policy_version_id) {
                const versionRes = await client.query(
                    `INSERT INTO assistant_versions (org_id, assistant_id, policy_version_id, prompt, version, status) 
                 VALUES ($1, $2, $3, 'Você é um assistente da GovAI.', 1, 'published') RETURNING id`,
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

    // --- RAG KNOWLEDGE BASE ---

    // Create Knowledge Base for an assistant
    app.post('/v1/admin/assistants/:assistantId/knowledge', { preHandler: requireAdminAuth }, async (request, reply) => {
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
