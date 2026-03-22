# GovAI Platform — Guia de Operação

## Credenciais de acesso (ambiente de desenvolvimento)

| Recurso | URL | Credencial |
|---------|-----|-----------|
| Admin UI | http://localhost:3001 | admin@orga.com / GovAI2026@Admin |
| API REST | http://localhost:3000 | via Bearer token (login acima) |
| LiteLLM Dashboard | http://localhost:4000/ui | valor de `LITELLM_KEY` no `.env` |
| PostgreSQL | localhost:5432 | postgres / valor de `DB_PASSWORD` no `.env` |
| Redis | localhost:6379 | valor de `REDIS_PASSWORD` no `.env` |

---

## Serviços e portas

| Serviço | Porta | Container | Health |
|---------|-------|-----------|--------|
| API Fastify | 3000 | `govaigrcplatform-api-1` | `GET /health` |
| Admin UI Next.js | 3001 | `govaigrcplatform-admin-ui-1` | `GET /` |
| LiteLLM Proxy | 4000 | `govaigrcplatform-litellm-1` | `GET /health` |
| PostgreSQL | 5432 | `govaigrcplatform-database-1` | `pg_isready` |
| Redis | 6379 | `govaigrcplatform-redis-1` | `redis-cli ping` |
| Presidio NLP | 5001 | `govaigrcplatform-presidio-1` | `GET /health` |

---

## Comandos operacionais essenciais

```bash
# Subir stack completa
docker compose up -d

# Ver status de todos os serviços
docker compose ps

# Ver logs em tempo real de um serviço
docker logs govaigrcplatform-api-1 --tail=50 -f

# Aplicar migrations pendentes
./scripts/migrate.sh

# Validar todas as migrations em banco limpo (pré-deploy)
./scripts/test-migrations-clean.sh

# Rodar suite padrão (542 testes, sem banco)
npx vitest run

# Rodar suite completa com banco (542 + 29 garantias DB real)
DATABASE_URL=postgresql://postgres:GovAI2026@Admin@localhost:5432/govai_platform npx vitest run

# Health check da API
curl http://localhost:3000/health | python3 -m json.tool

# Recriar container com variáveis de ambiente atualizadas
docker compose up -d --no-deps --force-recreate api

# Ver variáveis de ambiente injetadas em um container
docker exec govaigrcplatform-api-1 printenv | grep -E "AI_MODEL|JWT|SIGNING"
```

---

## Provider LLM atual

| Campo | Valor |
|-------|-------|
| **Principal** | Groq `llama-3.3-70b-versatile` |
| **Fallback** | Gemini `gemini-2.5-flash` |
| **Limite Groq** | 14.400 req/dia (free tier) |
| **Monitoramento** | http://localhost:4000/ui |
| **Variável** | `AI_MODEL=groq/llama-3.3-70b-versatile` em `.env` |

**Trocar de provider:**
```bash
# 1. Editar .env
AI_MODEL=groq/llama-3.3-70b-versatile   # ou gemini/gemini-2.5-flash

# 2. Recriar container api (restart não recarrega .env)
docker compose up -d --no-deps --force-recreate api
```

---

## Migrations

Todas as migrations são numeradas (`011_*.sql` … `045_*.sql`) e aplicadas em ordem pelo `scripts/migrate.sh`. Total: **35 migrations** (v1.1.1).

```bash
# Ver migrations aplicadas
docker exec govaigrcplatform-database-1 psql -U postgres -d govai_platform \
  -c "SELECT name, applied_at FROM _migrations ORDER BY applied_at;"

# Forçar re-aplicação de uma migration específica (sem registro em _migrations)
docker exec -i govaigrcplatform-database-1 psql -U postgres -d govai_platform \
  -v ON_ERROR_STOP=1 < 045_catalog_registry.sql
```

---

## Seed (ambiente de desenvolvimento)

O seed é idempotente e pode ser re-executado sem risco.

```bash
# Aplicar seed (recria admin com a senha canônica)
docker exec -i govaigrcplatform-database-1 psql -U postgres -d govai_platform \
  < scripts/seed.sql

# A senha do admin é definida em scripts/seed.sql (bcrypt cost 12)
# Email:  admin@orga.com
# Senha:  GovAI2026@Admin
```

---

## Runbooks

Para procedimentos de resposta a incidentes, ver [docs/RUNBOOKS.md](./RUNBOOKS.md):

| Runbook | Cenário |
|---------|---------|
| RB-01 | Falha no provider LLM (502 em /v1/execute) |
| RB-02 | Admin não consegue fazer login |
| RB-03 | Fila HITL congestionada |
| RB-04 | Container da API em loop de restart |
| RB-05 | Migrations falhando no deploy |
