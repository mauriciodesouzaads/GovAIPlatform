/**
 * Skills Routes — FASE 5c
 *
 * CRUD para catalog_skills (skills catalogáveis reutilizáveis).
 * Inspirado em anthropics/skills (estrutura SKILL.md com instructions + resources).
 *
 * Regras:
 *   - is_system = true → criada por seed, não pode ser deletada;
 *     editar permite somente alterar instructions/resources/is_active.
 *   - is_system = false → custom criada via API, permite full edit/delete.
 *   - Todas as queries fazem set_config('app.current_org_id') antes (RLS).
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { promises as fs, createReadStream } from 'fs';
import path from 'path';
import { randomUUID, createHash } from 'crypto';
import AdmZip from 'adm-zip';
import yaml from 'js-yaml';

interface SkillBody {
    name?: string;
    description?: string;
    category?: string;
    instructions?: string;
    resources?: Record<string, unknown>;
    tags?: string[];
    version?: string;
    is_active?: boolean;
    // FASE 14.0/6a₂ — hybrid skills
    skill_type?: 'prompt' | 'anthropic';
    skill_md_content?: string;
}

const SKILLS_STORAGE_BASE = process.env.SKILLS_STORAGE_PATH || '/var/govai/skills-storage';

// Heuristic: file extension → "is text" decision for content_preview population.
const TEXT_EXTS = new Set([
    '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv',
    '.js', '.ts', '.py', '.sh', '.html', '.xml', '.toml', '.ini',
]);

function mimeForExt(ext: string): string {
    const lower = ext.toLowerCase();
    const map: Record<string, string> = {
        '.md': 'text/markdown', '.markdown': 'text/markdown',
        '.txt': 'text/plain',
        '.json': 'application/json',
        '.yaml': 'application/yaml', '.yml': 'application/yaml',
        '.csv': 'text/csv',
        '.js': 'application/javascript',
        '.ts': 'application/typescript',
        '.py': 'text/x-python',
        '.sh': 'application/x-sh',
        '.html': 'text/html',
        '.xml': 'application/xml',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
        '.zip': 'application/zip',
    };
    return map[lower] || 'application/octet-stream';
}

/**
 * Parse YAML frontmatter at the head of a SKILL.md. Returns
 * { frontmatter, body }. If no frontmatter, frontmatter is {} and
 * body is the full input.
 */
function parseFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
    const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
    if (!m) return { frontmatter: {}, body: text };
    let parsed: Record<string, unknown> = {};
    try {
        const loaded = yaml.load(m[1]);
        if (loaded && typeof loaded === 'object') {
            parsed = loaded as Record<string, unknown>;
        }
    } catch { /* invalid yaml — leave fm empty, downstream validation catches */ }
    return { frontmatter: parsed, body: text.slice(m[0].length) };
}

/** Reject paths that try to break out of the skill dir via .. or absolute paths. */
function isSafeRelativePath(rel: string): boolean {
    if (!rel || rel.startsWith('/') || rel.startsWith('\\')) return false;
    if (rel.includes('..')) return false;
    if (rel.includes('\0')) return false;
    return true;
}

export async function skillsRoutes(
    fastify: FastifyInstance,
    opts: { pgPool: Pool; requireRole: (roles: string[]) => any }
) {
    const { pgPool, requireRole } = opts;
    const auth      = requireRole(['admin', 'dpo', 'operator']);
    const authWrite = requireRole(['admin']);

    // ── GET /v1/admin/catalog/skills ──────────────────────────────────────────
    fastify.get('/v1/admin/catalog/skills', { preHandler: auth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const { category, tag } = (request.query ?? {}) as { category?: string; tag?: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const where: string[] = ['org_id = $1'];
            const params: any[] = [orgId];
            if (category) {
                params.push(category);
                where.push(`category = $${params.length}`);
            }
            if (tag) {
                params.push(tag);
                where.push(`$${params.length} = ANY(tags)`);
            }

            const result = await client.query(
                `SELECT id, name, description, category, instructions, resources, tags,
                        version, is_active, is_system, created_by, created_at, updated_at,
                        skill_type, skill_md_content, skill_md_frontmatter,
                        file_count, total_size_bytes
                 FROM catalog_skills
                 WHERE ${where.join(' AND ')}
                 ORDER BY is_system DESC, name ASC`,
                params
            );
            return reply.send(result.rows);
        } finally {
            client.release();
        }
    });

    // ── GET /v1/admin/catalog/skills/:id ──────────────────────────────────────
    fastify.get('/v1/admin/catalog/skills/:id', { preHandler: auth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { id } = request.params as { id: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `SELECT id, name, description, category, instructions, resources, tags,
                        version, is_active, is_system, created_by, created_at, updated_at,
                        skill_type, skill_md_content, skill_md_frontmatter,
                        file_count, total_size_bytes
                 FROM catalog_skills
                 WHERE id = $1 AND org_id = $2`,
                [id, orgId]
            );
            if (result.rows.length === 0) {
                return reply.status(404).send({ error: 'Skill não encontrada.' });
            }
            return reply.send(result.rows[0]);
        } finally {
            client.release();
        }
    });

    // ── POST /v1/admin/catalog/skills ─────────────────────────────────────────
    // FASE 14.0/6a₂.B: aceita skill_type ('prompt' | 'anthropic'). Tipo
    // 'prompt' (default, backwards-compat) exige instructions. Tipo
    // 'anthropic' exige skill_md_content; arquivos auxiliares vêm
    // depois via POST /:id/files OR /import-anthropic em uma operação.
    fastify.post('/v1/admin/catalog/skills', { preHandler: authWrite }, async (request: any, reply) => {
        const { userId, orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const body = (request.body ?? {}) as SkillBody;
        const skillType = body.skill_type ?? 'prompt';

        if (!body.name) {
            return reply.status(400).send({ error: 'name é obrigatório.' });
        }
        if (skillType !== 'prompt' && skillType !== 'anthropic') {
            return reply.status(400).send({ error: `skill_type inválido: ${skillType}` });
        }
        if (skillType === 'prompt' && !body.instructions) {
            return reply.status(400).send({ error: 'skill_type=prompt exige instructions.' });
        }
        if (skillType === 'anthropic' && !body.skill_md_content) {
            return reply.status(400).send({ error: 'skill_type=anthropic exige skill_md_content.' });
        }

        // Para skill_type='anthropic', extrai frontmatter do skill_md
        // automaticamente — também serve como source-of-truth para name/
        // description quando o usuário passou só o markdown bruto.
        let frontmatter: Record<string, unknown> = {};
        let mdBody = '';
        if (skillType === 'anthropic' && body.skill_md_content) {
            const parsed = parseFrontmatter(body.skill_md_content);
            frontmatter = parsed.frontmatter;
            mdBody = parsed.body;
        }

        // instructions é NOT NULL na tabela legacy. Para 'anthropic',
        // populamos com o body do markdown (sem frontmatter) — assim
        // qualquer consumer legacy que leia .instructions ainda recebe
        // texto utilizável.
        const instructions = body.instructions
            ?? (skillType === 'anthropic' ? mdBody : '');

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `INSERT INTO catalog_skills
                    (org_id, name, description, category, instructions, resources, tags, version, is_active, is_system, created_by,
                     skill_type, skill_md_content, skill_md_frontmatter)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10, $11, $12, $13)
                 RETURNING id, name, description, category, instructions, resources, tags,
                           version, is_active, is_system, created_by, created_at, updated_at,
                           skill_type, skill_md_content, skill_md_frontmatter,
                           file_count, total_size_bytes`,
                [
                    orgId,
                    body.name,
                    body.description ?? null,
                    body.category ?? null,
                    instructions,
                    JSON.stringify(body.resources ?? {}),
                    body.tags ?? [],
                    body.version ?? '1.0',
                    body.is_active ?? true,
                    userId ?? null,
                    skillType,
                    body.skill_md_content ?? null,
                    JSON.stringify(frontmatter),
                ]
            );
            return reply.status(201).send(result.rows[0]);
        } catch (err: any) {
            if (err.code === '23505') {
                return reply.status(409).send({ error: 'Já existe uma skill com esse nome.' });
            }
            throw err;
        } finally {
            client.release();
        }
    });

    // ── PUT /v1/admin/catalog/skills/:id ──────────────────────────────────────
    fastify.put('/v1/admin/catalog/skills/:id', { preHandler: authWrite }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { id }  = request.params as { id: string };
        const body    = (request.body ?? {}) as SkillBody;

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            // Verifica se existe e se é system skill
            const existing = await client.query(
                `SELECT id, is_system FROM catalog_skills WHERE id = $1 AND org_id = $2`,
                [id, orgId]
            );
            if (existing.rows.length === 0) {
                return reply.status(404).send({ error: 'Skill não encontrada.' });
            }
            const isSystem = existing.rows[0].is_system as boolean;

            // System skills: somente instructions, resources e is_active editáveis
            const sets: string[] = [];
            const params: any[] = [];

            if (body.instructions !== undefined) {
                params.push(body.instructions);
                sets.push(`instructions = $${params.length}`);
            }
            if (body.resources !== undefined) {
                params.push(JSON.stringify(body.resources));
                sets.push(`resources = $${params.length}`);
            }
            if (body.is_active !== undefined) {
                params.push(body.is_active);
                sets.push(`is_active = $${params.length}`);
            }
            // FASE 14.0/6a₂.B — hybrid fields.
            // skill_md_content writable for both system and custom skills
            // (operators must be able to fix typos in seeded SKILL.md).
            // skill_type changes are restricted to non-system because
            // flipping a fixture's type silently corrupts the catalog.
            if (body.skill_md_content !== undefined) {
                params.push(body.skill_md_content);
                sets.push(`skill_md_content = $${params.length}`);
                // Re-parse frontmatter on every skill_md_content edit.
                const parsed = parseFrontmatter(body.skill_md_content ?? '');
                params.push(JSON.stringify(parsed.frontmatter));
                sets.push(`skill_md_frontmatter = $${params.length}`);
            }

            if (!isSystem) {
                if (body.name !== undefined) {
                    params.push(body.name);
                    sets.push(`name = $${params.length}`);
                }
                if (body.description !== undefined) {
                    params.push(body.description);
                    sets.push(`description = $${params.length}`);
                }
                if (body.category !== undefined) {
                    params.push(body.category);
                    sets.push(`category = $${params.length}`);
                }
                if (body.tags !== undefined) {
                    params.push(body.tags);
                    sets.push(`tags = $${params.length}`);
                }
                if (body.version !== undefined) {
                    params.push(body.version);
                    sets.push(`version = $${params.length}`);
                }
                if (body.skill_type !== undefined) {
                    if (body.skill_type !== 'prompt' && body.skill_type !== 'anthropic') {
                        return reply.status(400).send({ error: `skill_type inválido: ${body.skill_type}` });
                    }
                    params.push(body.skill_type);
                    sets.push(`skill_type = $${params.length}`);
                }
            }

            if (sets.length === 0) {
                return reply.status(400).send({ error: 'Nenhum campo para atualizar.' });
            }

            params.push(id);
            params.push(orgId);
            const result = await client.query(
                `UPDATE catalog_skills
                 SET ${sets.join(', ')}
                 WHERE id = $${params.length - 1} AND org_id = $${params.length}
                 RETURNING id, name, description, category, instructions, resources, tags,
                           version, is_active, is_system, created_by, created_at, updated_at,
                           skill_type, skill_md_content, skill_md_frontmatter,
                           file_count, total_size_bytes`,
                params
            );
            return reply.send(result.rows[0]);
        } finally {
            client.release();
        }
    });

    // ── DELETE /v1/admin/catalog/skills/:id ───────────────────────────────────
    fastify.delete('/v1/admin/catalog/skills/:id', { preHandler: authWrite }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { id } = request.params as { id: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const existing = await client.query(
                `SELECT is_system FROM catalog_skills WHERE id = $1 AND org_id = $2`,
                [id, orgId]
            );
            if (existing.rows.length === 0) {
                return reply.status(404).send({ error: 'Skill não encontrada.' });
            }
            if (existing.rows[0].is_system) {
                return reply.status(403).send({ error: 'Skills do sistema não podem ser deletadas.' });
            }

            await client.query(
                `DELETE FROM catalog_skills WHERE id = $1 AND org_id = $2`,
                [id, orgId]
            );
            return reply.status(204).send();
        } finally {
            client.release();
        }
    });

    // ── GET /v1/admin/catalog/skills/assistants/:assistantId ──────────────────
    // Lista skills vinculadas a um assistente
    fastify.get('/v1/admin/catalog/skills/assistants/:assistantId', { preHandler: auth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { assistantId } = request.params as { assistantId: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `SELECT cs.id, cs.name, cs.description, cs.category, cs.tags,
                        cs.is_system, asb.is_active as binding_active, asb.created_at as bound_at
                 FROM assistant_skill_bindings asb
                 JOIN catalog_skills cs ON cs.id = asb.skill_id
                 WHERE asb.assistant_id = $1 AND asb.org_id = $2
                 ORDER BY cs.name ASC`,
                [assistantId, orgId]
            );
            return reply.send(result.rows);
        } finally {
            client.release();
        }
    });

    // ── POST /v1/admin/catalog/skills/assistants/:assistantId/bindings ────────
    // Vincula uma skill a um assistente
    fastify.post('/v1/admin/catalog/skills/assistants/:assistantId/bindings', { preHandler: authWrite }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { assistantId } = request.params as { assistantId: string };
        const { skillId } = (request.body ?? {}) as { skillId?: string };

        if (!skillId) {
            return reply.status(400).send({ error: 'skillId é obrigatório.' });
        }

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `INSERT INTO assistant_skill_bindings (org_id, assistant_id, skill_id)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (assistant_id, skill_id) DO UPDATE SET is_active = true
                 RETURNING id, assistant_id, skill_id, is_active, created_at`,
                [orgId, assistantId, skillId]
            );
            return reply.status(201).send(result.rows[0]);
        } finally {
            client.release();
        }
    });

    // ── DELETE /v1/admin/catalog/skills/assistants/:assistantId/bindings/:skillId ─
    fastify.delete('/v1/admin/catalog/skills/assistants/:assistantId/bindings/:skillId', { preHandler: authWrite }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { assistantId, skillId } = request.params as { assistantId: string; skillId: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            await client.query(
                `DELETE FROM assistant_skill_bindings
                 WHERE assistant_id = $1 AND skill_id = $2 AND org_id = $3`,
                [assistantId, skillId, orgId]
            );
            return reply.status(204).send();
        } finally {
            client.release();
        }
    });

    // =====================================================================
    // FASE 14.0/6a₂.B — Skills híbridas: import-anthropic + file mgmt
    // =====================================================================

    // ── POST /v1/admin/catalog/skills/import-anthropic ────────────────────────
    //
    // Multipart upload of a .zip containing a SKILL.md (with YAML frontmatter)
    // plus auxiliary files (scripts/, examples/, etc.). Creates a single
    // catalog_skills row of type 'anthropic' + one skill_files row per
    // archived file. Mirrors the layout of anthropics/skills repos so
    // consultants can import existing skill bundles wholesale.
    //
    // Auxiliary files land at:
    //   /var/govai/skills-storage/<org_id>/<skill_id>/<relative_path>
    //
    // The 6a₂.C step will mount this dir read-only into the runner at
    // /mnt/skills/<org_id>/<skill_id>/, but the row + filesystem state
    // produced here is already complete — only the runner-side mount
    // is missing.
    fastify.post('/v1/admin/catalog/skills/import-anthropic', {
        preHandler: authWrite,
    }, async (request: any, reply) => {
        const { userId, orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const data = await request.file();
        if (!data) {
            return reply.status(400).send({ error: 'No file uploaded' });
        }
        const isZip = data.mimetype === 'application/zip'
            || data.mimetype === 'application/x-zip-compressed'
            || (data.filename && data.filename.toLowerCase().endsWith('.zip'));
        if (!isZip) {
            return reply.status(415).send({
                error: 'Expected application/zip',
                got: data.mimetype,
            });
        }

        const buffer = await data.toBuffer();
        let zip: AdmZip;
        try {
            zip = new AdmZip(buffer);
        } catch (err) {
            return reply.status(400).send({
                error: 'Invalid zip archive',
                detail: (err as Error).message,
            });
        }
        const entries = zip.getEntries();

        // Locate SKILL.md — case-insensitive match anywhere in the tree.
        const skillMdEntry = entries.find(e =>
            !e.isDirectory && e.entryName.toLowerCase().endsWith('skill.md')
        );
        if (!skillMdEntry) {
            return reply.status(400).send({ error: 'SKILL.md not found in archive' });
        }

        // Determine root prefix so a "my-skill/SKILL.md + my-skill/scripts/x.py"
        // archive normalizes to relative_path "scripts/x.py" (without the
        // outer dir). If SKILL.md is at the archive root, prefix is ''.
        const rootPrefix = skillMdEntry.entryName.includes('/')
            ? skillMdEntry.entryName.substring(0, skillMdEntry.entryName.lastIndexOf('/') + 1)
            : '';

        const skillMdContent = skillMdEntry.getData().toString('utf-8');
        const { frontmatter, body: mdBody } = parseFrontmatter(skillMdContent);

        const fmName = frontmatter.name as string | undefined;
        const fmDesc = frontmatter.description as string | undefined;
        if (!fmName || !fmDesc) {
            return reply.status(400).send({
                error: 'SKILL.md frontmatter must include name and description',
                got_frontmatter: frontmatter,
            });
        }

        const skillId = randomUUID();
        const skillsRoot = SKILLS_STORAGE_BASE;

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            await client.query(
                `INSERT INTO catalog_skills
                    (id, org_id, name, description, category, instructions, resources, tags, version,
                     is_active, is_system, created_by,
                     skill_type, skill_md_content, skill_md_frontmatter)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, false, $10, 'anthropic', $11, $12)`,
                [
                    skillId,
                    orgId,
                    fmName,
                    fmDesc,
                    (frontmatter.category as string | undefined) ?? 'general',
                    // instructions = body sem frontmatter (legacy fallback)
                    mdBody,
                    JSON.stringify({}),
                    Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
                    (frontmatter.version as string | undefined) ?? '1.0.0',
                    userId ?? null,
                    skillMdContent,
                    JSON.stringify(frontmatter),
                ]
            );

            let fileCount = 0;
            let totalSize = 0;

            for (const entry of entries) {
                if (entry.isDirectory) continue;
                if (entry.entryName === skillMdEntry.entryName) continue;

                const relativePath = rootPrefix && entry.entryName.startsWith(rootPrefix)
                    ? entry.entryName.substring(rootPrefix.length)
                    : entry.entryName;
                if (!isSafeRelativePath(relativePath)) {
                    request.log?.warn?.(
                        { entry: entry.entryName },
                        '[skills] skipping unsafe relative path in zip'
                    );
                    continue;
                }

                const fileBuffer = entry.getData();
                const storagePath = path.join(skillsRoot, orgId, skillId, relativePath);
                await fs.mkdir(path.dirname(storagePath), { recursive: true });
                await fs.writeFile(storagePath, fileBuffer);

                const ext = path.extname(relativePath);
                const mimeType = mimeForExt(ext);
                const isText = TEXT_EXTS.has(ext.toLowerCase());
                const sha256 = createHash('sha256').update(fileBuffer).digest('hex');
                const isExecutable = entry.attr ? ((entry.attr >>> 16) & 0o111) !== 0 : false;
                const contentPreview = isText
                    ? fileBuffer.toString('utf-8').substring(0, 500)
                    : null;

                await client.query(
                    `INSERT INTO skill_files
                        (skill_id, org_id, relative_path, mime_type, size_bytes,
                         sha256, storage_path, is_executable, content_preview)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [skillId, orgId, relativePath, mimeType, fileBuffer.length,
                     sha256, storagePath, isExecutable, contentPreview]
                );

                fileCount++;
                totalSize += fileBuffer.length;
            }

            await client.query(
                `UPDATE catalog_skills SET file_count = $1, total_size_bytes = $2
                  WHERE id = $3 AND org_id = $4`,
                [fileCount, totalSize, skillId, orgId]
            );

            return reply.status(201).send({
                skill_id: skillId,
                skill_type: 'anthropic',
                name: fmName,
                description: fmDesc,
                files_imported: fileCount,
                total_size_bytes: totalSize,
                skill_md_preview: skillMdContent.substring(0, 200),
            });
        } catch (err: any) {
            if (err.code === '23505') {
                return reply.status(409).send({ error: 'Skill com esse nome já existe.' });
            }
            request.log?.error?.({ err }, '[skills] import-anthropic failed');
            throw err;
        } finally {
            client.release();
        }
    });

    // ── POST /v1/admin/catalog/skills/:id/files ───────────────────────────────
    //
    // Single-file multipart upload to an existing 'anthropic' skill. The
    // relative_path comes either as a form field of the same name OR from
    // the original filename. Rejects unsafe paths (..  / absolute / NUL).
    fastify.post('/v1/admin/catalog/skills/:id/files', {
        preHandler: authWrite,
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { id } = request.params as { id: string };

        const data = await request.file();
        if (!data) return reply.status(400).send({ error: 'No file uploaded' });

        const formRel = (data.fields?.relative_path as any)?.value as string | undefined;
        const relativePath = formRel || data.filename;
        if (!relativePath || !isSafeRelativePath(relativePath)) {
            return reply.status(400).send({ error: 'invalid relative_path' });
        }

        const buffer = await data.toBuffer();
        const ext = path.extname(relativePath);
        const mimeType = data.mimetype || mimeForExt(ext);
        const isText = TEXT_EXTS.has(ext.toLowerCase());
        const sha256 = createHash('sha256').update(buffer).digest('hex');
        const contentPreview = isText
            ? buffer.toString('utf-8').substring(0, 500)
            : null;

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const skillRes = await client.query(
                `SELECT skill_type FROM catalog_skills WHERE id = $1 AND org_id = $2`,
                [id, orgId]
            );
            if (skillRes.rows.length === 0) {
                return reply.status(404).send({ error: 'Skill não encontrada.' });
            }
            if (skillRes.rows[0].skill_type !== 'anthropic') {
                return reply.status(400).send({
                    error: 'File uploads only allowed on skill_type=anthropic',
                });
            }

            const storagePath = path.join(SKILLS_STORAGE_BASE, orgId, id, relativePath);
            await fs.mkdir(path.dirname(storagePath), { recursive: true });
            await fs.writeFile(storagePath, buffer);

            const insertRes = await client.query(
                `INSERT INTO skill_files
                    (skill_id, org_id, relative_path, mime_type, size_bytes,
                     sha256, storage_path, content_preview)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (skill_id, relative_path) DO UPDATE SET
                    mime_type = EXCLUDED.mime_type,
                    size_bytes = EXCLUDED.size_bytes,
                    sha256 = EXCLUDED.sha256,
                    storage_path = EXCLUDED.storage_path,
                    content_preview = EXCLUDED.content_preview
                 RETURNING id, relative_path, mime_type, size_bytes, sha256,
                           is_executable, content_preview, created_at`,
                [id, orgId, relativePath, mimeType, buffer.length,
                 sha256, storagePath, contentPreview]
            );

            // Recompute counters from skill_files (cheaper than incrementing
            // because ON CONFLICT replaces rather than adds).
            await client.query(
                `UPDATE catalog_skills SET
                    file_count = (SELECT COUNT(*) FROM skill_files WHERE skill_id = $1),
                    total_size_bytes = COALESCE(
                        (SELECT SUM(size_bytes) FROM skill_files WHERE skill_id = $1),
                        0
                    )
                  WHERE id = $1`,
                [id]
            );

            return reply.status(201).send(insertRes.rows[0]);
        } finally {
            client.release();
        }
    });

    // ── GET /v1/admin/catalog/skills/:id/files ────────────────────────────────
    fastify.get('/v1/admin/catalog/skills/:id/files', {
        preHandler: auth,
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { id } = request.params as { id: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `SELECT id, relative_path, mime_type, size_bytes, sha256,
                        is_executable, content_preview, created_at
                   FROM skill_files
                  WHERE skill_id = $1 AND org_id = $2
                  ORDER BY relative_path ASC`,
                [id, orgId]
            );
            return reply.send(result.rows);
        } finally {
            client.release();
        }
    });

    // ── GET /v1/admin/catalog/skills/:id/files/:fileId ────────────────────────
    fastify.get('/v1/admin/catalog/skills/:id/files/:fileId', {
        preHandler: auth,
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { id, fileId } = request.params as { id: string; fileId: string };

        const client = await pgPool.connect();
        let row: any;
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `SELECT relative_path, mime_type, storage_path
                   FROM skill_files
                  WHERE id = $1 AND skill_id = $2 AND org_id = $3`,
                [fileId, id, orgId]
            );
            if (result.rows.length === 0) {
                return reply.status(404).send({ error: 'File não encontrado.' });
            }
            row = result.rows[0];
        } finally {
            client.release();
        }

        const filename = path.basename(row.relative_path);
        return reply
            .type(row.mime_type || 'application/octet-stream')
            .header('Content-Disposition', `attachment; filename="${filename}"`)
            .send(createReadStream(row.storage_path));
    });

    // ── DELETE /v1/admin/catalog/skills/:id/files/:fileId ─────────────────────
    fastify.delete('/v1/admin/catalog/skills/:id/files/:fileId', {
        preHandler: authWrite,
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { id, fileId } = request.params as { id: string; fileId: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `DELETE FROM skill_files
                  WHERE id = $1 AND skill_id = $2 AND org_id = $3
                  RETURNING storage_path`,
                [fileId, id, orgId]
            );
            if (result.rows.length === 0) {
                return reply.status(404).send({ error: 'File não encontrado.' });
            }

            // Best-effort fs unlink — DB row is the source of truth, an
            // orphan file on disk is recoverable via re-import. Logging
            // the failure for ops visibility.
            try {
                await fs.unlink(result.rows[0].storage_path);
            } catch (err) {
                request.log?.warn?.(
                    { err, path: result.rows[0].storage_path },
                    '[skills] unlink failed (orphan on disk)'
                );
            }

            await client.query(
                `UPDATE catalog_skills SET
                    file_count = (SELECT COUNT(*) FROM skill_files WHERE skill_id = $1),
                    total_size_bytes = COALESCE(
                        (SELECT SUM(size_bytes) FROM skill_files WHERE skill_id = $1),
                        0
                    )
                  WHERE id = $1`,
                [id]
            );

            return reply.status(204).send();
        } finally {
            client.release();
        }
    });
}
