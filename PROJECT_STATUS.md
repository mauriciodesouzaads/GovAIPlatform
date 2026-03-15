# GovAI Platform — Status do Projeto

**Última atualização:** 2026-03-15
**Branch:** main
**Último commit:** `sprint9` — feat(s9): persistent seed + stable demo data

---

## Estado Atual (validado em 15/03/2026)

| Componente | Status | Detalhe |
|---|---|---|
| Backend testes | ✅ 460 passing | 35 arquivos, zero falhas |
| TypeScript strict | ✅ zero erros | `npx tsc --noEmit` → clean |
| Coverage | ✅ thresholds ok | lines≥70, functions≥70, branches≥60 |
| CI/CD pipeline | ✅ 5 jobs verdes | lint, test, security, trivy, integration |
| Admin UI build | ✅ passando | Next.js 14.2 + Node 18 |
| Admin UI login | ✅ funcional | admin@orga.com / password |
| Dashboard | ✅ dados reais | stats, assistants, audit-logs |
| Migrations | ✅ 034 aplicadas | 011–034 em sequência |
| Docker stack | ✅ 6 serviços | api, admin-ui, db, redis, litellm, presidio |
| ExpirationWorker | ✅ sem erros | migration 034 corrigiu GRANT em platform_admin |
| Sidebar links | ✅ todos corretos | 7 hrefs batem com pages existentes |
| Criar API Key | ✅ funcional | POST /v1/admin/api-keys → key retornada |
| Pipeline governança | ✅ validado | BLOCK 403 + HITL 202 + audit logs com HMAC |
| Fila HITL | ✅ funcional | pending_approvals com reject funcionando |
| LiteLLM real | ✅ Gemini 2.5 Flash | mock removido, respostas reais funcionando |
| Playground UI | ✅ funcional | /playground na sidebar, 3 cenários validados |
| Execução real | ✅ resposta da IA | total_executions=4, total_tokens=967 |
| E2E Playwright | ✅ 5 testes | T01-T05: login, dashboard, assistants, playground, HITL |
| Deploy artifacts | ✅ Sprint 6 | docker-compose.prod.yml, .env.prod.example, deploy/ |
| Demo seed persistente | ✅ Sprint 9 | scripts/seed.sql + seed.sh, idempotente, banco estável entre rebuilds |
| Entrypoint automático | ✅ Sprint 9 | scripts/entrypoint.sh: migrate → seed → npm start (docker-compose) |

---

## Credenciais de Teste

```
Email:    admin@orga.com
Senha:    password
Role:     admin
Org:      Test Org (00000000-0000-0000-0000-000000000001)
```

> ⚠️ `admin@govai.com` / `admin` está **descontinuado**: senha "admin" (4 chars) é
> rejeitada pelo Zod `password.min(8)`. Essa conta existe no seed com
> `requires_password_change: true` e não pode ser usada via `/v1/admin/login`.

Login via curl:
```bash
TOKEN=$(curl -s -X POST http://localhost:3000/v1/admin/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@orga.com","password":"password"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
```

---

## O que foi feito — Remediações P-01 a P-16

| ID | Descrição | Status |
|---|---|---|
| P-01 | RLS Login Bypass corrigido (tabela user_lookup criada) | ✅ |
| P-02 | Cross-Tenant Expiration Worker corrigido (SET ROLE platform_admin) | ✅ |
| P-03 | CI/CD Pipeline criado (.github/workflows/ci-cd.yml) | ✅ |
| P-04 | OPA Rego expandido com OWASP LLM Top 10 (144 testes) | ✅ |
| P-05 | CVE-RAG corrigido (execution.service.ts usa safeMessage) | ✅ |
| P-06 | RAG approvals corrigido + 4 rotas registradas em server.ts | ✅ |
| P-07 | Credencial exposta removida + gitleaks + secret-scanning.yml | ✅ |
| P-08 | Validação Zod em todos os endpoints (src/lib/schemas.ts) | ✅ |
| P-09 | @fastify/helmet instalado e configurado (CSP, HSTS, DENY) | ✅ |
| P-10 | Embedding dimension 768 explícita (src/lib/embedding-config.ts) | ✅ |
| P-11 | api-key-rotation.job.ts criado (BullMQ, cron 0 2 * * *) | ✅ |
| P-12 | Rate limiting granular (login 10/15min, execute 100/1min) | ✅ |
| P-13 | Dockerfile multi-stage + non-root user govai | ✅ |
| P-14 | Coverage gate configurado (lines≥70, functions≥70, branches≥60) | ✅ |
| P-15 | TypeScript strict mode + cobertura expandida (460 testes) | ✅ |
| P-16 | CURSOR.md + AGENTS.md criados (documentação de agentes) | ✅ |

---

## Bugs Corrigidos Pós-Remediação

| Bug | Causa | Fix | Commit |
|---|---|---|---|
| `organizations` endpoint retorna 500 | Coluna `status` não existe na tabela | `'active' AS status` nas 2 queries | `8f82763` |
| ExpirationWorker `permission denied` | `platform_admin` sem GRANT na tabela | Migration 034: `GRANT SELECT, UPDATE ON pending_approvals TO platform_admin` | `e47c187` |
| Admin UI build falha (Node 18) | `next: 16.1.6` exige Node ≥ 20.9.0 | Downgrade para `next: ^14.2.0` + React 18 | `818d1f2` |
| `next.config.ts` não suportado (Next 14) | Next 14 não suporta TypeScript config | Convertido para `next.config.mjs` | `818d1f2` |
| `toast({...})` TS2345 em compliance/page.tsx | Assinatura errada: objeto vs `(string, type)` | Corrigidas 5 chamadas | `818d1f2` |
| `@tailwindcss/oxide-darwin-arm64` ausente | Bug de optional deps do npm | Instalado explicitamente (removido do package.json depois) | `818d1f2` / `46cecbe` |

---

## Admin UI — Estado das Telas (validado localmente)

| Tela | URL | Estado | Observações |
|---|---|---|---|
| Dashboard | `/` | ✅ dados reais | Stats, gráficos Recharts, usage_history |
| Login | `/login` | ✅ funcional | JWT + localStorage |
| API Keys | `/api-keys` | ✅ funcional | CRUD completo |
| Approvals | `/approvals` | ✅ funcional | Fila HITL, approve/reject |
| Assistants | `/assistants` | ✅ dados reais | 1 assistente seed |
| Compliance | `/compliance` | ✅ funcional | Toggle telemetry/PII Strip por org |
| Audit Logs | `/logs` | ✅ funcional | Paginação, 2 logs seed |
| Reports | `/reports` | ✅ funcional | Download CSV/PDF |

> Telas testadas com token de `admin@orga.com` via `Authorization: Bearer`.
> O Docker container `admin-ui` sobe na porta :3001.

---

## Migrations em Disco

| Arquivo | Descrição |
|---|---|
| 011–019 | Schema base, RLS, policies, SSO, finops |
| 020 | Expiration worker (RLS bypass — substituído pelo P-02) |
| 021 | Fix RLS login (user_lookup) |
| 022–023 | Grants encrypted runs, fix partition ownership |
| 024 | Cria role `platform_admin` com BYPASSRLS |
| 025 | Telemetry consent |
| 026 | Audit compliance indexes |
| 027 | Key rotation tracking |
| 028 | User lookup |
| 029 | Expiration worker role grant (GRANT platform_admin TO govai_app) |
| 030 | Extend audit action constraint |
| 031 | API key revocation |
| 032 | Explicit vector dimension |
| 033 | Tabela schema_migrations (tracking) |
| **034** | **GRANT SELECT, UPDATE ON pending_approvals TO platform_admin (fix ExpirationWorker)** |

---

## Sprint 2 — Resultados (15/03/2026)

### Fluxo testado end-to-end via API

| Teste | Endpoint | Resultado | HTTP |
|---|---|---|---|
| Criar assistente | `POST /v1/admin/assistants` | ✅ ID retornado, status `draft` | 201 |
| Criar versão com policy | `POST /v1/admin/assistants/:id/versions` | ✅ `draft_version_id` gerado | 201 |
| Criar API Key | `POST /v1/admin/api-keys` | ✅ chave `sk-govai-*` retornada | 201 |
| Execução BLOQUEADA | `POST /v1/execute/:id` + prompt injection | ✅ LLM01 detectado antes do LLM | 403 |
| Execução HITL | `POST /v1/execute/:id` + "transferencia bancaria" | ✅ `PENDING_APPROVAL` criado | 202 |
| Reject HITL | `POST /v1/admin/approvals/:id/reject` | ✅ status atualizado para `rejected` | 200 |
| Audit logs | `GET /v1/admin/audit-logs` | ✅ POLICY_VIOLATION + PENDING_APPROVAL com HMAC | 200 |
| Dashboard stats | `GET /v1/admin/stats` | ✅ `total_violations: 2` reflete execuções | 200 |

### Sprint 4 — LiteLLM com Gemini Real (15/03/2026)

| Teste | Resultado |
|---|---|
| LiteLLM direto (`POST /chat/completions`) | ✅ Gemini 2.5 Flash responde |
| Execução via GovAI (`POST /v1/execute/:id`) | ✅ Resposta real da IA retornada |
| Resposta normal — "o que é governança de IA?" | ✅ HTTP 200 + texto em PT-BR |
| Bloqueio OPA — prompt injection | ✅ HTTP 403 + violation POLICY_VIOLATION |
| HITL — "transferência bancária" | ✅ HTTP 202 + PENDING_APPROVAL criado |
| Stats após execuções | ✅ total_executions=4, total_tokens=967 |

**Nota de modelo:** `gemini-1.5-flash` descontinuado. `gemini-2.0-flash` sem free tier neste
projeto (limit: 0). `gemini-2.5-flash` é o modelo funcional com a GEMINI_API_KEY atual.
O `model_name` no LiteLLM mantém `gemini/gemini-1.5-flash` para compatibilidade com AI_MODEL no .env.

---

## Sprint 6 — Deploy de Produção (15/03/2026)

| Arquivo | Descrição |
|---|---|
| `docker-compose.prod.yml` | Stack completo sem port bindings de DB/Redis, rede `govai-prod-net`, resource limits, volumes nomeados prod |
| `.env.prod.example` | Template com todos os secrets de produção documentados e instruções de geração |
| `deploy/vps.sh` | Script de deploy Ubuntu 22.04: deps check, git update, migrations, up, health check |
| `deploy/README.md` | Guia para 4 plataformas: VPS, AWS ECS+RDS, Google Cloud Run, Render.com |
| `deploy/nginx.conf` | Reverse proxy com HSTS, CSP, rate limiting por zona, SSL TLS 1.2/1.3, gzip |
| `.github/workflows/ci-cd.yml` | +Job 6 deploy: SSH para VPS em push main, guardado por `secrets.DEPLOY_SSH_KEY != ''` |

---

## Próximos Passos Sugeridos

### Alta prioridade
1. **Conflito immutable trigger vs approve route:**
   - Migration que cria `prevent_version_mutation()` precisa de exceção para `status = 'published'`
   - OU a rota de aprovação deve ser reimplementada sem UPDATE (INSERT novo estado + referência)

2. **Migration 034 no ambiente de CI:**
   - A migration foi aplicada manualmente ao banco local
   - O CI precisa rodar `scripts/migrate.sh` para aplicar 033 e 034 ao banco de integração

3. **`security.tenant-isolation.test.ts` no CI:**
   - 5/6 testes falhando porque usam `postgres` superuser (bypassa RLS)
   - Padrão correto: `SET ROLE govai_app` + `set_config('app.current_org_id', ...)` antes de cada assertion

4. **HITL approve com LLM real:**
   - `POST /v1/admin/approvals/:id/approve` re-executa o assistente via LiteLLM
   - Com Gemini real configurado, testar fluxo completo de aprovação HITL

### Média prioridade
4. **Rate limit em `change-password`** — endpoint POST sem rateLimit (auditoria detectou)
5. **Zod em `telemetry-consent`** — validação manual com `typeof body.consent !== 'boolean'` em vez de safeParse
6. **DT-P04-A:** LLM02 scan de output do LLM antes de retornar ao usuário
7. **DT-P04-B:** Indirect Prompt Injection via RAG (conteúdo de knowledge base como vetor)
8. **DT-P02:** pgaudit para capturar SET ROLE nos logs do PostgreSQL

### Baixa prioridade
9. Testes unitários para admin-ui (zero cobertura atualmente)
10. `scripts/bootstrap.sh` — referência inconsistente a `$DB_PASSWORD` vs `$POSTGRES_PASSWORD`

---

## Regras Críticas de Segurança (NUNCA violar)

- **Multi-tenant:** toda query deve ter `org_id` no contexto via RLS (`set_config`)
- **Cross-tenant:** `SET ROLE platform_admin` + `RESET ROLE` em bloco `finally`
- **RAG/LLM:** usar `safeMessage`, nunca `message` raw
- **Secrets:** `process.env.VAR_NAME!` ou com `:?`, nunca fallback hardcoded
- **Zod:** `safeParse` em todos os endpoints antes de processar input
- **SQL:** queries parametrizadas (`$1`, `$2`...), nunca interpolação de string

---

## Comandos Essenciais

```bash
# Subir ambiente completo
docker compose up -d

# Backend — testes
npx vitest run
npx vitest run --coverage

# Backend — lint TypeScript
npx tsc --noEmit

# Admin UI — build
cd admin-ui && npm run build

# Admin UI — dev
cd admin-ui && NEXT_PUBLIC_API_URL=http://localhost:3000 npm run dev

# Aplicar migrations
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/govai_platform \
  bash scripts/migrate.sh

# Seed de demo (idempotente — seguro rodar múltiplas vezes)
bash scripts/seed.sh

# Login de teste
curl -s -X POST http://localhost:3000/v1/admin/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@orga.com","password":"password"}'
```
