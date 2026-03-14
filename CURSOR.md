# GovAI Platform — AI Coding Agent Guide

## Stack
- Runtime: Node.js 20 + TypeScript (strict em breve — P-15)
- API: Fastify 5 com @fastify/helmet, @fastify/cors, @fastify/jwt
- DB: PostgreSQL 15 + pgvector via Pool (src/lib/db.ts)
- Cache/Queue: Redis + BullMQ
- Policy: OPA WASM (src/lib/opa-governance.ts)
- DLP: Presidio NLP + regex engine (src/lib/dlp-engine.ts)
- Auth: JWT + OIDC SSO + user_lookup table (sem RLS bypass)
- Testes: Vitest 3, coverage via @vitest/coverage-v8

## Arquitetura de Segurança (CRÍTICO — nunca ignorar)
- RLS multi-tenant: toda query deve ter org_id no contexto
- Operações cross-tenant: usar SET ROLE platform_admin,
  sempre em try/finally com RESET ROLE
- PII: usar safeMessage (nunca message raw) para RAG e LLM
- Secrets: nunca hardcodar — usar process.env com :? operator
- API keys: formato sk-govai-{uuid24}, prefix = primeiros 12 chars

## Convenções obrigatórias
- Validação de input: sempre Zod safeParse antes de processar
- Resposta 400: { error: 'Validation failed', details: zodErrors(e) }
- Migrations SQL: criar em NNN_nome.sql, registrar em migrate.sh
- Testes: mockar pgPool e logger, nunca depender de banco real
- Novos endpoints: registrar em server.ts, adicionar Zod schema
- Embeddings: sempre validar dimension === EMBEDDING_DIMENSION (768)

## Estrutura de diretórios
```
src/
  lib/          — utilitários (dlp, opa, governance, crypto, rag)
  routes/       — Fastify route plugins
  services/     — lógica de negócio (execution.service.ts)
  workers/      — BullMQ workers (audit, notification, expiration)
  jobs/         — BullMQ scheduled jobs (api-key-rotation)
  __tests__/    — Vitest tests (unit + integration)
scripts/        — migrate.sh, backup, seed
*.sql           — migrations (022-032)
```

## Comandos essenciais
```
npm test                    — unit tests (vitest run)
npm run test:coverage       — coverage com thresholds
npm run lint                — tsc --noEmit
docker compose up -d        — subir todos os serviços
docker compose build --no-cache api — rebuild após mudanças
```

## Débitos técnicos em backlog (NÃO implementar sem instrução)
- DT-P14-A: coverage para assistants.routes.ts e approvals.routes.ts
- DT-P14-B: coverage para execution.service.ts
- DT-P14-C: coverage para api-key-rotation.job.ts
- DT-P04-A: LLM02 scan de output antes de retornar ao usuário
- DT-P04-B: Indirect Prompt Injection via conteúdo RAG
- DT-K-03:  E2E com banco real (32 migrations em sequência)
- DT-P02:   pgaudit para capturar SET ROLE nos logs

## Armadilhas conhecidas
- docker compose build usa cache: usar --no-cache após mudanças em src/
- Cursor não salva arquivos em disco automaticamente: verificar
  com ls e cat após cada geração
- sed com regex multilinha corrompe YAML: usar node -e para editar
  docker-compose.yml e arquivos similares
- zsh interpreta ? como glob: usar setopt NO_NOMATCH no terminal
- BullMQ 5: repeat usa { pattern: CRON } não { cron: CRON }
