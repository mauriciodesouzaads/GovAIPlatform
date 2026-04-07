import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
import { IntegrityService, ActionType } from '../lib/governance';
import { dlpEngine } from '../lib/dlp-engine';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { redisCache } from '../lib/redis';
import { CreateAssistantSchema, CreateApiKeySchema, zodErrors } from '../lib/schemas';
import { recordEvidence } from '../lib/evidence';


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

            // D3 Guardrail: publicação exige lifecycle_state = 'approved'
            const lifecycleRes = await client.query(
                `SELECT lifecycle_state FROM assistants WHERE id = $1 AND org_id = $2`,
                [assistantId, orgId]
            );
            if (lifecycleRes.rows[0]?.lifecycle_state !== 'approved') {
                return reply.status(400).send({
                    error: 'Publicação só é permitida para assistentes com lifecycle_state = approved. '
                         + 'Use o fluxo de revisão de catálogo antes de publicar.',
                    currentLifecycleState: lifecycleRes.rows[0]?.lifecycle_state ?? null,
                });
            }

            await client.query('BEGIN');

            // Update main assistant pointer + promote to official
            await client.query(
                `UPDATE assistants SET current_version_id = $1, status = 'published', lifecycle_state = 'official' WHERE id = $2 AND org_id = $3`,
                [versionId, assistantId, orgId]
            );

            await client.query(
                `INSERT INTO assistant_publication_events
                     (assistant_id, version_id, org_id, published_by, checklist_jsonb, published_at, notes)
                 VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), $6)`,
                [assistantId, versionId, orgId, authUser.userId, JSON.stringify(checklist), `approved_by:${authUser.email || authUser.userId}`]
            );

            await client.query('COMMIT');
            await redisCache.del(`assistant:${assistantId}:policy`);

            await recordEvidence(client, {
                orgId, category: 'publication', eventType: 'VERSION_PUBLISHED',
                actorId: authUser.userId ?? null, actorEmail: authUser.email ?? null,
                resourceType: 'assistant_version', resourceId: versionId,
                metadata: { assistantId, versionId, publishedBy: authUser.email || authUser.userId, checklist },
            });

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

    // --- CATALOG REGISTRY ---

    // D2a — GET /v1/admin/catalog — full catalog listing with lifecycle metadata
    app.get('/v1/admin/catalog', { preHandler: requireTenantRole(['admin', 'operator', 'auditor', 'dpo']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { lifecycle_state, risk_level, owner_id, search } = request.query as {
            lifecycle_state?: string; risk_level?: string; owner_id?: string; search?: string;
        };

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

            const conditions: string[] = ['a.org_id = $1'];
            const params: unknown[] = [orgId];

            if (lifecycle_state) { params.push(lifecycle_state); conditions.push(`a.lifecycle_state = $${params.length}`); }
            if (risk_level) { params.push(risk_level); conditions.push(`a.risk_level = $${params.length}`); }
            if (owner_id) { params.push(owner_id); conditions.push(`a.owner_id = $${params.length}`); }
            if (search) {
                params.push(`%${search}%`);
                conditions.push(`(a.name ILIKE $${params.length} OR a.description ILIKE $${params.length} OR $${params.length - 1} ILIKE ANY(a.capability_tags))`);
            }

            const res = await client.query(
                `SELECT
                    a.id, a.name, a.description, a.lifecycle_state, a.risk_level,
                    a.risk_justification, a.capability_tags, a.owner_email,
                    a.reviewed_at, a.suspended_at, a.archived_at, a.created_at, a.updated_at,
                    COUNT(DISTINCT av.id)::int AS version_count,
                    MAX(av.created_at) AS last_version_at
                 FROM assistants a
                 LEFT JOIN assistant_versions av ON av.assistant_id = a.id
                 WHERE ${conditions.join(' AND ')}
                 GROUP BY a.id
                 ORDER BY a.created_at DESC
                 LIMIT 50`,
                params
            );
            return reply.send({ total: res.rowCount, assistants: res.rows });
        } catch (error) {
            app.log.error(error, 'Error fetching catalog');
            return reply.status(500).send({ error: 'Erro ao buscar catálogo de assistentes.' });
        } finally {
            client.release();
        }
    });

    // D2b — PUT /v1/admin/assistants/:id/metadata — update catalog metadata (not lifecycle)
    app.put('/v1/admin/assistants/:id/metadata', { preHandler: requireTenantRole(['admin']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { id } = request.params as { id: string };
        const { description, riskLevel, riskJustification, capabilityTags, ownerEmail } =
            request.body as { description?: string; riskLevel?: string; riskJustification?: string; capabilityTags?: string[]; ownerEmail?: string };

        const VALID_RISK = ['low', 'medium', 'high', 'critical'];
        if (riskLevel && !VALID_RISK.includes(riskLevel)) {
            return reply.status(400).send({ error: `riskLevel deve ser um de: ${VALID_RISK.join(', ')}.` });
        }

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

            const sets: string[] = [];
            const params: unknown[] = [id, orgId];
            if (description !== undefined) { params.push(description); sets.push(`description = $${params.length}`); }
            if (riskLevel !== undefined) { params.push(riskLevel); sets.push(`risk_level = $${params.length}`); }
            if (riskJustification !== undefined) { params.push(riskJustification); sets.push(`risk_justification = $${params.length}`); }
            if (capabilityTags !== undefined) { params.push(capabilityTags); sets.push(`capability_tags = $${params.length}`); }
            if (ownerEmail !== undefined) { params.push(ownerEmail); sets.push(`owner_email = $${params.length}`); }

            if (sets.length === 0) return reply.status(400).send({ error: 'Nenhum campo fornecido para atualização.' });

            sets.push(`updated_at = now()`);
            const res = await client.query(
                `UPDATE assistants SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2 RETURNING id, name, lifecycle_state, risk_level, capability_tags, owner_email, description, updated_at`,
                params
            );
            if (res.rows.length === 0) return reply.status(404).send({ error: 'Assistente não encontrado.' });
            return reply.send(res.rows[0]);
        } catch (error) {
            app.log.error(error, 'Error updating assistant metadata');
            return reply.status(500).send({ error: 'Erro ao atualizar metadados.' });
        } finally {
            client.release();
        }
    });

    // D2c — POST /v1/admin/assistants/:id/submit-for-review — draft → under_review
    app.post('/v1/admin/assistants/:id/submit-for-review', { preHandler: requireTenantRole(['admin']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const authUser = request.user as { userId?: string; email?: string };
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { id } = request.params as { id: string };

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

            const res = await client.query(
                `UPDATE assistants
                 SET lifecycle_state = 'under_review', updated_at = now()
                 WHERE id = $1 AND org_id = $2 AND lifecycle_state = 'draft'
                 RETURNING id, name, lifecycle_state`,
                [id, orgId]
            );
            if (res.rows.length === 0) {
                return reply.status(409).send({ error: 'Assistente não encontrado ou não está em estado draft.' });
            }

            await recordEvidence(client, {
                orgId, category: 'publication', eventType: 'REVIEW_SUBMITTED',
                actorId: authUser.userId ?? null, actorEmail: authUser.email ?? null,
                resourceType: 'assistant', resourceId: id,
                metadata: { previousState: 'draft', newState: 'under_review' },
            });

            return reply.send({ success: true, assistant: res.rows[0] });
        } catch (error) {
            app.log.error(error, 'Error submitting for review');
            return reply.status(500).send({ error: 'Erro ao submeter para revisão.' });
        } finally {
            client.release();
        }
    });

    // D2d — POST /v1/admin/assistants/:id/catalog-review — reviewer registers decision
    app.post('/v1/admin/assistants/:id/catalog-review', { preHandler: requireTenantRole(['admin']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const authUser = request.user as { userId?: string; email?: string };
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { id } = request.params as { id: string };
        const { decision, comments } = request.body as { decision: string; comments?: string };

        const VALID_DECISIONS = ['approved', 'rejected', 'needs_changes'];
        if (!decision || !VALID_DECISIONS.includes(decision)) {
            return reply.status(400).send({ error: `decision deve ser um de: ${VALID_DECISIONS.join(', ')}.` });
        }

        const newState = decision === 'approved' ? 'approved' : 'draft';

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            await client.query('BEGIN');

            const res = await client.query(
                `UPDATE assistants
                 SET lifecycle_state = $1, reviewed_by = $2, reviewed_at = now(), updated_at = now()
                 WHERE id = $3 AND org_id = $4 AND lifecycle_state = 'under_review'
                 RETURNING id, name, lifecycle_state`,
                [newState, authUser.userId ?? null, id, orgId]
            );
            if (res.rows.length === 0) {
                await client.query('ROLLBACK');
                return reply.status(409).send({ error: 'Assistente não encontrado ou não está em under_review.' });
            }

            await client.query(
                `INSERT INTO catalog_reviews
                 (org_id, assistant_id, reviewer_id, reviewer_email, previous_state, new_state, decision, comments)
                 VALUES ($1, $2, $3, $4, 'under_review', $5, $6, $7)`,
                [orgId, id, authUser.userId ?? null, authUser.email ?? null, newState, decision, comments ?? null]
            );

            await client.query('COMMIT');

            await recordEvidence(client, {
                orgId, category: 'publication', eventType: 'CATALOG_REVIEWED',
                actorId: authUser.userId ?? null, actorEmail: authUser.email ?? null,
                resourceType: 'assistant', resourceId: id,
                metadata: { decision, newState, comments: comments ?? null },
            });

            return reply.send({ success: true, decision, newLifecycleState: newState, assistant: res.rows[0] });
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            app.log.error(error, 'Error processing catalog review');
            return reply.status(500).send({ error: 'Erro ao processar revisão de catálogo.' });
        } finally {
            client.release();
        }
    });

    // D2e — POST /v1/admin/assistants/:id/suspend — approved|official → suspended
    app.post('/v1/admin/assistants/:id/suspend', { preHandler: requireTenantRole(['admin']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const authUser = request.user as { userId?: string; email?: string };
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { id } = request.params as { id: string };
        const { reason } = request.body as { reason: string };
        if (!reason || reason.trim().length < 5) {
            return reply.status(400).send({ error: "Campo 'reason' obrigatório (mínimo 5 caracteres)." });
        }

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

            const res = await client.query(
                `UPDATE assistants
                 SET lifecycle_state = 'suspended', suspended_at = now(),
                     suspend_reason = $1, updated_at = now()
                 WHERE id = $2 AND org_id = $3
                   AND lifecycle_state IN ('approved', 'official')
                 RETURNING id, name, lifecycle_state, suspended_at`,
                [reason.trim(), id, orgId]
            );
            if (res.rows.length === 0) {
                return reply.status(409).send({ error: 'Assistente não encontrado ou não está em estado approved/official.' });
            }

            await recordEvidence(client, {
                orgId, category: 'publication', eventType: 'CAPABILITY_SUSPENDED',
                actorId: authUser.userId ?? null, actorEmail: authUser.email ?? null,
                resourceType: 'assistant', resourceId: id,
                metadata: { reason: reason.trim() },
            });

            return reply.send({ success: true, assistant: res.rows[0] });
        } catch (error) {
            app.log.error(error, 'Error suspending assistant');
            return reply.status(500).send({ error: 'Erro ao suspender assistente.' });
        } finally {
            client.release();
        }
    });

    // D2f — POST /v1/admin/assistants/:id/archive — suspended|draft → archived
    app.post('/v1/admin/assistants/:id/archive', { preHandler: requireTenantRole(['admin']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const authUser = request.user as { userId?: string; email?: string };
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { id } = request.params as { id: string };
        const { reason } = request.body as { reason: string };
        if (!reason || reason.trim().length < 5) {
            return reply.status(400).send({ error: "Campo 'reason' obrigatório (mínimo 5 caracteres)." });
        }

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

            const res = await client.query(
                `UPDATE assistants
                 SET lifecycle_state = 'archived', archived_at = now(),
                     archive_reason = $1, updated_at = now()
                 WHERE id = $2 AND org_id = $3
                   AND lifecycle_state IN ('suspended', 'draft')
                 RETURNING id, name, lifecycle_state, archived_at`,
                [reason.trim(), id, orgId]
            );
            if (res.rows.length === 0) {
                return reply.status(409).send({ error: 'Assistente não encontrado ou não está em estado suspended/draft.' });
            }

            await recordEvidence(client, {
                orgId, category: 'publication', eventType: 'CAPABILITY_ARCHIVED',
                actorId: authUser.userId ?? null, actorEmail: authUser.email ?? null,
                resourceType: 'assistant', resourceId: id,
                metadata: { reason: reason.trim() },
            });

            return reply.send({ success: true, assistant: res.rows[0] });
        } catch (error) {
            app.log.error(error, 'Error archiving assistant');
            return reply.status(500).send({ error: 'Erro ao arquivar assistente.' });
        } finally {
            client.release();
        }
    });

    // D2g — Runtime bindings CRUD

    // GET /v1/admin/assistants/:id/runtime-bindings
    app.get('/v1/admin/assistants/:id/runtime-bindings', { preHandler: requireTenantRole(['admin', 'operator']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { id } = request.params as { id: string };

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(
                `SELECT id, runtime_type, runtime_config, is_active, created_at
                 FROM capability_runtime_bindings
                 WHERE assistant_id = $1 AND org_id = $2
                 ORDER BY created_at DESC`,
                [id, orgId]
            );
            return reply.send({ total: res.rowCount, bindings: res.rows });
        } catch (error) {
            app.log.error(error, 'Error fetching runtime bindings');
            return reply.status(500).send({ error: 'Erro ao buscar runtime bindings.' });
        } finally {
            client.release();
        }
    });

    // POST /v1/admin/assistants/:id/runtime-bindings
    app.post('/v1/admin/assistants/:id/runtime-bindings', { preHandler: requireTenantRole(['admin']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const authUser = request.user as { userId?: string };
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { id } = request.params as { id: string };
        const { runtimeType, runtimeConfig } = request.body as { runtimeType: string; runtimeConfig?: Record<string, unknown> };

        if (!runtimeType || runtimeType.trim().length === 0) {
            return reply.status(400).send({ error: "Campo 'runtimeType' obrigatório." });
        }

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(
                `INSERT INTO capability_runtime_bindings
                 (org_id, assistant_id, runtime_type, runtime_config, created_by)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (assistant_id, runtime_type)
                 DO UPDATE SET runtime_config = EXCLUDED.runtime_config, is_active = true
                 RETURNING id, runtime_type, runtime_config, is_active, created_at`,
                [orgId, id, runtimeType.trim(), JSON.stringify(runtimeConfig ?? {}), authUser.userId ?? null]
            );
            return reply.status(201).send(res.rows[0]);
        } catch (error) {
            app.log.error(error, 'Error creating runtime binding');
            return reply.status(500).send({ error: 'Erro ao criar runtime binding.' });
        } finally {
            client.release();
        }
    });

    // DELETE /v1/admin/assistants/:id/runtime-bindings/:bindingId
    app.delete('/v1/admin/assistants/:id/runtime-bindings/:bindingId', { preHandler: requireTenantRole(['admin']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { id, bindingId } = request.params as { id: string; bindingId: string };

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(
                `UPDATE capability_runtime_bindings
                 SET is_active = false
                 WHERE id = $1 AND assistant_id = $2 AND org_id = $3
                 RETURNING id, runtime_type, is_active`,
                [bindingId, id, orgId]
            );
            if (res.rows.length === 0) return reply.status(404).send({ error: 'Runtime binding não encontrado.' });
            return reply.send({ success: true, binding: res.rows[0] });
        } catch (error) {
            app.log.error(error, 'Error deactivating runtime binding');
            return reply.status(500).send({ error: 'Erro ao desativar runtime binding.' });
        } finally {
            client.release();
        }
    });

    // --- HUMAN-IN-THE-LOOP: APPROVAL MANAGEMENT ---

    // List Pending Approvals

    // POST /v1/admin/assistants/:assistantId/exit-perimeter
    // Hard clickwrap audit: records the user's voluntary exit from the governed environment.
    // Creates a cryptographic audit log entry (HMAC-SHA256) before redirecting to the external AI tool.
    app.post('/v1/admin/assistants/:assistantId/exit-perimeter', {
        preHandler: requireRole(['admin', 'operator', 'user']),
    }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { assistantId } = request.params as { assistantId: string };
        const body = request.body as {
            target_url?: string;
            acknowledgment?: boolean;
            confirmation_method?: string;
        };

        // Validate acknowledgment — must be true; a false value means user did not accept
        if (body.acknowledgment !== true) {
            return reply.status(400).send({ error: 'Reconhecimento obrigatório: o usuário deve aceitar os termos antes de sair do perímetro governado.' });
        }

        const targetUrl = body.target_url;
        if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.startsWith('http')) {
            return reply.status(400).send({ error: "Campo 'target_url' é obrigatório e deve ser uma URL válida." });
        }

        const signingSecret = process.env.SIGNING_SECRET;
        if (!signingSecret) {
            app.log.error('SIGNING_SECRET não configurado — exit-perimeter audit log não pode ser assinado');
            return reply.status(500).send({ error: 'Configuração de segurança incompleta.' });
        }

        const authUser = request.user as { userId?: string; sub?: string; email?: string };
        const userId = authUser.userId ?? authUser.sub ?? 'unknown';

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

            // Verify assistant exists and belongs to this org
            const assistantCheck = await client.query(
                `SELECT id, name, lifecycle_state FROM assistants WHERE id = $1 AND org_id = $2`,
                [assistantId, orgId]
            );
            if (assistantCheck.rows.length === 0) {
                return reply.status(404).send({ error: 'Assistente não encontrado.' });
            }

            const traceId = crypto.randomUUID();
            const sessionHash = crypto
                .createHash('sha256')
                .update(userId + (request.headers.authorization ?? ''))
                .digest('hex');

            const auditPayload = {
                action: 'EXIT_GOVERNED_PERIMETER',
                trace_id: traceId,
                user_id: userId,
                assistant_id: assistantId,
                assistant_name: assistantCheck.rows[0].name,
                target_url: targetUrl,
                confirmation_method: body.confirmation_method ?? 'checkbox',
                ip_address: request.ip,
                user_agent: request.headers['user-agent'] ?? null,
                timestamp: new Date().toISOString(),
                session_hash: sessionHash,
                org_id: orgId,
            };

            const signature = IntegrityService.signPayload(auditPayload, signingSecret);

            await client.query(
                `INSERT INTO audit_logs_partitioned (id, action, metadata, signature, org_id)
                 VALUES ($1, $2, $3, $4, $5)`,
                [traceId, 'EXIT_GOVERNED_PERIMETER', JSON.stringify(auditPayload), signature, orgId]
            );

            app.log.warn({
                event: 'exit_governed_perimeter',
                trace_id: traceId,
                user_id: userId,
                assistant_id: assistantId,
                target_url: targetUrl,
                ip: request.ip,
            }, 'User exited governed perimeter — clickwrap audit log persisted');

            return reply.send({
                success: true,
                redirect_url: targetUrl,
                trace_id: traceId,
            });
        } catch (error) {
            app.log.error(error, 'Error persisting exit-perimeter audit log');
            return reply.status(500).send({ error: 'Erro ao registrar saída do perímetro.' });
        } finally {
            client.release();
        }
    });

}
