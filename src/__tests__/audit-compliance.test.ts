import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DLPEngine } from '../lib/dlp-engine';
import { OpaGovernanceEngine } from '../lib/opa-governance';
import { checkQuota, recordTokenUsage, getCostPerToken } from '../lib/finops';
import { CryptoService } from '../lib/crypto-service';
import fs from 'fs';
import path from 'path';

describe('B2B Enterprise Audit — Testes Comportamentais Reais', () => {

    it('[TEST-01] RLS: govai_app role — migration 019 valida pré-requisito em vez de criar com senha hardcoded', async () => {
        const migration = fs.readFileSync(path.join(process.cwd(), '019_rls_and_immutable_policies.sql'), 'utf8');

        // A role govai_app NÃO deve ser criada na migration com senha hardcoded (vulnerabilidade corrigida).
        // Em vez disso, a migration usa um guard que levanta EXCEPTION se a role não existir.
        // A role é criada com senha de ambiente por scripts/init-roles.sh ou scripts/bootstrap-db.sh.
        expect(migration).not.toContain("CREATE USER govai_app WITH PASSWORD");
        expect(migration).not.toContain("GOVAI_APP_PASSWORD_PLACEHOLDER");

        // Verifica a presença do guard de pré-requisito (RAISE EXCEPTION)
        expect(migration).toContain('RAISE EXCEPTION');
        expect(migration).toContain('govai_app');

        // Verifica que os grants mínimos de privilégio estão presentes
        expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES');

        // Verifica que a connection string no docker-compose usa govai_app
        const compose = fs.readFileSync(path.join(process.cwd(), 'docker-compose.yml'), 'utf8');
        expect(compose).toContain('govai_app');
        expect(compose).not.toContain('postgresql://postgres:');
    });

    it('[TEST-02] OPA WASM: policy.wasm existe, é WebAssembly válido e tem tamanho real (>100KB)', () => {
        const wasmPath = path.join(process.cwd(), 'src/lib/opa/policy.wasm');
        expect(fs.existsSync(wasmPath)).toBe(true);
        const stats = fs.statSync(wasmPath);
        expect(stats.size).toBeGreaterThan(100 * 1024); // >100KB — yoga.wasm seria menor ou igual
        // Verificar magic bytes do WebAssembly: 0x00 0x61 0x73 0x6D
        const buf = fs.readFileSync(wasmPath);
        expect(buf[0]).toBe(0x00);
        expect(buf[1]).toBe(0x61); // 'a'
        expect(buf[2]).toBe(0x73); // 's'
        expect(buf[3]).toBe(0x6D); // 'm'
    });

    it('[TEST-03] Imutabilidade: trigger em policy_versions existe com nome correto na migration', () => {
        const migration = fs.readFileSync(path.join(process.cwd(), '019_rls_and_immutable_policies.sql'), 'utf8');
        // O trigger foi criado como trg_immutable_policy_versions — usar esse nome
        expect(migration).toContain('trg_immutable_policy_versions');
        expect(migration).toContain('policy_versions');
        expect(migration).toContain('protect_audit_logs');
    });

    it('[TEST-04] DLP executa mesmo com OPA WASM ativo — CPF não passa para LLM', async () => {
        const engine = new OpaGovernanceEngine();
        // Simular WASM ativo injetando um opaIns mock que sempre retorna allow=true
        (engine as any).opaIns = { evaluate: () => [{ result: { allow: true } }] };

        const result = await engine.evaluate(
            { message: 'Meu CPF é 529.982.247-25 pode confirmar?' },
            { rules: { pii_filter: true } }
        );

        // DLP DEVE interceptar mesmo com WASM ativo
        expect(result.action).toBe('FLAG');
        expect(result.sanitizedInput).toContain('[CPF_REDACTED]');
        expect(result.sanitizedInput).not.toContain('529.982.247-25');
    });

    it('[TEST-05] HITL executa mesmo com OPA WASM ativo — palavras de alto risco pausam execução', async () => {
        const engine = new OpaGovernanceEngine();
        // Simular WASM ativo
        (engine as any).opaIns = { evaluate: () => [{ result: { allow: true } }] };

        const result = await engine.evaluate(
            { message: 'preciso exportar banco de dados de produção agora' },
            { rules: { hitl_enabled: true, hitl_keywords: ['exportar banco', 'produção'] } }
        );

        // HITL DEVE interceptar mesmo com WASM ativo
        expect(result.action).toBe('PENDING_APPROVAL');
        expect(result.allowed).toBe(false);
    });

    it('[TEST-06] FinOps bloqueia execução quando hard cap excedido', async () => {
        const mockPool = {
            connect: vi.fn().mockResolvedValue({
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('SELECT set_config')) return { rows: [] };
                    // Retornar quota estourada
                    return { rows: [{ soft_cap_tokens: 1000, hard_cap_tokens: 5000, tokens_used: 6000 }] };
                }),
                release: vi.fn()
            })
        } as any;

        const { checkQuota } = await import('../lib/finops');
        const quota = await checkQuota(mockPool, 'org-123');

        expect(quota.exceeded).toBe(true);
        expect(quota.tokens_used).toBeGreaterThan(quota.hard_cap);
    });

    it('[TEST-07] getCostPerToken retorna pricing real por provider (não o fallback 0.000002)', () => {
        expect(getCostPerToken('gemini/gemini-1.5-flash')).toBe(0.000000019);
        expect(getCostPerToken('openai/gpt-4o')).toBe(0.000005000);
        expect(getCostPerToken('anthropic/claude-3-5-sonnet')).toBe(0.000003000);
        // Fallback para modelo desconhecido
        expect(getCostPerToken('unknown/model-xyz')).toBe(0.000002);
    });

    it('[TEST-08] CryptoService gera DEK única por chamada (envelope encryption)', async () => {
        const mockKms = {
            encrypt: vi.fn().mockImplementation(async (r) => "encrypted_" + r),
            decrypt: vi.fn(),
            isConfigured: vi.fn()
        } as any;
        const service1 = new CryptoService(mockKms);
        const service2 = new CryptoService(mockKms);
        const result1 = await service1.encryptPayload('dados sensíveis');
        const result2 = await service2.encryptPayload('dados sensíveis');
        // IV deve ser diferente a cada chamada
        expect(result1.iv_bytes).not.toBe(result2.iv_bytes);
        // Ciphertext deve ser diferente (mesmo plaintext, IV diferente)
        expect(result1.content_encrypted_bytes).not.toBe(result2.content_encrypted_bytes);
    });

    it('[TEST-09] RBAC: requireRole está aplicado nos endpoints corretos', () => {
        const approvals = fs.readFileSync(path.join(process.cwd(), 'src/routes/approvals.routes.ts'), 'utf8');
        // approve só permite sre e admin
        expect(approvals).toContain("requireRole(['sre', 'admin'])");
        // operator não pode aprovar
        expect(approvals).not.toMatch(/approvals.*approvalId.*approve.*requireRole\(\['.*operator/);
    });

    it('[TEST-10] Homologação: rota de publicação exige checklist e registra published_by', () => {
        const assistants = fs.readFileSync(path.join(process.cwd(), 'src/routes/assistants.routes.ts'), 'utf8');
        expect(assistants).toContain('checklist_jsonb');
        expect(assistants).toContain('published_by');
        expect(assistants).toContain('published_at');
        // Validação que rejeita checklist incompleto
        expect(assistants).toContain("Object.values(checklist).some(val => val !== true)");
    });

    it('[TEST-11] Migration de expiração cross-tenant existe e tem política RLS correta', () => {
        const migration = fs.readFileSync(path.join(process.cwd(), '020_expiration_worker_rls_bypass.sql'), 'utf8');
        expect(migration).toContain('expiration_worker_policy');
        expect(migration).toContain('FOR UPDATE');
        expect(migration).toContain("status = 'pending'");
        expect(migration).toContain("expires_at <= NOW()");
    });
});
