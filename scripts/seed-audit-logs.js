#!/usr/bin/env node
// ============================================================================
// GovAI Platform — Demo Audit Log Seeder (FASE-A3)
// ============================================================================
// Generates 20 audit log entries with valid HMAC-SHA256 signatures.
// Idempotent: uses ON CONFLICT (id, org_id) DO NOTHING.
// Requires: SIGNING_SECRET and DATABASE_URL environment variables.
// ============================================================================

'use strict';

const crypto = require('crypto');
const { Client } = require('pg');

const ORG_ID    = '00000000-0000-0000-0000-000000000001';
const ADMIN_ID  = '55d9bd9f-f9c9-4d78-9aa0-3b3af2e4f7ab';
const DPO_ID    = '00000000-0000-0000-0001-000000000002';
const DEV_ID    = '00000000-0000-0000-0001-000000000003';
const CISO_ID   = '00000000-0000-0000-0001-000000000004';

const AST_JURIDICO  = '00000000-0000-0000-0002-000000000001';
const AST_RH        = '00000000-0000-0000-0002-000000000002';
const AST_CREDITO   = '00000000-0000-0000-0002-000000000003';
const AST_DEMO      = '00000000-0000-0000-0000-000000000002';

const SIGNING_SECRET = process.env.SIGNING_SECRET;
if (!SIGNING_SECRET) {
    console.error('ERROR: SIGNING_SECRET is not set');
    process.exit(1);
}

const DB_URL = process.env.DATABASE_URL
    || `postgresql://govai_app:${process.env.DB_APP_PASSWORD || 'govai_dev_app_password'}@localhost:5432/govai_platform`;

function signPayload(payload, secret) {
    return crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(payload))
        .digest('hex');
}

function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString();
}

function hoursAgo(h) {
    const d = new Date();
    d.setHours(d.getHours() - h);
    return d.toISOString();
}

function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Audit log entries ────────────────────────────────────────────────────────
// IDs: 00000000-0000-0000-00FF-00000000000X (X = 01-14)

function buildEntries() {
    return [
        // ── EXECUTION_SUCCESS (10) ──────────────────────────────────────────

        // FAQ RH — 4 executions
        {
            id: '00000000-0000-0000-00ff-000000000001',
            assistant_id: AST_RH,
            action: 'EXECUTION_SUCCESS',
            created_at: daysAgo(28),
            metadata: {
                assistant_id: AST_RH, user_id: DEV_ID,
                traceId: 'trace-rh-001', model: 'govai-llm',
                usage: { prompt_tokens: 312, completion_tokens: 184, total_tokens: 496 },
                latency_ms: 1243
            }
        },
        {
            id: '00000000-0000-0000-00ff-000000000002',
            assistant_id: AST_RH,
            action: 'EXECUTION_SUCCESS',
            created_at: daysAgo(14),
            metadata: {
                assistant_id: AST_RH, user_id: DEV_ID,
                traceId: 'trace-rh-002', model: 'govai-llm',
                usage: { prompt_tokens: 445, completion_tokens: 221, total_tokens: 666 },
                latency_ms: 1876
            }
        },
        {
            id: '00000000-0000-0000-00ff-000000000003',
            assistant_id: AST_RH,
            action: 'EXECUTION_SUCCESS',
            created_at: daysAgo(7),
            metadata: {
                assistant_id: AST_RH, user_id: ADMIN_ID,
                traceId: 'trace-rh-003', model: 'govai-llm',
                usage: { prompt_tokens: 598, completion_tokens: 302, total_tokens: 900 },
                latency_ms: 2104
            }
        },
        {
            id: '00000000-0000-0000-00ff-000000000004',
            assistant_id: AST_RH,
            action: 'EXECUTION_SUCCESS',
            created_at: daysAgo(2),
            metadata: {
                assistant_id: AST_RH, user_id: DEV_ID,
                traceId: 'trace-rh-004', model: 'govai-llm',
                usage: { prompt_tokens: 287, completion_tokens: 143, total_tokens: 430 },
                latency_ms: 988
            }
        },

        // Assistente Jurídico — 3 executions
        {
            id: '00000000-0000-0000-00ff-000000000005',
            assistant_id: AST_JURIDICO,
            action: 'EXECUTION_SUCCESS',
            created_at: daysAgo(25),
            metadata: {
                assistant_id: AST_JURIDICO, user_id: DPO_ID,
                traceId: 'trace-jur-001', model: 'govai-llm',
                usage: { prompt_tokens: 712, completion_tokens: 398, total_tokens: 1110 },
                latency_ms: 2891
            }
        },
        {
            id: '00000000-0000-0000-00ff-000000000006',
            assistant_id: AST_JURIDICO,
            action: 'EXECUTION_SUCCESS',
            created_at: daysAgo(10),
            metadata: {
                assistant_id: AST_JURIDICO, user_id: DPO_ID,
                traceId: 'trace-jur-002', model: 'govai-llm',
                usage: { prompt_tokens: 834, completion_tokens: 421, total_tokens: 1255 },
                latency_ms: 3102
            }
        },
        {
            id: '00000000-0000-0000-00ff-000000000007',
            assistant_id: AST_JURIDICO,
            action: 'EXECUTION_SUCCESS',
            created_at: daysAgo(3),
            metadata: {
                assistant_id: AST_JURIDICO, user_id: CISO_ID,
                traceId: 'trace-jur-003', model: 'govai-llm',
                usage: { prompt_tokens: 623, completion_tokens: 317, total_tokens: 940 },
                latency_ms: 2456
            }
        },

        // Análise de Crédito — 2 executions
        {
            id: '00000000-0000-0000-00ff-000000000008',
            assistant_id: AST_CREDITO,
            action: 'EXECUTION_SUCCESS',
            created_at: daysAgo(12),
            metadata: {
                assistant_id: AST_CREDITO, user_id: CISO_ID,
                traceId: 'trace-cred-001', model: 'govai-llm',
                usage: { prompt_tokens: 789, completion_tokens: 394, total_tokens: 1183 },
                latency_ms: 2788
            }
        },
        {
            id: '00000000-0000-0000-00ff-000000000009',
            assistant_id: AST_CREDITO,
            action: 'EXECUTION_SUCCESS',
            created_at: daysAgo(4),
            metadata: {
                assistant_id: AST_CREDITO, user_id: CISO_ID,
                traceId: 'trace-cred-002', model: 'govai-llm',
                usage: { prompt_tokens: 512, completion_tokens: 288, total_tokens: 800 },
                latency_ms: 1923
            }
        },

        // Demo assistant — 1 execution
        {
            id: '00000000-0000-0000-00ff-00000000000a',
            assistant_id: AST_DEMO,
            action: 'EXECUTION_SUCCESS',
            created_at: daysAgo(20),
            metadata: {
                assistant_id: AST_DEMO, user_id: ADMIN_ID,
                traceId: 'trace-demo-001', model: 'govai-llm',
                usage: { prompt_tokens: 201, completion_tokens: 97, total_tokens: 298 },
                latency_ms: 812
            }
        },

        // ── POLICY_VIOLATION (4) ──────────────────────────────────────────

        // Forbidden topic
        {
            id: '00000000-0000-0000-00ff-00000000000b',
            assistant_id: AST_RH,
            action: 'POLICY_VIOLATION',
            created_at: daysAgo(18),
            metadata: {
                assistant_id: AST_RH,
                traceId: 'trace-viol-001',
                violation_type: 'forbidden_topic',
                topic: 'drogas',
                policy_version: 'Política Padrão v1',
                blocked: true
            }
        },

        // Another forbidden topic
        {
            id: '00000000-0000-0000-00ff-00000000000c',
            assistant_id: AST_JURIDICO,
            action: 'POLICY_VIOLATION',
            created_at: daysAgo(9),
            metadata: {
                assistant_id: AST_JURIDICO,
                traceId: 'trace-viol-002',
                violation_type: 'forbidden_topic',
                topic: 'conteúdo adulto',
                policy_version: 'Política Restritiva v1',
                blocked: true
            }
        },

        // Jailbreak attempt
        {
            id: '00000000-0000-0000-00ff-00000000000d',
            assistant_id: AST_CREDITO,
            action: 'POLICY_VIOLATION',
            created_at: daysAgo(5),
            metadata: {
                assistant_id: AST_CREDITO,
                traceId: 'trace-viol-003',
                violation_type: 'jailbreak_attempt',
                pattern: 'ignore previous instructions',
                policy_version: 'Política Restritiva v1',
                blocked: true
            }
        },

        // PII detected
        {
            id: '00000000-0000-0000-00ff-00000000000e',
            assistant_id: AST_RH,
            action: 'POLICY_VIOLATION',
            created_at: daysAgo(1),
            metadata: {
                assistant_id: AST_RH,
                traceId: 'trace-viol-004',
                violation_type: 'pii_detected',
                pii_type: 'cpf',
                policy_version: 'Política Padrão v1',
                blocked: true,
                redacted: true
            }
        },

        // ── PENDING_APPROVAL (2) ──────────────────────────────────────────

        {
            id: '00000000-0000-0000-00ff-00000000000f',
            assistant_id: AST_CREDITO,
            action: 'PENDING_APPROVAL',
            created_at: hoursAgo(2),
            metadata: {
                assistant_id: AST_CREDITO,
                traceId: 'trace-hitl-demo-001',
                approval_id: '00000000-0000-0000-000b-000000000001',
                keyword_trigger: 'remover limite',
                message_preview: 'Remover limite de crédito para cliente XPTO'
            }
        },
        {
            id: '00000000-0000-0000-00ff-000000000010',
            assistant_id: AST_JURIDICO,
            action: 'PENDING_APPROVAL',
            created_at: hoursAgo(5),
            metadata: {
                assistant_id: AST_JURIDICO,
                traceId: 'trace-hitl-demo-002',
                approval_id: '00000000-0000-0000-000b-000000000002',
                keyword_trigger: 'cláusula penal',
                message_preview: 'Analisar cláusula penal do contrato'
            }
        },

        // ── APPROVAL_GRANTED (2 — historical) ──────────────────────────────

        {
            id: '00000000-0000-0000-00ff-000000000011',
            assistant_id: AST_CREDITO,
            action: 'APPROVAL_GRANTED',
            created_at: daysAgo(22),
            metadata: {
                assistant_id: AST_CREDITO,
                traceId: 'trace-appr-001',
                reviewer_email: 'compliance@orga.com',
                review_note: 'Aprovado após verificação manual do cliente.',
                latency_minutes: 18
            }
        },
        {
            id: '00000000-0000-0000-00ff-000000000012',
            assistant_id: AST_JURIDICO,
            action: 'APPROVAL_GRANTED',
            created_at: daysAgo(16),
            metadata: {
                assistant_id: AST_JURIDICO,
                traceId: 'trace-appr-002',
                reviewer_email: 'admin@orga.com',
                review_note: 'Análise contratual padrão — aprovado.',
                latency_minutes: 7
            }
        },

        // ── EXIT_GOVERNED_PERIMETER (1) ─────────────────────────────────

        {
            id: '00000000-0000-0000-00ff-000000000013',
            assistant_id: AST_DEMO,
            action: 'EXIT_GOVERNED_PERIMETER',
            created_at: daysAgo(8),
            metadata: {
                assistant_id: AST_DEMO,
                user_id: DEV_ID,
                target_url: 'https://chatgpt.com',
                ip: '10.0.1.42',
                acknowledgment: true,
                session_hash: 'sha256-demo-exit-acknowledged'
            }
        },

        // ── QUOTA_EXCEEDED (1) ──────────────────────────────────────────

        {
            id: '00000000-0000-0000-00ff-000000000014',
            assistant_id: AST_CREDITO,
            action: 'QUOTA_EXCEEDED',
            created_at: daysAgo(6),
            metadata: {
                assistant_id: AST_CREDITO,
                traceId: 'trace-quota-001',
                quota_type: 'monthly_tokens',
                limit: 500000,
                current: 512340,
                period: 'monthly'
            }
        }
    ];
}

async function main() {
    const client = new Client({ connectionString: DB_URL });
    await client.connect();

    try {
        await client.query('BEGIN');
        await client.query(
            "SELECT set_config('app.current_org_id', $1, true)",
            [ORG_ID]
        );

        const entries = buildEntries();
        let inserted = 0;
        let skipped  = 0;

        for (const entry of entries) {
            const payload = {
                id:           entry.id,
                org_id:       ORG_ID,
                assistant_id: entry.assistant_id,
                action:       entry.action,
                metadata:     entry.metadata,
                created_at:   entry.created_at
            };
            const signature = signPayload(payload, SIGNING_SECRET);

            const result = await client.query(
                `INSERT INTO audit_logs_partitioned
                    (id, org_id, assistant_id, action, metadata, signature, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (id, org_id) DO NOTHING`,
                [
                    entry.id,
                    ORG_ID,
                    entry.assistant_id,
                    entry.action,
                    JSON.stringify(entry.metadata),
                    signature,
                    entry.created_at
                ]
            );

            if (result.rowCount > 0) {
                inserted++;
            } else {
                skipped++;
            }
        }

        await client.query('COMMIT');
        console.log(`  Inseridos: ${inserted} | Pulados (já existiam): ${skipped}`);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('ERROR inserting audit logs:', err.message);
        process.exit(1);
    } finally {
        await client.end();
    }
}

main();
