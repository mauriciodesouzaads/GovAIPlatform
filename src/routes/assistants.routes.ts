import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
import { IntegrityService, ActionType } from '../lib/governance';
import { dlpEngine } from '../lib/dlp-engine';
import crypto, { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { redisCache } from '../lib/redis';
import { CreateAssistantSchema, CreateApiKeySchema, zodErrors } from '../lib/schemas';
import { recordEvidence, getEvidenceChain } from '../lib/evidence';
import { calculateRiskScore, RiskInput } from '../lib/risk-scoring';


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
                SELECT a.id, a.name, a.status, a.lifecycle_state, a.description,
                       a.risk_level, a.risk_score, a.data_classification,
                       a.pii_blocker_enabled, a.output_format,
                       a.capability_tags, a.owner_id, a.owner_email,
                       a.created_at, a.updated_at,
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

    // GET /v1/admin/assistants/:id — single assistant with full lifecycle metadata (P3)
    app.get('/v1/admin/assistants/:id', { preHandler: requireTenantRole(['admin', 'sre', 'operator', 'auditor', 'dpo']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(400).send({ error: "Header 'x-org-id' é obrigatório." });

        const { id } = request.params as { id: string };

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(
                `SELECT a.id, a.name, a.status, a.lifecycle_state, a.description,
                        a.risk_level, a.risk_score, a.risk_breakdown, a.risk_computed_at,
                        a.data_classification, a.pii_blocker_enabled, a.output_format,
                        a.capability_tags, a.owner_id, a.owner_email,
                        a.reviewed_at, a.suspended_at, a.archived_at,
                        a.created_at, a.updated_at,
                        a.current_version_id,
                        lv.version_major, lv.version_minor, lv.version_patch, lv.change_type,
                        CONCAT(lv.version_major, '.', lv.version_minor, '.', lv.version_patch) AS version_label
                 FROM assistants a
                 LEFT JOIN LATERAL (
                     SELECT version_major, version_minor, version_patch, change_type
                     FROM assistant_versions
                     WHERE assistant_id = a.id AND org_id = a.org_id
                     ORDER BY created_at DESC LIMIT 1
                 ) lv ON true
                 WHERE a.id = $1 AND a.org_id = $2`,
                [id, orgId]
            );
            if (res.rows.length === 0) return reply.status(404).send({ error: 'Assistente não encontrado.' });
            return reply.send(res.rows[0]);
        } catch (error) {
            app.log.error(error, 'Error fetching assistant');
            return reply.status(500).send({ error: 'Erro ao buscar assistente.' });
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

    // Create new assistant version (Draft) — with semantic versioning
    app.post('/v1/admin/assistants/:assistantId/versions', { preHandler: requireRole(['admin']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { assistantId } = request.params as { assistantId: string };
        const { policy_json: rawPolicyJson, publish, change_type, changelog } = request.body as any;
        // Default policy_json if not provided — minimal valid policy structure
        const policy_json = rawPolicyJson ?? { rules: [], version: '1.0.0', snapshot_at: new Date().toISOString() };

        const shouldPublish = publish === true;
        if (shouldPublish) {
            return reply.status(400).send({
                error: 'Publicação direta não é permitida. Crie a versão em rascunho e use o endpoint formal de homologação.',
            });
        }

        const VALID_CHANGE_TYPES = ['major', 'minor', 'patch'];
        const changeType: string = VALID_CHANGE_TYPES.includes(change_type) ? change_type : 'patch';
        const versionStatus = 'draft';

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            await client.query('BEGIN');

            const astRes = await client.query(
                'SELECT name, risk_level FROM assistants WHERE id = $1 AND org_id = $2',
                [assistantId, orgId]
            );
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

            // Compute semantic version based on previous version
            const prevRes = await client.query(
                `SELECT version_major, version_minor, version_patch
                 FROM assistant_versions
                 WHERE assistant_id = $1 AND org_id = $2
                 ORDER BY created_at DESC LIMIT 1`,
                [assistantId, orgId]
            );

            let major = 1, minor = 0, patch = 0;
            if (prevRes.rows.length > 0) {
                const prev = prevRes.rows[0];
                major = prev.version_major ?? 1;
                minor = prev.version_minor ?? 0;
                patch = prev.version_patch ?? 0;
                if (changeType === 'major') { major++; minor = 0; patch = 0; }
                else if (changeType === 'minor') { minor++; patch = 0; }
                else { patch++; }
            }

            // Log advisory for governance
            if (changeType === 'major') {
                app.log.warn({ assistantId, major, minor, patch },
                    'Major version bump: full multi-track re-approval will be required.');
            } else if (changeType === 'patch' && astRes.rows[0].risk_level === 'low') {
                app.log.info({ assistantId }, 'Patch on low-risk assistant: auto-approval may be configured in future.');
            }

            const newVerRes = await client.query(
                `INSERT INTO assistant_versions
                    (org_id, assistant_id, policy_version_id, prompt, version, status,
                     version_major, version_minor, version_patch, change_type, changelog)
                 VALUES ($1, $2, $3, 'Você é um assistente da GovAI.', $4, $5, $6, $7, $8, $9, $10)
                 RETURNING id`,
                [orgId, assistantId, policyVersionId, nextVersion, versionStatus,
                 major, minor, patch, changeType, changelog ?? null]
            );
            const newVersionId = newVerRes.rows[0].id;

            await client.query('COMMIT');
            return reply.status(201).send({
                id: newVersionId,
                status: versionStatus,
                version: nextVersion,
                version_label: `${major}.${minor}.${patch}`,
                change_type: changeType,
                assistant_id: assistantId,
            });
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
        const { checklist } = request.body as { checklist?: Record<string, boolean> };

        // INT-03: Validate that all checklist items are provided and true
        if (!checklist || Object.keys(checklist).length === 0) {
            return reply.status(422).send({
                error: "Checklist regulatório obrigatório.",
                hint: "Forneça { checklist: { security_review: true, compliance_review: true, privacy_review: true } }",
                required_fields: ['security_review', 'compliance_review', 'privacy_review'],
            });
        }
        const failedItems = Object.entries(checklist).filter(([, v]) => v !== true).map(([k]) => k);
        if (failedItems.length > 0) {
            return reply.status(422).send({
                error: "O checklist regulatório deve estar integralmente aprovado.",
                failed_items: failedItems,
            });
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

    // --- CATALOG FAVORITES (FASE-C1) ---

    // GET /v1/admin/assistants/favorites — list user's favorited assistants
    app.get('/v1/admin/assistants/favorites', { preHandler: requireTenantRole(['admin', 'operator', 'auditor', 'dpo']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const authUser = request.user as { userId?: string };
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
        if (!authUser?.userId) return reply.status(401).send({ error: 'userId obrigatório.' });

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(
                `SELECT a.id, a.name, a.description, a.lifecycle_state, a.risk_level,
                        a.risk_score, a.capability_tags, a.owner_email, a.created_at
                 FROM assistants a
                 JOIN catalog_favorites f ON f.assistant_id = a.id
                 WHERE f.user_id = $1 AND a.org_id = $2
                 ORDER BY f.created_at DESC`,
                [authUser.userId, orgId]
            );
            return reply.send({ total: res.rowCount, assistants: res.rows });
        } catch (error) {
            app.log.error(error, 'Error fetching favorites');
            return reply.status(500).send({ error: 'Erro ao buscar favoritos.' });
        } finally {
            client.release();
        }
    });

    // POST /v1/admin/assistants/:id/favorite — add to favorites
    app.post('/v1/admin/assistants/:id/favorite', { preHandler: requireTenantRole(['admin', 'operator', 'auditor', 'dpo']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const authUser = request.user as { userId?: string };
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
        if (!authUser?.userId) return reply.status(401).send({ error: 'userId obrigatório.' });

        const { id } = request.params as { id: string };
        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            await client.query(
                `INSERT INTO catalog_favorites (org_id, user_id, assistant_id)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, assistant_id) DO NOTHING`,
                [orgId, authUser.userId, id]
            );
            return reply.send({ favorited: true });
        } catch (error) {
            app.log.error(error, 'Error adding favorite');
            return reply.status(500).send({ error: 'Erro ao adicionar favorito.' });
        } finally {
            client.release();
        }
    });

    // DELETE /v1/admin/assistants/:id/favorite — remove from favorites
    app.delete('/v1/admin/assistants/:id/favorite', { preHandler: requireTenantRole(['admin', 'operator', 'auditor', 'dpo']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const authUser = request.user as { userId?: string };
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
        if (!authUser?.userId) return reply.status(401).send({ error: 'userId obrigatório.' });

        const { id } = request.params as { id: string };
        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            await client.query(
                `DELETE FROM catalog_favorites WHERE user_id = $1 AND assistant_id = $2 AND org_id = $3`,
                [authUser.userId, id, orgId]
            );
            return reply.send({ favorited: false });
        } catch (error) {
            app.log.error(error, 'Error removing favorite');
            return reply.status(500).send({ error: 'Erro ao remover favorito.' });
        } finally {
            client.release();
        }
    });

    // --- CATALOG REGISTRY ---

    // D2a — GET /v1/admin/catalog — full catalog listing with lifecycle metadata + is_favorited
    app.get('/v1/admin/catalog', { preHandler: requireTenantRole(['admin', 'operator', 'auditor', 'dpo']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const authUser = request.user as { userId?: string };
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
        const userId = authUser?.userId ?? null;

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

            // Push userId for the is_favorited LEFT JOIN
            params.push(userId);
            const userIdPlaceholder = `$${params.length}`;

            const res = await client.query(
                `SELECT
                    a.id, a.name, a.description, a.lifecycle_state, a.risk_level,
                    a.risk_score, a.risk_breakdown, a.risk_computed_at,
                    a.data_classification, a.pii_blocker_enabled, a.output_format,
                    a.risk_justification, a.capability_tags, a.owner_email,
                    a.reviewed_at, a.suspended_at, a.archived_at, a.created_at, a.updated_at,
                    a.last_used_at, a.use_count,
                    COUNT(DISTINCT av.id)::int AS version_count,
                    MAX(av.created_at) AS last_version_at,
                    lv.version_major, lv.version_minor, lv.version_patch, lv.change_type,
                    CONCAT(lv.version_major, '.', lv.version_minor, '.', lv.version_patch) AS version_label,
                    CASE WHEN fav.id IS NOT NULL THEN true ELSE false END AS is_favorited
                 FROM assistants a
                 LEFT JOIN assistant_versions av ON av.assistant_id = a.id
                 LEFT JOIN LATERAL (
                     SELECT version_major, version_minor, version_patch, change_type
                     FROM assistant_versions
                     WHERE assistant_id = a.id AND org_id = a.org_id
                     ORDER BY created_at DESC LIMIT 1
                 ) lv ON true
                 LEFT JOIN catalog_favorites fav
                    ON fav.assistant_id = a.id AND fav.user_id = ${userIdPlaceholder}
                 WHERE ${conditions.join(' AND ')}
                 GROUP BY a.id, lv.version_major, lv.version_minor, lv.version_patch, lv.change_type, fav.id
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
    // FASE-A2: risk_level is now DERIVED from calculateRiskScore(); manual riskLevel in body is ignored.
    app.put('/v1/admin/assistants/:id/metadata', { preHandler: requireTenantRole(['admin']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { id } = request.params as { id: string };
        const { description, riskLevel, riskJustification, capabilityTags, ownerEmail,
                dataClassification, piiBlockerEnabled, outputFormat, connectors } =
            request.body as {
                description?: string; riskLevel?: string; riskJustification?: string;
                capabilityTags?: string[]; ownerEmail?: string;
                dataClassification?: 'internal' | 'confidential' | 'restricted';
                piiBlockerEnabled?: boolean;
                outputFormat?: 'free_text' | 'structured_json';
                connectors?: Array<{ name: string; type: 'none' | 'read_only' | 'read_write' | 'external' }>;
            };

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

            // Fetch current values to fill in defaults for risk computation
            const currentRes = await client.query(
                `SELECT data_classification, pii_blocker_enabled, output_format, risk_level
                 FROM assistants WHERE id = $1 AND org_id = $2`,
                [id, orgId]
            );
            if (currentRes.rows.length === 0) return reply.status(404).send({ error: 'Assistente não encontrado.' });
            const current = currentRes.rows[0];

            const sets: string[] = [];
            const params: unknown[] = [id, orgId];
            if (description !== undefined) { params.push(description); sets.push(`description = $${params.length}`); }
            // riskLevel from body is intentionally ignored — computed below
            if (riskLevel !== undefined) {
                app.log.warn({ assistantId: id, requestedRiskLevel: riskLevel },
                    'riskLevel in body ignored — risk_level is computed from calculateRiskScore()');
            }
            if (riskJustification !== undefined) { params.push(riskJustification); sets.push(`risk_justification = $${params.length}`); }
            if (capabilityTags !== undefined) { params.push(capabilityTags); sets.push(`capability_tags = $${params.length}`); }
            if (ownerEmail !== undefined) { params.push(ownerEmail); sets.push(`owner_email = $${params.length}`); }
            if (dataClassification !== undefined) { params.push(dataClassification); sets.push(`data_classification = $${params.length}`); }
            if (piiBlockerEnabled !== undefined) { params.push(piiBlockerEnabled); sets.push(`pii_blocker_enabled = $${params.length}`); }
            if (outputFormat !== undefined) { params.push(outputFormat); sets.push(`output_format = $${params.length}`); }

            if (sets.length === 0) return reply.status(400).send({ error: 'Nenhum campo fornecido para atualização.' });

            // Compute new risk score using merged current + request values
            const riskInput: RiskInput = {
                data_classification: (dataClassification ?? current.data_classification ?? 'internal') as RiskInput['data_classification'],
                connectors: connectors ?? [],
                pii_blocker_enabled: piiBlockerEnabled !== undefined ? piiBlockerEnabled : (current.pii_blocker_enabled ?? true),
                output_format: (outputFormat ?? current.output_format ?? 'free_text') as RiskInput['output_format'],
            };
            const riskResult = calculateRiskScore(riskInput);
            params.push(riskResult.total_score); sets.push(`risk_score = $${params.length}`);
            params.push(riskResult.level);        sets.push(`risk_level = $${params.length}`);
            params.push(JSON.stringify(riskResult)); sets.push(`risk_breakdown = $${params.length}`);
            params.push(new Date(riskResult.computed_at)); sets.push(`risk_computed_at = $${params.length}`);

            sets.push(`updated_at = now()`);
            const res = await client.query(
                `UPDATE assistants SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2
                 RETURNING id, name, lifecycle_state, risk_level, risk_score, risk_breakdown,
                           risk_computed_at, data_classification, pii_blocker_enabled, output_format,
                           capability_tags, owner_email, description, updated_at`,
                params
            );
            if (res.rows.length === 0) return reply.status(404).send({ error: 'Assistente não encontrado.' });
            return reply.send(res.rows[0]);
        } catch (error) {
            app.log.error(error, 'Error updating assistant metadata');
            return reply.status(500).send({ error: 'Erro ao atualizar metadados.' });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
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

            // Check existence and current lifecycle state separately (P1: differentiate 404 vs 409)
            const checkRes = await client.query(
                `SELECT id, lifecycle_state FROM assistants WHERE id = $1 AND org_id = $2`,
                [id, orgId]
            );
            if (checkRes.rows.length === 0) {
                return reply.status(404).send({ error: 'Assistente não encontrado.' });
            }
            const currentState = checkRes.rows[0].lifecycle_state ?? 'draft';
            if (currentState !== 'draft') {
                return reply.status(409).send({
                    error: `Assistente está em estado '${currentState}', esperado 'draft'.`,
                    currentState,
                });
            }

            // Apply defaults for NULL governance fields before transitioning to review
            const res = await client.query(
                `UPDATE assistants
                 SET lifecycle_state = 'under_review',
                     data_classification = COALESCE(data_classification, 'internal'),
                     pii_blocker_enabled = COALESCE(pii_blocker_enabled, true),
                     output_format = COALESCE(output_format, 'free_text'),
                     owner_id = COALESCE(owner_id, $3),
                     capability_tags = COALESCE(capability_tags, '{}'),
                     updated_at = now()
                 WHERE id = $1 AND org_id = $2
                 RETURNING id, name, lifecycle_state`,
                [id, orgId, authUser.userId ?? null]
            );

            await recordEvidence(client, {
                orgId, category: 'publication', eventType: 'REVIEW_SUBMITTED',
                actorId: authUser.userId ?? null, actorEmail: authUser.email ?? null,
                resourceType: 'assistant', resourceId: id,
                metadata: { previousState: 'draft', newState: 'under_review' },
            });

            // Create pending review_decisions for all org tracks
            const tracksRes = await client.query(
                `SELECT id FROM review_tracks WHERE org_id = $1 ORDER BY sort_order`,
                [orgId]
            );
            for (const track of tracksRes.rows) {
                await client.query(
                    `INSERT INTO review_decisions (org_id, assistant_id, track_id, decision)
                     VALUES ($1, $2, $3, 'pending')`,
                    [orgId, id, track.id]
                );
            }

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
            // P1: Check existence and lifecycle state separately to return proper 404 vs 409
            const existsRes = await client.query(
                `SELECT id, lifecycle_state FROM assistants WHERE id = $1 AND org_id = $2`,
                [id, orgId]
            );
            if (existsRes.rows.length === 0) {
                return reply.status(404).send({ error: 'Assistente não encontrado.' });
            }
            if (existsRes.rows[0].lifecycle_state !== 'under_review') {
                return reply.status(409).send({
                    error: `Assistente está em estado '${existsRes.rows[0].lifecycle_state}', esperado 'under_review'.`,
                    currentState: existsRes.rows[0].lifecycle_state,
                });
            }

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
                return reply.status(409).send({ error: 'Conflito ao atualizar estado do assistente.' });
            }

            await client.query(
                `INSERT INTO catalog_reviews
                 (org_id, assistant_id, reviewer_id, reviewer_email, previous_state, new_state, decision, comments)
                 VALUES ($1, $2, $3, $4, 'under_review', $5, $6, $7)`,
                [orgId, id, authUser.userId ?? null, authUser.email ?? null, newState, decision, comments ?? null]
            );

            // Backward compat: auto-approve central track when decision is 'approved'
            if (decision === 'approved') {
                const centralRes = await client.query(
                    `SELECT id FROM review_tracks WHERE org_id = $1 AND slug = 'central' LIMIT 1`,
                    [orgId]
                );
                if (centralRes.rows.length > 0) {
                    const centralTrackId = centralRes.rows[0].id;
                    const pendingDecRes = await client.query(
                        `SELECT id FROM review_decisions
                         WHERE assistant_id = $1 AND track_id = $2 AND org_id = $3 AND decision = 'pending'
                         ORDER BY created_at DESC LIMIT 1`,
                        [id, centralTrackId, orgId]
                    );
                    if (pendingDecRes.rows.length > 0) {
                        await client.query(
                            `UPDATE review_decisions
                             SET decision = 'approved', reviewer_id = $1, reviewer_email = $2, decided_at = now()
                             WHERE id = $3`,
                            [authUser.userId ?? null, authUser.email ?? null, pendingDecRes.rows[0].id]
                        );
                    }
                }
            }

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
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── EVIDENCE ENDPOINTS (FASE-A2) ────────────────────────────────────────

    // GET /v1/admin/assistants/:assistantId/evidence
    // Aggregates all governance evidence for one assistant into a single signed package.
    app.get('/v1/admin/assistants/:assistantId/evidence', {
        preHandler: requireRole(['admin', 'auditor', 'dpo', 'operator']),
    }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { assistantId } = request.params as { assistantId: string };
        const signingSecret = process.env.SIGNING_SECRET;
        if (!signingSecret) {
            return reply.status(500).send({ error: 'Configuração de segurança incompleta.' });
        }

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

            // 1. Assistant
            const assistantRes = await client.query(
                `SELECT id, name, description, lifecycle_state, risk_level, risk_score,
                        risk_breakdown, data_classification, pii_blocker_enabled, output_format,
                        owner_email, created_at, updated_at, risk_computed_at
                 FROM assistants WHERE id = $1 AND org_id = $2`,
                [assistantId, orgId]
            );
            if (assistantRes.rows.length === 0) {
                return reply.status(404).send({ error: 'Assistente não encontrado.' });
            }
            const assistant = assistantRes.rows[0];

            // 2. Approval chain from audit_logs
            const approvalRes = await client.query(
                `SELECT action, metadata->>'user_id' AS actor,
                        COALESCE(metadata->>'reason', metadata->>'notes', metadata->>'comments') AS notes,
                        created_at
                 FROM audit_logs_partitioned
                 WHERE metadata->>'assistant_id' = $1
                   AND action IN ('PENDING_APPROVAL','APPROVAL_GRANTED','APPROVAL_REJECTED','EXIT_GOVERNED_PERIMETER')
                 ORDER BY created_at ASC`,
                [assistantId]
            );
            const approvalChain = approvalRes.rows;

            // 3. Current version
            const versionRes = await client.query(
                `SELECT id, version, LEFT(prompt, 100) || '...' AS prompt_preview,
                        encode(sha256(prompt::bytea), 'hex') AS prompt_hash,
                        policy_version_id, tools_jsonb, created_at
                 FROM assistant_versions
                 WHERE assistant_id = $1 AND org_id = $2
                 ORDER BY version DESC LIMIT 1`,
                [assistantId, orgId]
            );
            const currentVersion = versionRes.rows[0] ?? null;

            // 4. Policy snapshot
            let policySnapshot = null;
            if (currentVersion?.policy_version_id) {
                const polRes = await client.query(
                    `SELECT id, name, rules_jsonb, version FROM policy_versions
                     WHERE id = $1 AND org_id = $2`,
                    [currentVersion.policy_version_id, orgId]
                );
                policySnapshot = polRes.rows[0] ?? null;
            }

            // 5. Publication events
            const pubRes = await client.query(
                `SELECT ape.published_at, ape.notes, u.email AS published_by_email
                 FROM assistant_publication_events ape
                 LEFT JOIN users u ON u.id = ape.published_by
                 WHERE ape.assistant_id = $1 AND ape.org_id = $2
                 ORDER BY ape.published_at DESC`,
                [assistantId, orgId]
            );
            const publicationEvents = pubRes.rows;

            // 6. Active exceptions
            const excRes = await client.query(
                `SELECT exception_type, justification, approved_by, expires_at, status, created_at
                 FROM policy_exceptions
                 WHERE assistant_id = $1 AND org_id = $2
                   AND status IN ('pending', 'approved')
                 ORDER BY created_at DESC`,
                [assistantId, orgId]
            );
            const exceptions = excRes.rows;

            // 7. Usage metrics
            const metricsRes = await client.query(
                `SELECT
                    COUNT(*) FILTER (WHERE action = 'EXECUTION_SUCCESS') AS total_executions,
                    COUNT(*) FILTER (WHERE action = 'POLICY_VIOLATION')  AS total_violations,
                    COUNT(*) FILTER (WHERE action = 'QUOTA_EXCEEDED')    AS total_blocked,
                    COUNT(*) FILTER (WHERE action = 'PENDING_APPROVAL')  AS total_hitl,
                    MAX(created_at) AS last_execution_at
                 FROM audit_logs_partitioned
                 WHERE metadata->>'assistant_id' = $1
                   AND action IN ('EXECUTION_SUCCESS','POLICY_VIOLATION','QUOTA_EXCEEDED','PENDING_APPROVAL')`,
                [assistantId]
            );
            const usageMetrics = metricsRes.rows[0] ?? {};

            // 8. Evidence chain
            const evidenceChain = await getEvidenceChain(client, orgId, 'assistant', assistantId);

            // Integrity footer
            const generated_at = new Date().toISOString();
            const evidencePayload = JSON.stringify({
                assistant, approvalChain, currentVersion, policySnapshot,
                publicationEvents, exceptions, usageMetrics, evidenceChain,
            });
            const evidenceHash = createHash('sha256').update(evidencePayload).digest('hex');
            const integritySignature = IntegrityService.signPayload(
                { hash: evidenceHash, generated_at },
                signingSecret
            );

            return reply.send({
                assistant,
                approval_chain: approvalChain,
                current_version: currentVersion,
                policy_snapshot: policySnapshot,
                publication_events: publicationEvents,
                exceptions,
                usage_metrics: usageMetrics,
                evidence_chain: evidenceChain,
                integrity: {
                    evidence_hash: evidenceHash,
                    signature: integritySignature,
                    generated_at,
                },
            });
        } catch (error) {
            app.log.error(error, 'Error building evidence package');
            return reply.status(500).send({ error: 'Erro ao montar pacote de evidências.' });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // GET /v1/admin/assistants/:assistantId/evidence/pdf
    // Generates a compliance evidence PDF using pdfkit.
    app.get('/v1/admin/assistants/:assistantId/evidence/pdf', {
        preHandler: requireRole(['admin', 'auditor', 'dpo']),
    }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { assistantId } = request.params as { assistantId: string };
        const signingSecret = process.env.SIGNING_SECRET;
        if (!signingSecret) {
            return reply.status(500).send({ error: 'Configuração de segurança incompleta.' });
        }

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

            const assistantRes = await client.query(
                `SELECT id, name, description, lifecycle_state, risk_level, risk_score,
                        risk_breakdown, data_classification, pii_blocker_enabled, output_format,
                        owner_email, created_at, updated_at
                 FROM assistants WHERE id = $1 AND org_id = $2`,
                [assistantId, orgId]
            );
            if (assistantRes.rows.length === 0) {
                return reply.status(404).send({ error: 'Assistente não encontrado.' });
            }
            const assistant = assistantRes.rows[0];

            const approvalRes = await client.query(
                `SELECT action, metadata->>'user_id' AS actor,
                        COALESCE(metadata->>'reason', metadata->>'notes', metadata->>'comments') AS notes,
                        created_at
                 FROM audit_logs_partitioned
                 WHERE metadata->>'assistant_id' = $1
                   AND action IN ('PENDING_APPROVAL','APPROVAL_GRANTED','APPROVAL_REJECTED','EXIT_GOVERNED_PERIMETER')
                 ORDER BY created_at ASC`,
                [assistantId]
            );

            const versionRes = await client.query(
                `SELECT id, version, LEFT(prompt, 100) || '...' AS prompt_preview,
                        encode(sha256(prompt::bytea), 'hex') AS prompt_hash,
                        policy_version_id, tools_jsonb, created_at
                 FROM assistant_versions
                 WHERE assistant_id = $1 AND org_id = $2
                 ORDER BY version DESC LIMIT 1`,
                [assistantId, orgId]
            );
            const currentVersion = versionRes.rows[0] ?? null;

            let policySnapshot: any = null;
            if (currentVersion?.policy_version_id) {
                const polRes = await client.query(
                    `SELECT id, name, rules_jsonb, version FROM policy_versions
                     WHERE id = $1 AND org_id = $2`,
                    [currentVersion.policy_version_id, orgId]
                );
                policySnapshot = polRes.rows[0] ?? null;
            }

            const excRes = await client.query(
                `SELECT exception_type, justification, status, expires_at, created_at
                 FROM policy_exceptions
                 WHERE assistant_id = $1 AND org_id = $2 AND status IN ('pending','approved')
                 ORDER BY created_at DESC`,
                [assistantId, orgId]
            );

            const metricsRes = await client.query(
                `SELECT
                    COUNT(*) FILTER (WHERE action = 'EXECUTION_SUCCESS') AS total_executions,
                    COUNT(*) FILTER (WHERE action = 'POLICY_VIOLATION')  AS total_violations,
                    COUNT(*) FILTER (WHERE action = 'QUOTA_EXCEEDED')    AS total_blocked,
                    COUNT(*) FILTER (WHERE action = 'PENDING_APPROVAL')  AS total_hitl
                 FROM audit_logs_partitioned
                 WHERE metadata->>'assistant_id' = $1
                   AND action IN ('EXECUTION_SUCCESS','POLICY_VIOLATION','QUOTA_EXCEEDED','PENDING_APPROVAL')`,
                [assistantId]
            );
            const metrics = metricsRes.rows[0] ?? {};

            const evidenceChain = await getEvidenceChain(client, orgId, 'assistant', assistantId);

            const generated_at = new Date().toISOString();
            const evidencePayload = JSON.stringify({ assistant, currentVersion, metrics });
            const evidenceHash = createHash('sha256').update(evidencePayload).digest('hex');
            const integritySignature = IntegrityService.signPayload(
                { hash: evidenceHash, generated_at },
                signingSecret
            );

            // Build PDF
            const PDFDocument = (await import('pdfkit')).default;

            const COLORS = {
                primary: '#0F172A', secondary: '#475569', accent: '#2563EB',
                success: '#16A34A', danger: '#DC2626', warning: '#D97706',
                lightBg: '#F8FAFC', border: '#E2E8F0', white: '#FFFFFF',
                amber: '#D97706',
            };

            const riskColor = (level: string) => {
                if (level === 'low') return COLORS.success;
                if (level === 'medium') return COLORS.warning;
                if (level === 'high') return COLORS.danger;
                return '#7F1D1D';
            };

            const pdfBuffer = await new Promise<Buffer>((resolve, reject) => {
                const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
                const chunks: Buffer[] = [];
                doc.on('data', (c: Buffer) => chunks.push(c));
                doc.on('end', () => resolve(Buffer.concat(chunks)));
                doc.on('error', reject);

                const generatedDate = new Date().toLocaleString('pt-BR');

                // ── HEADER ────────────────────────────────────────────────────
                doc.rect(0, 0, 595, 90).fill(COLORS.primary);
                doc.fontSize(18).font('Helvetica-Bold').fillColor(COLORS.white)
                    .text('EVIDÊNCIA DE CONFORMIDADE', 50, 20);
                doc.fontSize(11).font('Helvetica').fillColor('#94A3B8')
                    .text(assistant.name, 50, 44);
                doc.fontSize(8).fillColor('#64748B')
                    .text(`Gerado em: ${generatedDate}  |  GovAI Platform`, 50, 64);

                let y = 110;

                const drawSection = (title: string) => {
                    y += 10;
                    if (y > 710) { doc.addPage(); y = 50; }
                    doc.fontSize(11).font('Helvetica-Bold').fillColor(COLORS.primary).text(title, 50, y);
                    doc.moveTo(50, y + 16).lineTo(545, y + 16).strokeColor(COLORS.accent).lineWidth(1.5).stroke();
                    y += 26;
                };

                const drawRow = (label: string, value: string) => {
                    if (y > 720) { doc.addPage(); y = 50; }
                    doc.fontSize(8).font('Helvetica-Bold').fillColor(COLORS.secondary).text(label, 55, y, { width: 150 });
                    doc.fontSize(8).font('Helvetica').fillColor(COLORS.primary).text(value, 215, y, { width: 330 });
                    y += 16;
                };

                // ── SECTION 1: Informações do Assistente ─────────────────────
                drawSection('1. Informações do Assistente');
                drawRow('ID', assistant.id);
                drawRow('Nome', assistant.name);
                drawRow('Estado', assistant.lifecycle_state ?? '—');
                drawRow('Classificação de Dados', assistant.data_classification ?? '—');
                drawRow('PII Blocker', assistant.pii_blocker_enabled ? 'Ativo' : 'Desativado');
                drawRow('Formato de Output', assistant.output_format ?? '—');
                drawRow('Owner', assistant.owner_email ?? '—');
                drawRow('Criado em', new Date(assistant.created_at).toLocaleString('pt-BR'));

                // ── SECTION 2: Risk Score Breakdown ───────────────────────────
                drawSection('2. Score de Risco (Determinístico)');
                const riskScore = assistant.risk_score ?? 0;
                const riskLevel = assistant.risk_level ?? 'low';
                const breakdown = typeof assistant.risk_breakdown === 'object' ? assistant.risk_breakdown : {};

                doc.fontSize(24).font('Helvetica-Bold').fillColor(riskColor(riskLevel))
                    .text(`${riskScore}`, 55, y);
                doc.fontSize(10).font('Helvetica').fillColor(COLORS.secondary)
                    .text(`Nível: ${riskLevel.toUpperCase()}`, 95, y + 8);
                y += 40;

                const breakdownFactors = ['data_classification', 'connector_type', 'extra_connectors', 'pii_blocker', 'output_format'];
                for (const factor of breakdownFactors) {
                    const item = (breakdown as Record<string, any>)[factor];
                    if (item) {
                        if (y > 720) { doc.addPage(); y = 50; }
                        const scoreVal = item.score ?? 0;
                        doc.fontSize(8).font('Helvetica').fillColor(COLORS.secondary)
                            .text(item.explanation ?? factor, 55, y, { width: 430 });
                        doc.fontSize(8).font('Helvetica-Bold')
                            .fillColor(scoreVal > 0 ? COLORS.warning : COLORS.secondary)
                            .text(`+${scoreVal}`, 490, y, { width: 50, align: 'right' });
                        y += 14;
                    }
                }
                y += 6;
                doc.moveTo(55, y).lineTo(545, y).strokeColor(COLORS.border).lineWidth(0.5).stroke();
                y += 8;
                doc.fontSize(9).font('Helvetica-Bold').fillColor(COLORS.primary).text(`Total: ${riskScore}`, 55, y);
                y += 20;

                // ── SECTION 3: Cadeia de Aprovação ────────────────────────────
                drawSection('3. Cadeia de Aprovação');
                const approvals = approvalRes.rows;
                if (approvals.length === 0) {
                    doc.fontSize(8).font('Helvetica').fillColor(COLORS.secondary).text('Nenhum evento de aprovação registrado.', 55, y);
                    y += 16;
                } else {
                    for (const ev of approvals) {
                        if (y > 720) { doc.addPage(); y = 50; }
                        doc.fontSize(8).font('Helvetica-Bold').fillColor(COLORS.primary)
                            .text(ev.action, 55, y, { width: 180 });
                        doc.fontSize(8).font('Helvetica').fillColor(COLORS.secondary)
                            .text(new Date(ev.created_at).toLocaleString('pt-BR'), 245, y, { width: 150 });
                        doc.text(ev.actor ?? '—', 405, y, { width: 140 });
                        y += 14;
                        if (ev.notes) {
                            doc.fontSize(7).font('Helvetica').fillColor(COLORS.secondary)
                                .text(`  → ${ev.notes}`, 65, y, { width: 480 });
                            y += 12;
                        }
                    }
                }

                // ── SECTION 4: Versão Publicada ────────────────────────────────
                drawSection('4. Versão Publicada');
                if (currentVersion) {
                    drawRow('Versão', `v${currentVersion.version}`);
                    drawRow('Prompt Hash (SHA-256)', currentVersion.prompt_hash ?? '—');
                    drawRow('Política vinculada', policySnapshot?.name ?? 'N/A');
                    drawRow('Criada em', new Date(currentVersion.created_at).toLocaleString('pt-BR'));
                } else {
                    doc.fontSize(8).font('Helvetica').fillColor(COLORS.secondary).text('Nenhuma versão publicada.', 55, y);
                    y += 16;
                }

                // ── SECTION 5: Exceções de Política ───────────────────────────
                drawSection('5. Exceções Ativas de Política');
                const exceptions = excRes.rows;
                if (exceptions.length === 0) {
                    doc.fontSize(8).font('Helvetica').fillColor(COLORS.success)
                        .text('✓ Nenhuma exceção ativa — assistente opera sob políticas padrão.', 55, y);
                    y += 16;
                } else {
                    for (const ex of exceptions) {
                        if (y > 720) { doc.addPage(); y = 50; }
                        drawRow('Tipo', ex.exception_type);
                        drawRow('Justificativa', ex.justification);
                        drawRow('Status', ex.status);
                        drawRow('Expira em', new Date(ex.expires_at).toLocaleDateString('pt-BR'));
                        y += 4;
                    }
                }

                // ── SECTION 6: Métricas de Uso ─────────────────────────────────
                drawSection('6. Métricas de Uso');
                drawRow('Execuções bem-sucedidas', String(metrics.total_executions ?? 0));
                drawRow('Violações de política', String(metrics.total_violations ?? 0));
                drawRow('Bloqueados (quota)', String(metrics.total_blocked ?? 0));
                drawRow('Aguardando aprovação HITL', String(metrics.total_hitl ?? 0));

                // ── SECTION 7: Cadeia de Evidências ────────────────────────────
                drawSection('7. Cadeia de Evidências');
                if (evidenceChain.length === 0) {
                    doc.fontSize(8).font('Helvetica').fillColor(COLORS.secondary)
                        .text('Nenhum registro de evidência encontrado.', 55, y);
                    y += 16;
                } else {
                    for (const ev of evidenceChain.slice(0, 20)) {
                        if (y > 720) { doc.addPage(); y = 50; }
                        const evAny = ev as any;
                        doc.fontSize(7.5).font('Helvetica').fillColor(COLORS.primary)
                            .text(`${evAny.event_type ?? evAny.category}`, 55, y, { width: 200 });
                        doc.fontSize(7.5).font('Helvetica').fillColor(COLORS.secondary)
                            .text(new Date(evAny.created_at ?? evAny.createdAt).toLocaleString('pt-BR'), 265, y, { width: 150 });
                        doc.text(evAny.actor_email ?? '—', 425, y, { width: 120 });
                        y += 13;
                    }
                    if (evidenceChain.length > 20) {
                        doc.fontSize(7).fillColor(COLORS.secondary)
                            .text(`... e mais ${evidenceChain.length - 20} registros omitidos`, 55, y);
                        y += 12;
                    }
                }

                // ── INTEGRITY FOOTER ──────────────────────────────────────────
                y += 10;
                if (y > 700) { doc.addPage(); y = 50; }
                doc.rect(50, y, 495, 42).fillAndStroke(COLORS.lightBg, COLORS.border);
                doc.fontSize(7.5).font('Helvetica-Bold').fillColor(COLORS.primary)
                    .text('Integridade Criptográfica', 60, y + 6);
                doc.fontSize(7).font('Helvetica').fillColor(COLORS.secondary)
                    .text(`Hash: ${evidenceHash.substring(0, 32)}...`, 60, y + 18);
                doc.text(`Assinatura HMAC-SHA256: ${integritySignature.substring(0, 24)}...  |  ${generated_at}`, 60, y + 30);
                y += 52;

                // Page numbers
                const pages = doc.bufferedPageRange();
                for (let i = 0; i < pages.count; i++) {
                    doc.switchToPage(i);
                    doc.fontSize(7).font('Helvetica').fillColor(COLORS.secondary)
                        .text(
                            `GovAI Platform — Evidência de Conformidade  |  Página ${i + 1} de ${pages.count}`,
                            50, 780, { width: 495, align: 'center' }
                        );
                }

                doc.end();
            });

            reply.header('Content-Type', 'application/pdf');
            reply.header('Content-Disposition',
                `attachment; filename="evidencia-${assistantId}-${Date.now()}.pdf"`);
            return reply.send(pdfBuffer);
        } catch (error) {
            app.log.error(error, 'Error generating evidence PDF');
            return reply.status(500).send({ error: 'Erro ao gerar PDF de evidências.' });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── REVIEW TRACKS (FASE-B1) ──────────────────────────────────────────────

    // GET /v1/admin/review-tracks — list org's review tracks ordered by sort_order
    app.get('/v1/admin/review-tracks', { preHandler: requireTenantRole(['admin', 'dpo', 'auditor', 'operator']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(
                `SELECT id, name, slug, description, is_required, sla_hours, sort_order, created_at
                 FROM review_tracks
                 WHERE org_id = $1
                 ORDER BY sort_order ASC`,
                [orgId]
            );
            return reply.send({ total: res.rowCount, tracks: res.rows });
        } catch (error) {
            app.log.error(error, 'Error fetching review tracks');
            return reply.status(500).send({ error: 'Erro ao buscar review tracks.' });
        } finally {
            client.release();
        }
    });

    // GET /v1/admin/assistants/:id/review-status — per-track decisions for one assistant
    app.get('/v1/admin/assistants/:id/review-status', { preHandler: requireTenantRole(['admin', 'dpo', 'auditor', 'operator']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { id } = request.params as { id: string };

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

            // Latest decision per track using DISTINCT ON
            const res = await client.query(
                `SELECT latest.id, latest.track_id, rt.name AS track_name, rt.slug AS track_slug,
                        rt.is_required, rt.sla_hours, latest.decision, latest.reviewer_email,
                        latest.notes, latest.decided_at, latest.created_at
                 FROM (
                     SELECT DISTINCT ON (track_id) id, track_id, decision, reviewer_email,
                            notes, decided_at, created_at
                     FROM review_decisions
                     WHERE assistant_id = $1 AND org_id = $2
                     ORDER BY track_id, created_at DESC
                 ) latest
                 JOIN review_tracks rt ON rt.id = latest.track_id
                 WHERE rt.org_id = $2
                 ORDER BY rt.sort_order ASC`,
                [id, orgId]
            );

            const decisions = res.rows;
            const all_required_approved = decisions
                .filter(d => d.is_required)
                .every(d => d.decision === 'approved');
            const any_rejected = decisions.some(d => d.decision === 'rejected');
            const pending_count = decisions.filter(d => d.decision === 'pending').length;

            return reply.send({
                assistant_id: id,
                decisions,
                summary: { all_required_approved, any_rejected, pending_count },
            });
        } catch (error) {
            app.log.error(error, 'Error fetching review status');
            return reply.status(500).send({ error: 'Erro ao buscar status de revisão.' });
        } finally {
            client.release();
        }
    });

    // POST /v1/admin/assistants/:id/review/:trackId — approve or reject a specific track
    app.post('/v1/admin/assistants/:id/review/:trackId', { preHandler: requireTenantRole(['admin', 'dpo']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const authUser = request.user as { userId?: string; email?: string };
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { id, trackId } = request.params as { id: string; trackId: string };
        const { decision, notes } = request.body as { decision: string; notes?: string };

        if (!['approved', 'rejected'].includes(decision)) {
            return reply.status(400).send({ error: "decision deve ser 'approved' ou 'rejected'." });
        }

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            await client.query('BEGIN');

            // Find the latest pending decision for this track
            const pendingRes = await client.query(
                `SELECT id FROM review_decisions
                 WHERE assistant_id = $1 AND track_id = $2 AND org_id = $3 AND decision = 'pending'
                 ORDER BY created_at DESC LIMIT 1`,
                [id, trackId, orgId]
            );
            if (pendingRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return reply.status(404).send({ error: 'Nenhuma decisão pendente encontrada para esta track.' });
            }

            const decisionId = pendingRes.rows[0].id;
            await client.query(
                `UPDATE review_decisions
                 SET decision = $1, reviewer_id = $2, reviewer_email = $3, notes = $4, decided_at = now()
                 WHERE id = $5`,
                [decision, authUser.userId ?? null, authUser.email ?? null, notes ?? null, decisionId]
            );

            // Check auto-transition: latest decision per track
            const statusRes = await client.query(
                `SELECT rt.is_required, latest.decision
                 FROM (
                     SELECT DISTINCT ON (track_id) track_id, decision
                     FROM review_decisions
                     WHERE assistant_id = $1 AND org_id = $2
                     ORDER BY track_id, created_at DESC
                 ) latest
                 JOIN review_tracks rt ON rt.id = latest.track_id
                 WHERE rt.org_id = $2`,
                [id, orgId]
            );

            const allDecisions = statusRes.rows;
            const anyRejected = allDecisions.some(d => d.decision === 'rejected');
            const allRequiredApproved = allDecisions.filter(d => d.is_required).every(d => d.decision === 'approved');

            let newLifecycleState: string | null = null;
            if (anyRejected) {
                const rejectRes = await client.query(
                    `UPDATE assistants SET lifecycle_state = 'draft', updated_at = now()
                     WHERE id = $1 AND org_id = $2 AND lifecycle_state = 'under_review'
                     RETURNING id`,
                    [id, orgId]
                );
                if (rejectRes.rows.length > 0) newLifecycleState = 'draft';
            } else if (allRequiredApproved) {
                const approveRes = await client.query(
                    `UPDATE assistants
                     SET lifecycle_state = 'approved', reviewed_by = $1, reviewed_at = now(), updated_at = now()
                     WHERE id = $2 AND org_id = $3 AND lifecycle_state = 'under_review'
                     RETURNING id`,
                    [authUser.userId ?? null, id, orgId]
                );
                if (approveRes.rows.length > 0) newLifecycleState = 'approved';
            }

            await client.query('COMMIT');

            if (newLifecycleState) {
                await recordEvidence(client, {
                    orgId, category: 'publication',
                    eventType: newLifecycleState === 'approved' ? 'CATALOG_REVIEWED' : 'REVIEW_REJECTED',
                    actorId: authUser.userId ?? null, actorEmail: authUser.email ?? null,
                    resourceType: 'assistant', resourceId: id,
                    metadata: { trackId, decision, newLifecycleState, notes: notes ?? null },
                });
            }

            return reply.send({ success: true, decision_id: decisionId, decision, new_lifecycle_state: newLifecycleState });
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            app.log.error(error, 'Error processing track review decision');
            return reply.status(500).send({ error: 'Erro ao processar decisão de track.' });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

}
