/**
 * Shield Workflow Service
 *
 * Workflow de findings: acknowledge, promote, accept_risk, dismiss, resolve, reopen,
 * assign-owner, comment e listagem de actions.
 */

import { Pool, PoolClient } from 'pg';
import { recordEvidence, linkEvidence } from './evidence';
import { ShieldPromoteResult } from './shield-findings.service';

type DbClient = Pool | PoolClient;

// ── insertFindingAction (helper privado) ──────────────────────────────────────

async function insertFindingAction(
    db: DbClient,
    orgId: string,
    findingId: string,
    actionType: string,
    actorUserId: string | null,
    note?: string | null,
    metadata?: Record<string, unknown>
): Promise<void> {
    await (db as Pool).query(
        `INSERT INTO shield_finding_actions
         (org_id, finding_id, action_type, actor_user_id, note, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [orgId, findingId, actionType, actorUserId, note ?? null, JSON.stringify(metadata ?? {})]
    );
    // Bump last_action_at on finding for every workflow action
    await (db as Pool).query(
        `UPDATE shield_findings SET last_action_at = NOW() WHERE id = $1`,
        [findingId]
    );
}

// ── acknowledgeShieldFinding ──────────────────────────────────────────────────

export async function acknowledgeShieldFinding(
    db: DbClient,
    findingId: string,
    actorUserId: string
): Promise<void> {
    // Buscar org_id do finding para o action log
    const row = await (db as Pool).query(
        `UPDATE shield_findings
         SET status          = 'acknowledged',
             acknowledged_at = NOW(),
             acknowledged_by = $2
         WHERE id = $1 AND status = 'open'
         RETURNING org_id`,
        [findingId, actorUserId]
    );
    if (row.rows.length > 0) {
        const orgId = row.rows[0].org_id as string;
        await insertFindingAction(db, orgId, findingId, 'acknowledge', actorUserId);
    }
}

// ── promoteShieldFindingToCatalog ─────────────────────────────────────────────

/**
 * Promove um finding para o catálogo de capacidades:
 *   1. Cria um assistant draft mínimo na tabela assistants
 *   2. Marca o finding como promoted
 *   3. Gera evidence_record (categoria: publication)
 *   4. Linka o evidence ao finding via evidence_links
 *
 * Toda a operação ocorre em uma transação.
 * Requer app.current_org_id configurado (session-level, false).
 */
export async function promoteShieldFindingToCatalog(
    pool: Pool,
    findingId: string,
    actorUserId: string,
    options: { assistantName?: string; category?: string } = {}
): Promise<ShieldPromoteResult> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Carregar finding
        const findingResult = await client.query(
            `SELECT id, org_id, tool_name, tool_name_normalized, severity
             FROM shield_findings WHERE id = $1`,
            [findingId]
        );
        if (findingResult.rows.length === 0) {
            throw new Error(`Finding ${findingId} não encontrado.`);
        }
        const finding = findingResult.rows[0];
        const orgId = finding.org_id as string;

        // Configurar contexto org (session-level, limpo no finally)
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)",
            [orgId]
        );

        // Criar assistant draft mínimo no catálogo
        const assistantName = options.assistantName
            ?? `[Shield Draft] ${finding.tool_name}`;
        const assistantResult = await client.query(
            `INSERT INTO assistants
             (org_id, name, status, lifecycle_state, description, risk_level, owner_id)
             VALUES ($1, $2, 'draft', 'draft', $3, $4, $5)
             RETURNING id`,
            [
                orgId,
                assistantName,
                `Capability draft promovida automaticamente pelo Shield Core. Ferramenta detectada: ${finding.tool_name_normalized}.`,
                finding.severity === 'high' || finding.severity === 'critical' ? 'high' : 'medium',
                actorUserId,
            ]
        );
        const assistantId = assistantResult.rows[0].id as string;

        // Atualizar finding → promoted
        await client.query(
            `UPDATE shield_findings
             SET status = 'promoted'
             WHERE id = $1`,
            [findingId]
        );

        // Log da ação de promoção
        await insertFindingAction(client, orgId, findingId, 'promote', actorUserId);

        await client.query('COMMIT');

        // Gerar evidence FORA da transação principal (não-fatal, usa pool direto)
        // set_config session-level já está ativo na conexão do pool
        const ev = await recordEvidence(pool, {
            orgId,
            category:     'publication',
            eventType:    'SHIELD_FINDING_PROMOTED',
            actorId:      actorUserId,
            resourceType: 'assistant',
            resourceId:   assistantId,
            metadata: {
                findingId,
                toolName: finding.tool_name,
                toolNameNormalized: finding.tool_name_normalized,
                severity: finding.severity,
            },
        });

        // Linkar evidence ao finding via resource_id
        if (ev) {
            await linkEvidence(pool, ev.id, findingId, 'promoted_from_finding');
        }

        return {
            findingId,
            assistantId,
            evidenceId: ev?.id ?? null,
        };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── acceptRisk ────────────────────────────────────────────────────────────────

/**
 * Marca um finding como risco aceito.
 * Transição válida: open | acknowledged → accepted_risk.
 * Gera action log.
 */
export async function acceptRisk(
    pool: Pool,
    findingId: string,
    actorUserId: string,
    note: string   // obrigatório — justificativa de aceite de risco
): Promise<void> {
    if (!note?.trim()) {
        throw new Error('Justificativa obrigatória para aceite de risco (acceptRisk.note).');
    }
    const client = await pool.connect();
    try {
        const row = await client.query(
            `UPDATE shield_findings
             SET status            = 'accepted_risk',
                 accepted_risk     = true,
                 accepted_risk_note = $2,
                 accepted_risk_at  = NOW(),
                 accepted_risk_by  = $3
             WHERE id = $1
               AND status IN ('open','acknowledged')
             RETURNING org_id`,
            [findingId, note ?? null, actorUserId]
        );
        if (row.rows.length > 0) {
            const orgId = row.rows[0].org_id as string;
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [orgId]
            );
            await insertFindingAction(client, orgId, findingId, 'accept_risk', actorUserId, note);
        }
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── dismissFinding ────────────────────────────────────────────────────────────

/**
 * Descarta um finding (falso positivo, fora de escopo, etc.).
 * Transição válida: open | acknowledged → dismissed.
 * Gera action log.
 */
export async function dismissFinding(
    pool: Pool,
    findingId: string,
    actorUserId: string,
    reason: string  // obrigatório — motivo do dismiss
): Promise<void> {
    if (!reason?.trim()) {
        throw new Error('Motivo obrigatório para dismiss de finding (dismissFinding.reason).');
    }
    const client = await pool.connect();
    try {
        const row = await client.query(
            `UPDATE shield_findings
             SET status           = 'dismissed',
                 dismissed_at     = NOW(),
                 dismissed_by     = $2,
                 dismissed_reason = $3
             WHERE id = $1
               AND status IN ('open','acknowledged')
             RETURNING org_id`,
            [findingId, actorUserId, reason]
        );
        if (row.rows.length > 0) {
            const orgId = row.rows[0].org_id as string;
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [orgId]
            );
            await insertFindingAction(client, orgId, findingId, 'dismiss', actorUserId, reason);
        }
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── resolveFinding ────────────────────────────────────────────────────────────

/**
 * Marca um finding como resolvido (ferramenta desativada, controlada, etc.).
 * Transição válida: qualquer status ativo → resolved.
 * Gera action log.
 */
export async function resolveFinding(
    pool: Pool,
    findingId: string,
    actorUserId: string,
    note?: string
): Promise<void> {
    const client = await pool.connect();
    try {
        const row = await client.query(
            `UPDATE shield_findings
             SET status      = 'resolved',
                 resolved_at = NOW(),
                 resolved_by = $2
             WHERE id = $1
               AND status NOT IN ('promoted','resolved')
             RETURNING org_id`,
            [findingId, actorUserId]
        );
        if (row.rows.length > 0) {
            const orgId = row.rows[0].org_id as string;
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [orgId]
            );
            await insertFindingAction(client, orgId, findingId, 'resolve', actorUserId, note);
        }
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── reopenFinding ─────────────────────────────────────────────────────────────

/**
 * Reabre um finding (dismissed ou resolved).
 * Transição válida: dismissed | resolved | accepted_risk → open.
 * Gera action log.
 */
export async function reopenFinding(
    pool: Pool,
    findingId: string,
    actorUserId: string,
    note?: string
): Promise<void> {
    const client = await pool.connect();
    try {
        const row = await client.query(
            `UPDATE shield_findings
             SET status           = 'open',
                 accepted_risk    = false,
                 accepted_risk_at = NULL,
                 accepted_risk_by = NULL,
                 dismissed_at     = NULL,
                 dismissed_by     = NULL,
                 resolved_at      = NULL,
                 resolved_by      = NULL,
                 reopened_at      = NOW(),
                 reopened_by      = $2
             WHERE id = $1
               AND status IN ('dismissed','resolved','accepted_risk')
             RETURNING org_id`,
            [findingId, actorUserId]
        );
        if (row.rows.length > 0) {
            const orgId = row.rows[0].org_id as string;
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [orgId]
            );
            await insertFindingAction(client, orgId, findingId, 'reopen', actorUserId, note);
        }
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── assignShieldFindingOwner (Sprint S2) ──────────────────────────────────────

/**
 * Atribui um owner candidate a um finding e registra action log.
 * ownerCandidateHash: SHA-256 do identificador do owner (nunca plain).
 * Gera action log 'assign_owner'.
 */
export async function assignShieldFindingOwner(
    pool: Pool,
    findingId: string,
    ownerCandidateHash: string,
    actorUserId: string,
    note?: string
): Promise<void> {
    const client = await pool.connect();
    try {
        const row = await client.query(
            `UPDATE shield_findings
             SET owner_candidate_hash = $2,
                 owner_assigned_at    = NOW(),
                 owner_assigned_by    = $3,
                 owner_note           = $4,
                 updated_at           = NOW()
             WHERE id = $1
             RETURNING org_id`,
            [findingId, ownerCandidateHash, actorUserId, note ?? null]
        );
        if (row.rows.length > 0) {
            const orgId = row.rows[0].org_id as string;
            await client.query(
                "SELECT set_config('app.current_org_id', $1, false)", [orgId]
            );
            await insertFindingAction(
                client, orgId, findingId, 'assign_owner', actorUserId, note,
                { ownerCandidateHash }
            );
        }
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── appendShieldFindingComment (Sprint S2) ────────────────────────────────────

/**
 * Adiciona comentário ao action log de um finding.
 * Não altera status. Note é obrigatório.
 */
export async function appendShieldFindingComment(
    pool: Pool,
    findingId: string,
    actorUserId: string,
    note: string
): Promise<void> {
    if (!note?.trim()) {
        throw new Error('Comentário não pode ser vazio (appendShieldFindingComment.note).');
    }
    const client = await pool.connect();
    try {
        const row = await client.query(
            `SELECT org_id FROM shield_findings WHERE id = $1`,
            [findingId]
        );
        if (row.rows.length === 0) return;
        const orgId = row.rows[0].org_id as string;
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [orgId]
        );
        await insertFindingAction(client, orgId, findingId, 'comment', actorUserId, note);
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── listShieldFindingActions (Sprint S2) ──────────────────────────────────────

/**
 * Lista o action log de um finding, ordenado por created_at ASC.
 * Requer que o orgId seja fornecido pelo caller (já validado).
 */
export async function listShieldFindingActions(
    pool: Pool,
    orgId: string,
    findingId: string
): Promise<any[]> {
    const client = await pool.connect();
    try {
        await client.query(
            "SELECT set_config('app.current_org_id', $1, false)", [orgId]
        );
        const result = await client.query(
            `SELECT id, action_type, actor_user_id, note, metadata, created_at
             FROM shield_finding_actions
             WHERE org_id = $1 AND finding_id = $2
             ORDER BY created_at ASC`,
            [orgId, findingId]
        );
        return result.rows;
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}
