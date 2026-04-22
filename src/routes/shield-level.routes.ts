/**
 * Shield Level management routes — FASE 13.5a
 * ---------------------------------------------------------------------------
 * Exposes the three endpoints that move an organization between shield
 * levels:
 *
 *   GET  /v1/admin/shield-level                        — current + history
 *   GET  /v1/admin/shield-level/notice?from=1&to=3     — markdown preview
 *                                                        + SHA-256 hash
 *   POST /v1/admin/shield-level/change                 — apply the change
 *                                                        (requires matching
 *                                                        template_hash +
 *                                                        acknowledgment)
 *
 * A change writes an immutable `evidence_records` row in the
 * `shield_level_change` category. The row captures:
 *   - from / to levels
 *   - locale of the presented notice
 *   - SHA-256 of the template the user acknowledged
 *   - free-form acknowledgment text
 *
 * Signing uses the same SHA-256 integrity_hash mechanism as the rest
 * of the evidence domain (see src/lib/evidence.ts). If ICP-Brasil
 * signing is desired, a follow-up can flip `signWithIcp: 'optional'`
 * in the recordEvidence call.
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { isShieldLevel, type ShieldLevel } from '../lib/shield-level';
import { recordEvidence } from '../lib/evidence';

const NOTICE_DIR = join(process.cwd(), 'docs', 'legal', 'shield_notices');
const VALID_LOCALES = new Set(['pt-BR', 'en']);

function resolveLocale(raw: string | undefined): 'pt-BR' | 'en' {
    return raw && VALID_LOCALES.has(raw) ? (raw as 'pt-BR' | 'en') : 'pt-BR';
}

async function loadNotice(fromLvl: ShieldLevel, toLvl: ShieldLevel, locale: 'pt-BR' | 'en') {
    const path = join(NOTICE_DIR, locale, `level_${fromLvl}_to_${toLvl}.md`);
    const content = await readFile(path, 'utf8');
    const hash = createHash('sha256').update(content).digest('hex');
    return { content, hash, path };
}

export async function shieldLevelRoutes(
    app: FastifyInstance,
    opts: { pgPool: Pool; requireRole: any },
) {
    const { pgPool, requireRole } = opts;
    const ADMIN_ONLY = requireRole(['admin', 'dpo']);
    const READ_AUTH = requireRole(['admin', 'dpo', 'auditor', 'compliance']);

    // ── GET /v1/admin/shield-level/notice ──────────────────────────────────
    app.get('/v1/admin/shield-level/notice', { preHandler: READ_AUTH }, async (request, reply) => {
        const { from, to, locale } = request.query as {
            from?: string;
            to?: string;
            locale?: string;
        };
        const fromN = Number(from);
        const toN = Number(to);
        const loc = resolveLocale(locale);

        if (!isShieldLevel(fromN) || !isShieldLevel(toN) || fromN === toN) {
            return reply.status(400).send({
                error: 'from and to must be distinct values in {1,2,3}',
            });
        }

        try {
            const { content, hash } = await loadNotice(fromN, toN, loc);
            return reply.send({
                template_content: content,
                template_hash: hash,
                from_level: fromN,
                to_level: toN,
                locale: loc,
            });
        } catch {
            return reply.status(404).send({ error: 'Notice template not found' });
        }
    });

    // ── POST /v1/admin/shield-level/change ─────────────────────────────────
    app.post('/v1/admin/shield-level/change', { preHandler: ADMIN_ONLY }, async (request, reply) => {
        const orgId = (request.headers['x-org-id'] as string) || (request.user as any)?.orgId;
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });

        const actor = request.user as { userId?: string; email?: string } | undefined;
        if (!actor?.userId) {
            return reply.status(401).send({ error: 'Actor user_id ausente no token' });
        }

        const body = request.body as Partial<{
            new_level: number;
            template_hash: string;
            acknowledgment: string;
            locale: string;
        }> | undefined;

        if (!body || !isShieldLevel(body.new_level)) {
            return reply.status(400).send({ error: 'new_level must be 1, 2, or 3' });
        }
        if (!body.template_hash || typeof body.template_hash !== 'string') {
            return reply.status(400).send({ error: 'template_hash (string) is required' });
        }
        if (!body.acknowledgment || typeof body.acknowledgment !== 'string') {
            return reply.status(400).send({ error: 'acknowledgment (string) is required' });
        }

        const loc = resolveLocale(body.locale);
        const newLevel = body.new_level as ShieldLevel;

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            await client.query('BEGIN');

            const cur = await client.query(
                'SELECT shield_level FROM organizations WHERE id = $1 FOR UPDATE',
                [orgId],
            );
            if (cur.rowCount === 0) {
                await client.query('ROLLBACK');
                return reply.status(404).send({ error: 'Organization not found' });
            }
            const currentLevel = cur.rows[0].shield_level as ShieldLevel;

            if (currentLevel === newLevel) {
                await client.query('ROLLBACK');
                return reply.status(400).send({
                    error: 'Organization is already at this level',
                    current_level: currentLevel,
                });
            }

            // Re-load the same notice file and confirm the hash the UI sent
            // matches. Prevents the user from silently "accepting" outdated
            // text if the template was edited between notice fetch and
            // change submission.
            let expectedHash: string;
            try {
                const loaded = await loadNotice(currentLevel, newLevel, loc);
                expectedHash = loaded.hash;
            } catch {
                await client.query('ROLLBACK');
                return reply.status(404).send({
                    error: `Notice template not found for ${currentLevel}→${newLevel} (${loc})`,
                });
            }

            if (expectedHash !== body.template_hash) {
                await client.query('ROLLBACK');
                return reply.status(409).send({
                    error: 'Template hash mismatch — please reload the notice and try again',
                    expected_hash: expectedHash,
                });
            }

            // Apply the change — the column is guarded by a CHECK constraint
            // and the assistants trigger enforces upward-only overrides.
            await client.query(
                `UPDATE organizations
                    SET shield_level = $1,
                        shield_level_updated_at = NOW(),
                        shield_level_updated_by = $2
                  WHERE id = $3`,
                [newLevel, actor.userId, orgId],
            );

            // Evidence. The integrity_hash is what recordEvidence already
            // computes from (orgId | category | event_type | metadata);
            // the template_hash lives inside metadata so it's part of that
            // signature.
            const evidence = await recordEvidence(client, {
                orgId,
                category: 'shield_level_change',
                eventType: 'SHIELD_LEVEL_CHANGED',
                actorId: actor.userId,
                actorEmail: actor.email ?? null,
                resourceType: 'organization',
                resourceId: orgId,
                metadata: {
                    from_level: currentLevel,
                    to_level: newLevel,
                    template_hash: expectedHash,
                    template_locale: loc,
                    acknowledgment: body.acknowledgment,
                    changed_at: new Date().toISOString(),
                },
            });

            await client.query('COMMIT');

            return reply.send({
                success: true,
                from_level: currentLevel,
                to_level: newLevel,
                evidence_record_id: evidence?.id ?? null,
                changed_at: new Date().toISOString(),
            });
        } catch (err: any) {
            await client.query('ROLLBACK').catch(() => { /* ignore */ });
            app.log.error({ err }, 'shield_level_change_failed');
            return reply.status(500).send({ error: 'Failed to change shield level' });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── GET /v1/admin/shield-level ─────────────────────────────────────────
    app.get('/v1/admin/shield-level', { preHandler: READ_AUTH }, async (request, reply) => {
        const orgId = (request.headers['x-org-id'] as string) || (request.user as any)?.orgId;
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const cur = await client.query(
                `SELECT o.shield_level,
                        o.shield_level_updated_at,
                        o.shield_level_updated_by,
                        u.email AS shield_level_updated_by_email
                   FROM organizations o
              LEFT JOIN users u ON u.id = o.shield_level_updated_by
                  WHERE o.id = $1`,
                [orgId],
            );

            const hist = await client.query(
                `SELECT er.id,
                        er.actor_email,
                        (er.metadata->>'from_level')::int AS from_level,
                        (er.metadata->>'to_level')::int AS to_level,
                        er.metadata->>'template_locale' AS template_locale,
                        er.metadata->>'template_hash' AS template_hash,
                        er.created_at
                   FROM evidence_records er
                  WHERE er.org_id = $1
                    AND er.category = 'shield_level_change'
               ORDER BY er.created_at DESC
                  LIMIT 50`,
                [orgId],
            );

            return reply.send({
                current: cur.rows[0] ?? null,
                history: hist.rows,
            });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
}
