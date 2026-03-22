# GovAI GRC Platform — Manifesto de Auditoria

**Versão:** v1.1.0
**Data de geração:** 2026-03-21
**Commit HEAD:** d732c91 (feat(sprint-a): Release Engineering baseline)
**Branch:** main
**Repositório:** https://github.com/mauriciodesouzaads/GovAIPlatform
**Total de arquivos rastreados:** 218
**Total de testes:** 516 passing (45 test files)

---

## Conteúdo deste pacote

Este ZIP foi gerado via `git archive HEAD` — contém exclusivamente os arquivos
rastreados pelo Git no commit `d732c91`. Nenhum segredo, credencial ou arquivo
`.env` com valores reais está incluído.

### Código-fonte backend (`src/`)
| Caminho | Descrição |
|---------|-----------|
| `src/server.ts` | Entrypoint Fastify — roteamento e middlewares |
| `src/routes/admin.routes.ts` | Rotas de administração tenant (login, usuários, API keys) |
| `src/routes/approvals.routes.ts` | Fila HITL — aprovação humana de execuções de alto risco |
| `src/routes/assistants.routes.ts` | CRUD de assistentes + fluxo de publicação |
| `src/routes/oidc.routes.ts` | SSO OIDC — Microsoft Entra ID e Okta |
| `src/lib/schemas.ts` | Validação Zod (StrongPasswordSchema, etc.) |
| `src/lib/auth-oidc.ts` | Autenticação OIDC — state, PKCE, troca de código |
| `src/lib/rag.ts` | RAG pipeline com isolamento de tenant |
| `src/services/execution.service.ts` | Execução de LLM com OPA policy enforcement |

### Código-fonte frontend (`admin-ui/src/`)
| Caminho | Descrição |
|---------|-----------|
| `admin-ui/src/app/login/` | Login local com clear de campos |
| `admin-ui/src/app/approvals/` | Dashboard de aprovações HITL |
| `admin-ui/src/app/assistants/` | Gestão de assistentes |
| `admin-ui/src/app/compliance/` | Painel de conformidade |
| `admin-ui/src/app/logs/` | Audit logs em tempo real |
| `admin-ui/src/components/AuthProvider.tsx` | Gestão de sessão JWT |
| `admin-ui/src/lib/api.ts` | Client HTTP para API |
| `admin-ui/src/lib/auth-storage.ts` | Armazenamento de token (Bearer-only, sem cookie) |

### Banco de dados
| Arquivo | Descrição |
|---------|-----------|
| `init.sql` | Schema base — extensões, tabelas, RLS policies |
| `011_*.sql` — `041_*.sql` | 31 migrations numeradas (nov 2025 → mar 2026) |
| `scripts/seed.sql` | Seed idempotente — org demo, admin local, assistente demo |
| `scripts/migrate.sh` | Script de aplicação de migrations (CI/CD e manual) |
| `scripts/test-migrations-clean.sh` | Validação de todas as migrations em banco limpo |

### Segurança e conformidade
| Arquivo | Descrição |
|---------|-----------|
| `.gitleaks.toml` | Configuração de secret scanning (GitLeaks) |
| `.trivyignore` | Exceções conhecidas para scan de vulnerabilidades (Trivy) |
| `.github/workflows/secret-scanning.yml` | Pipeline de detecção de segredos |
| `docs/PRODUCTION_HARD_GATES.md` | 9 hard gates de produção com evidências |

### CI/CD
| Arquivo | Descrição |
|---------|-----------|
| `.github/workflows/ci-cd.yml` | Pipeline: lint+build (frontend+backend) → unit tests → integration tests → security scan → Docker build → deploy VPS |
| `.github/SECRETS.md` | Documentação de secrets necessários |

### Configuração de infraestrutura
| Arquivo | Descrição |
|---------|-----------|
| `docker-compose.yml` | Stack completa de desenvolvimento |
| `docker-compose.prod.yml` | Stack de produção |
| `Dockerfile` | Imagem multi-stage (build → production) |
| `litellm-config.yaml` | Proxy LLM — Groq (principal) + Gemini (fallback) |
| `nginx/` | Configuração nginx (proxy reverso) |
| `observability/` | Prometheus, Grafana, AlertManager |
| `presidio/` | Análise NLP para DLP (Presidio) |

### Documentação
| Arquivo | Descrição |
|---------|-----------|
| `README.md` | Visão geral, setup, arquitetura |
| `API.md` | Referência da API REST |
| `CHANGELOG.md` | Histórico de versões (até v1.0.0) |
| `CHANGELOG_AUDIT_FIXES_2026-03-20.md` | Correções de segurança (R1 — RBAC, RLS, API keys) |
| `TECHNICAL_REPORT.md` | Relatório técnico detalhado |
| `docs/RUNBOOKS.md` | 5 runbooks operacionais |
| `docs/OPERATIONS.md` | Guia completo de operação |
| `docs/PRODUCTION_HARD_GATES.md` | Evidências de produção |

### Testes (`src/__tests__/`)
| Suite | Escopo |
|-------|--------|
| `security.login-isolation.test.ts` | Cross-tenant login isolation (P-01) |
| `security.tenant-isolation.test.ts` | RLS row-level security (integração com DB real) |
| `security.authorization.test.ts` | RBAC — requireTenantRole / requirePlatformAdmin |
| `session.model.test.ts` | Bearer-only JWT, sem cookie (GA-012) |
| `auth.reset.test.ts` | First-login password reset (StrongPasswordSchema) |
| `oidc.unified.test.ts` | OIDC Microsoft Entra + Okta |
| `approvals.contract.test.ts` | Fila HITL — contratos de API |
| `assistants.contract.test.ts` | Publish flow — eventos imutáveis |
| `rag.isolation.test.ts` | RAG com isolamento de tenant |
| `audit-compliance.test.ts` | Audit logs — imutabilidade e conformidade |

---

## O que NÃO está incluído (e por quê)

| Excluído | Motivo |
|----------|--------|
| `.env` | Contém credenciais reais de desenvolvimento |
| `.env.save` | Backup de credenciais reais |
| `node_modules/` | Dependências de runtime — instaladas via `npm ci` |
| `admin-ui/node_modules/` | Idem |
| `admin-ui/.next/` | Build artefato — gerado via `npm run build` |
| `dist/` | Compilado TypeScript — gerado via `npm run build` |
| `coverage/` | Relatório de cobertura — gerado via `npx vitest run --coverage` |
| `.git/` | Histórico interno do Git |
| `.claude/` | Artefatos internos do assistente de desenvolvimento |

---

## Verificação de integridade

```bash
# Reproduzir o build a partir deste pacote
npm ci && npm run build

# Reproduzir testes
npx vitest run   # deve retornar: 516 passed (45 files)

# Validar migrations em banco limpo
./scripts/test-migrations-clean.sh   # deve retornar: 31 migrations aplicadas

# Health check (com stack rodando)
curl http://localhost:3000/health
```

---

## Controles de segurança implementados

| Controle | Implementação | Migration |
|----------|--------------|-----------|
| Cross-tenant isolation (RLS) | `app.current_org_id` via `set_config` | 019, 021 |
| Login sem bypass RLS | `user_lookup` table (no RLS) | 028 |
| API key sem bypass RLS | `api_key_lookup` table (no RLS) | 028, 036 |
| Bearer-only session | JWT sem cookie, sem query string | GA-012 |
| StrongPasswordSchema | Zod — mín 12 chars, maiúscula, número, especial | schemas.ts |
| First-login password reset | `requires_password_change` flag | 017 |
| Imutabilidade de audit logs | Trigger `trg_immutable_audit` | 019 |
| Publicação de assistentes | `assistant_publication_events` imutável | 038 |
| RBAC dual | `requireTenantRole` + `requirePlatformAdmin` separados | — |
| OPA policy enforcement | Prompt injection → 403; high-risk → 202 PENDING | — |
| Rate limiting login | Redis + express-rate-limit | — |
| Secret scanning CI | GitLeaks + Trivy | secret-scanning.yml |
