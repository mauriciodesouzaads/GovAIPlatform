/**
 * MCP Server Configs Admin Routes — FASE 14.0/3b · Feature 1
 * ---------------------------------------------------------------------------
 * Per-org registry of MCP (Model Context Protocol) servers that the
 * Claude Code runner can mount on a per-work-item basis. Stored in
 * `mcp_server_configs` (migration 091).
 *
 * Routes:
 *   GET    /v1/admin/mcp-servers           — list (config.env masked)
 *   POST   /v1/admin/mcp-servers           — create
 *   PATCH  /v1/admin/mcp-servers/:id       — partial update
 *   DELETE /v1/admin/mcp-servers/:id       — remove
 *
 * Security:
 *   - org_isolation_mcp RLS policy enforces tenant scoping at the DB.
 *   - The `config` JSONB may contain credentials in `env` / `headers`.
 *     The list serializer masks any values longer than 8 chars to '***'
 *     so a UI can render the registry without leaking secrets.
 *   - The full config (unmasked) is read internally by the gRPC adapter
 *     when dispatching a work_item that references this entry — that
 *     read path bypasses the route layer entirely.
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';

// Whitelist transports the runner knows how to mount. Mirrors
// MCPServerConfig.transport in openclaude.proto.
const TRANSPORTS = ['stdio', 'sse', 'http'] as const;

const createBodySchema = z.object({
    name: z.string().min(1).max(64).regex(
        /^[a-zA-Z0-9_-]+$/,
        'name must be alphanumeric / underscore / dash only'
    ),
    transport: z.enum(TRANSPORTS),
    config: z.union([
        // stdio
        z.object({
            command: z.string().min(1).max(256),
            args: z.array(z.string().max(512)).max(64).default([]),
            env: z.record(z.string(), z.string().max(2048)).default({}),
        }),
        // sse / http
        z.object({
            url: z.string().url().max(512),
            headers: z.record(z.string(), z.string().max(2048)).default({}),
        }),
    ]),
    enabled: z.boolean().default(true),
});

const patchBodySchema = createBodySchema.partial();

function maskSecrets(config: any): any {
    // Shallow copy + mask anything that looks like a secret. We don't
    // try to be clever here — any value > 8 chars in env/headers is
    // assumed to be sensitive (api tokens are usually 30+ chars).
    if (!config || typeof config !== 'object') return config;
    const out: any = { ...config };
    for (const k of ['env', 'headers']) {
        if (out[k] && typeof out[k] === 'object') {
            const masked: Record<string, string> = {};
            for (const [name, raw] of Object.entries(out[k])) {
                masked[name] = typeof raw === 'string' && raw.length > 8
                    ? '***'
                    : (raw as string);
            }
            out[k] = masked;
        }
    }
    return out;
}

export async function mcpServersRoutes(
    app: FastifyInstance,
    opts: { pgPool: Pool; requireRole: (roles: string[]) => any }
) {
    const { pgPool, requireRole } = opts;
    const readAuth  = requireRole(['admin', 'operator', 'dpo', 'auditor']);
    const writeAuth = requireRole(['admin', 'dpo']);

    // ── GET /v1/admin/mcp-servers ──────────────────────────────────────────
    app.get('/v1/admin/mcp-servers', { preHandler: readAuth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const res = await client.query(
                `SELECT id, name, transport, config, enabled, created_at, updated_at
                   FROM mcp_server_configs
                  WHERE org_id = $1
                  ORDER BY name ASC`,
                [orgId]
            );
            return reply.send(res.rows.map(r => ({
                id: r.id,
                name: r.name,
                transport: r.transport,
                config: maskSecrets(r.config),
                enabled: r.enabled,
                created_at: r.created_at,
                updated_at: r.updated_at,
            })));
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── POST /v1/admin/mcp-servers ─────────────────────────────────────────
    app.post('/v1/admin/mcp-servers', { preHandler: writeAuth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const parse = createBodySchema.safeParse(request.body);
        if (!parse.success) {
            return reply.status(400).send({ error: 'invalid body', details: parse.error.format() });
        }
        const { name, transport, config, enabled } = parse.data;

        // Cross-validate transport vs config shape.
        if (transport === 'stdio' && !('command' in config)) {
            return reply.status(400).send({ error: 'stdio transport requires { command, args, env }' });
        }
        if ((transport === 'sse' || transport === 'http') && !('url' in config)) {
            return reply.status(400).send({ error: `${transport} transport requires { url, headers }` });
        }

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const res = await client.query(
                `INSERT INTO mcp_server_configs (org_id, name, transport, config, enabled)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, name, transport, config, enabled, created_at, updated_at`,
                [orgId, name, transport, JSON.stringify(config), enabled]
            );
            const row = res.rows[0];
            return reply.status(201).send({
                id: row.id,
                name: row.name,
                transport: row.transport,
                config: maskSecrets(row.config),
                enabled: row.enabled,
                created_at: row.created_at,
                updated_at: row.updated_at,
            });
        } catch (err: any) {
            if (err.code === '23505') {  // unique_violation
                return reply.status(409).send({ error: `MCP server "${name}" already exists for this org` });
            }
            throw err;
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── PATCH /v1/admin/mcp-servers/:id ────────────────────────────────────
    app.patch('/v1/admin/mcp-servers/:id', { preHandler: writeAuth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { id } = request.params as { id: string };
        const parse = patchBodySchema.safeParse(request.body);
        if (!parse.success) {
            return reply.status(400).send({ error: 'invalid body', details: parse.error.format() });
        }

        const fields: string[] = [];
        const values: any[] = [];
        let i = 1;
        for (const k of ['name', 'transport', 'enabled'] as const) {
            if (parse.data[k] !== undefined) {
                fields.push(`${k} = $${i++}`);
                values.push(parse.data[k]);
            }
        }
        if (parse.data.config !== undefined) {
            fields.push(`config = $${i++}`);
            values.push(JSON.stringify(parse.data.config));
        }
        if (fields.length === 0) {
            return reply.status(400).send({ error: 'no fields to update' });
        }
        fields.push('updated_at = NOW()');
        values.push(id);
        values.push(orgId);

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const res = await client.query(
                `UPDATE mcp_server_configs
                    SET ${fields.join(', ')}
                  WHERE id = $${i++}::uuid AND org_id = $${i}::uuid
                  RETURNING id, name, transport, config, enabled, created_at, updated_at`,
                values
            );
            if (res.rows.length === 0) {
                return reply.status(404).send({ error: 'MCP server config not found' });
            }
            const row = res.rows[0];
            return reply.send({
                id: row.id,
                name: row.name,
                transport: row.transport,
                config: maskSecrets(row.config),
                enabled: row.enabled,
                created_at: row.created_at,
                updated_at: row.updated_at,
            });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── DELETE /v1/admin/mcp-servers/:id ───────────────────────────────────
    app.delete('/v1/admin/mcp-servers/:id', { preHandler: writeAuth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { id } = request.params as { id: string };
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const res = await client.query(
                `DELETE FROM mcp_server_configs WHERE id = $1 AND org_id = $2`,
                [id, orgId]
            );
            if (res.rowCount === 0) {
                return reply.status(404).send({ error: 'MCP server config not found' });
            }
            return reply.status(204).send();
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
}

/**
 * Internal loader used by the gRPC adapter at dispatch time.
 *
 * Returns full unmasked configs for the IDs listed in
 * `runtime_work_items.mcp_server_ids`. Filters by org_id + enabled=true
 * so a disabled or cross-tenant id silently drops out. Caller is
 * responsible for setting `app.current_org_id` if RLS enforcement is
 * desired; this helper opens its own pool client and sets the GUC.
 */
export interface LoadedMcpConfig {
    id: string;
    name: string;
    transport: 'stdio' | 'sse' | 'http';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
}

export async function loadMcpConfigsByIds(
    pool: Pool,
    orgId: string,
    ids: string[],
): Promise<LoadedMcpConfig[]> {
    if (!ids || ids.length === 0) return [];
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        const res = await client.query(
            `SELECT id, name, transport, config
               FROM mcp_server_configs
              WHERE org_id = $1 AND id = ANY($2::uuid[]) AND enabled = true`,
            [orgId, ids]
        );
        return res.rows.map(r => {
            const c = (r.config ?? {}) as any;
            return {
                id: r.id,
                name: r.name,
                transport: r.transport,
                command: c.command,
                args: c.args,
                env: c.env,
                url: c.url,
                headers: c.headers,
            };
        });
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}
