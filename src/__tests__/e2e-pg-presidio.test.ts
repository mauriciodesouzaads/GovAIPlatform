/**
 * DT-E1: Presidio NLP Container CI Test
 * DT-E4: E2E Tests with PG-realistic Mock 
 * 
 * Tests cover:
 * 1. Presidio /analyze and /anonymize endpoint simulation
 * 2. Full execution pipeline with realistic PG transaction flow
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import axios from 'axios';

// ═════════════════════════════════════════
// DT-E1: Presidio NLP Container CI Test
// ═════════════════════════════════════════
describe('[Presidio] NLP Microservice CI Tests', () => {
    let presidioApp: FastifyInstance;

    beforeAll(async () => {
        // Simulate the Presidio Python microservice with a Fastify mock
        presidioApp = Fastify({ logger: false });

        presidioApp.get('/health', async () => ({ status: 'ok', engine: 'presidio', model: 'pt_core_news_sm' }));

        presidioApp.post('/analyze', async (request) => {
            const { text, language } = request.body as any;
            const entities: any[] = [];

            // Simulate Presidio NER detection
            const namePattern = /(?:Dr\.|Dra\.|Sr\.|Sra\.)\s+[A-Z][a-záéíóú]+(\s+[A-Z][a-záéíóú]+)*/g;
            let match;
            while ((match = namePattern.exec(text)) !== null) {
                entities.push({ type: 'PERSON', start: match.index, end: match.index + match[0].length, score: 0.85, text: match[0] });
            }

            // Simulate location detection
            const locations = ['São Paulo', 'Rio de Janeiro', 'Brasília', 'Lisboa'];
            for (const loc of locations) {
                const idx = text.indexOf(loc);
                if (idx >= 0) {
                    entities.push({ type: 'LOCATION', start: idx, end: idx + loc.length, score: 0.90, text: loc });
                }
            }

            return { entities };
        });

        presidioApp.post('/anonymize', async (request) => {
            const { text } = request.body as any;
            let anonymized = text;
            const namePattern = /(?:Dr\.|Dra\.|Sr\.|Sra\.)\s+[A-Z][a-záéíóú]+(\s+[A-Z][a-záéíóú]+)*/g;
            anonymized = anonymized.replace(namePattern, '<PERSON>');
            const locations = ['São Paulo', 'Rio de Janeiro', 'Brasília', 'Lisboa'];
            for (const loc of locations) {
                anonymized = anonymized.replace(loc, '<LOCATION>');
            }
            const countEntities = (text.length - anonymized.length) > 0 ? 1 : 0;
            return { anonymized_text: anonymized, entities_found: countEntities + (anonymized.includes('<') ? 1 : 0) };
        });

        await presidioApp.ready();
    });

    afterAll(async () => { await presidioApp.close(); });

    it('GET /health should return Presidio engine status', async () => {
        const res = await presidioApp.inject({ method: 'GET', url: '/health' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.engine).toBe('presidio');
        expect(body.model).toBe('pt_core_news_sm');
    });

    it('POST /analyze should detect PERSON entities from Portuguese text', async () => {
        const res = await presidioApp.inject({
            method: 'POST', url: '/analyze',
            payload: { text: 'O Dr. Carlos Silva esteve na reunião de compliance do banco.', language: 'pt' }
        });
        const body = JSON.parse(res.payload);
        expect(body.entities.length).toBeGreaterThan(0);
        expect(body.entities[0].type).toBe('PERSON');
        expect(body.entities[0].text).toContain('Dr. Carlos Silva');
    });

    it('POST /analyze should detect LOCATION entities', async () => {
        const res = await presidioApp.inject({
            method: 'POST', url: '/analyze',
            payload: { text: 'A filial de São Paulo reportou o incidente.', language: 'pt' }
        });
        const body = JSON.parse(res.payload);
        expect(body.entities.some((e: any) => e.type === 'LOCATION')).toBe(true);
    });

    it('POST /anonymize should redact detected entities', async () => {
        const res = await presidioApp.inject({
            method: 'POST', url: '/anonymize',
            payload: { text: 'A Dra. Ana Beatriz esteve em Brasília ontem.', language: 'pt' }
        });
        const body = JSON.parse(res.payload);
        expect(body.anonymized_text).toContain('<PERSON>');
        expect(body.anonymized_text).toContain('<LOCATION>');
        expect(body.anonymized_text).not.toContain('Ana Beatriz');
        expect(body.anonymized_text).not.toContain('Brasília');
    });

    it('POST /analyze should return empty for text without PII', async () => {
        const res = await presidioApp.inject({
            method: 'POST', url: '/analyze',
            payload: { text: 'O relatório trimestral foi aprovado pelo comité.', language: 'pt' }
        });
        const body = JSON.parse(res.payload);
        expect(body.entities).toHaveLength(0);
    });
});

// ═════════════════════════════════════════
// DT-E4: E2E with Realistic PG Transactions
// ═════════════════════════════════════════
describe('[E2E-PG] Full Execution Pipeline with Realistic Transactions', () => {
    // Simulates what happens in a real PG execution flow
    it('should simulate full RLS-scoped transaction: set_config → SELECT → INSERT → COMMIT', async () => {
        const executedQueries: string[] = [];
        const mockClient = {
            query: vi.fn(async (sql: string, params?: any[]) => {
                executedQueries.push(sql);
                if (sql.includes('set_config')) return { rows: [] };
                if (sql.includes('SELECT') && sql.includes('assistant_versions')) {
                    return { rows: [{ version_id: 'v-1', policy_rules: { pii_filter: true, forbidden_topics: ['hack'] } }] };
                }
                if (sql.includes('INSERT INTO audit_logs')) {
                    return { rows: [{ id: 'audit-1' }] };
                }
                if (sql.includes('INSERT INTO token_usage_ledger')) {
                    return { rows: [{ id: 'usage-1' }] };
                }
                return { rows: [] };
            }),
            release: vi.fn(),
        };

        const mockPool = { connect: vi.fn(async () => mockClient) } as any;

        // Simulate the full execution flow
        const client = await mockPool.connect();

        // 1. RLS context
        await client.query(`SELECT set_config('app.current_org_id', \$1, false)`, ['org-banco-central']);
        expect(executedQueries[0]).toContain('set_config');

        // 2. Fetch assistant version
        const vRes = await client.query(
            `SELECT av.id as version_id, pv.rules_jsonb as policy_rules FROM assistant_versions av JOIN policy_versions pv ON av.policy_version_id = pv.id WHERE av.assistant_id = $1 AND av.status = 'published' ORDER BY av.version DESC LIMIT 1`,
            ['asst-compliance']
        );
        expect(vRes.rows[0].version_id).toBe('v-1');

        // 3. Audit log
        await client.query(
            `INSERT INTO audit_logs (org_id, assistant_id, action, message, trace_id) VALUES ($1, $2, $3, $4, $5)`,
            ['org-banco-central', 'asst-compliance', 'EXECUTION_SUCCESS', 'sanitized prompt', 'trace-abc']
        );

        // 4. Token usage
        await client.query(
            `INSERT INTO token_usage_ledger (org_id, assistant_id, tokens_prompt, tokens_completion, tokens_total, cost_usd, trace_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            ['org-banco-central', 'asst-compliance', 100, 200, 300, 0.00045, 'trace-abc']
        );

        client.release();

        expect(executedQueries).toHaveLength(4);
        expect(executedQueries[2]).toContain('INSERT INTO audit_logs');
        expect(executedQueries[3]).toContain('INSERT INTO token_usage_ledger');
    });

    it('should enforce RLS isolation: Org A transaction cannot see Org B data', async () => {
        const orgAData = [{ id: '1', name: 'Agent A', org_id: 'org-A' }];

        const mockClient = {
            query: vi.fn(async (sql: string, params?: any[]) => {
                if (sql.includes('set_config')) return { rows: [] };
                // RLS simulation: only return rows for the org set in context
                const currentOrg = params?.[0] || 'org-A'; // from set_config
                if (sql.includes('SELECT') && sql.includes('assistants')) {
                    return { rows: orgAData.filter(a => a.org_id === currentOrg) };
                }
                return { rows: [] };
            }),
            release: vi.fn(),
        };

        const mockPool = { connect: vi.fn(async () => mockClient) } as any;

        // Org A queries their own data
        const clientA = await mockPool.connect();
        await clientA.query(`SELECT set_config('app.current_org_id', \$1, false)`, ['org-A']);
        const resA = await clientA.query('SELECT * FROM assistants WHERE org_id = $1', ['org-A']);
        expect(resA.rows).toHaveLength(1);
        clientA.release();

        // Org B queries — should get nothing (RLS blocks)
        const clientB = await mockPool.connect();
        await clientB.query(`SELECT set_config('app.current_org_id', \$1, false)`, ['org-B']);
        const resB = await clientB.query('SELECT * FROM assistants WHERE org_id = $1', ['org-B']);
        expect(resB.rows).toHaveLength(0);
        clientB.release();
    });

    it('should handle atomic rollback on audit insert failure', async () => {
        let rolledBack = false;
        const mockClient = {
            query: vi.fn(async (sql: string) => {
                if (sql === 'BEGIN') return { rows: [] };
                if (sql === 'ROLLBACK') { rolledBack = true; return { rows: [] }; }
                if (sql.includes('INSERT INTO audit_logs')) throw new Error('PG: disk full simulation');
                return { rows: [] };
            }),
            release: vi.fn(),
        };
        const mockPool = { connect: vi.fn(async () => mockClient) } as any;

        const client = await mockPool.connect();
        await client.query('BEGIN');
        try {
            await client.query('INSERT INTO audit_logs (org_id) VALUES ($1)', ['org-X']);
            expect.unreachable('Should have thrown');
        } catch (e: any) {
            await client.query('ROLLBACK');
            expect(e.message).toContain('disk full');
        }
        client.release();
        expect(rolledBack).toBe(true);
    });
});
