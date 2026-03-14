# GovAI Platform — Status da Remediação de Segurança

## Contexto
Este projeto passou por auditoria técnica completa com 16 prompts de
remediação. 15 de 16 foram concluídos. Este arquivo guia a próxima sessão.

## Estado atual
- Testes: 421 passando (33 arquivos)
- Migrations: 032 aplicadas (022 a 032)
- Branch: main
- Último commit: P11-P16 complete remediation

## O que JÁ FOI feito (NÃO refazer)
- P-01: RLS Login Bypass corrigido (tabela user_lookup criada)
- P-02: Cross-Tenant Expiration Worker corrigido
- P-03: CI/CD Pipeline criado (.github/workflows/ci-cd.yml)
- P-04: OPA Rego expandido com OWASP LLM Top 10 (144 testes)
- P-05: CVE-RAG corrigido (execution.service.ts usa safeMessage)
- P-06: RAG approvals corrigido + 4 rotas registradas em server.ts
- P-07: Credencial exposta removida + gitleaks + secret-scanning.yml
- P-08: Validação Zod em todos os endpoints (src/lib/schemas.ts)
- P-09: @fastify/helmet instalado e configurado (CSP, HSTS, DENY)
- P-10: Embedding dimension 768 explícita (src/lib/embedding-config.ts)
- P-11: api-key-rotation.job.ts criado (BullMQ, cron 0 2 * * *)
- P-12: Rate limiting granular (login 10/15min, execute 100/1min)
- P-13: Dockerfile multi-stage + non-root user govai
- P-14: Coverage gate configurado (72% lines, 79% functions, 75% branches)
- P-16: CURSOR.md + AGENTS.md criados

## PRÓXIMA TAREFA — P-15 (única pendente)

### Objetivo
Habilitar TypeScript strict mode + expandir cobertura de testes.

### PARTE A — TypeScript strict mode
1. Ler tsconfig.json atual
2. Adicionar: "strict": true, "noImplicitAny": true,
   "strictNullChecks": true, "strictFunctionTypes": true
3. Rodar: npm run lint 2>&1 | grep "error TS" | head -20
4. Catalogar erros SEM corrigir ainda
5. Corrigir em ordem: src/lib/ → src/routes/ → src/services/ → src/workers/
6. NUNCA usar "as any" para suprimir erros
7. npm run lint deve retornar zero erros

### PARTE B — Expandir Coverage
Adicionar ao include em vitest.config.ts:
- src/routes/assistants.routes.ts
- src/routes/approvals.routes.ts
- src/services/execution.service.ts
- src/jobs/api-key-rotation.job.ts

Manter thresholds: lines≥70, functions≥70, branches≥60.
Se falhar, adicionar testes com mocks (não baixar thresholds).

### Critérios de aceite P-15
- grep "strict" tsconfig.json → mostra "strict": true
- npm run lint → zero erros TypeScript
- npm run test:coverage → thresholds passando com escopo expandido
- npx vitest run → 421+ passed, 0 failed

## Débitos técnicos registrados (NÃO implementar agora)
- DT-P04-A: LLM02 scan de output do LLM antes de retornar
- DT-P04-B: Indirect Prompt Injection via RAG
- DT-P14-A/B/C: Coverage expandido (tratado no P-15)
- DT-K-03: E2E com banco real (32 migrations em sequência)
- DT-P02: pgaudit para capturar SET ROLE nos logs

## Regras críticas de segurança (NUNCA violar)
- Toda query com org_id no contexto (RLS multi-tenant)
- Operações cross-tenant: SET ROLE platform_admin + RESET ROLE em finally
- RAG e LLM: usar safeMessage, nunca message raw
- Secrets: process.env com :? operator, nunca fallback hardcoded
- Zod safeParse em todos os endpoints antes de processar input
