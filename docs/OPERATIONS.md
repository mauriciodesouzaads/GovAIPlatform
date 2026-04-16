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

# Suíte padrão (sem banco — conta atual: bash scripts/audit_project_state.sh --check)
DATABASE_URL='' npx vitest run

# Suíte de integração com banco real (requerem DATABASE_URL)
DATABASE_URL=postgresql://postgres:<DB_PASSWORD>@localhost:5432/govai_platform npx vitest run

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

Todas as migrations são numeradas e aplicadas em ordem pelo `scripts/migrate.sh`. Para contagem atual: `bash scripts/audit_project_state.sh --check`.

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

---

## Variáveis de ambiente — precauções

### ANTHROPIC_API_KEY override pelo shell

Se a variável `ANTHROPIC_API_KEY` estiver exportada como vazia no shell (por exemplo,
porque o terminal foi iniciado com ela definida como string vazia), o `docker compose`
usará esse valor vazio em vez do conteúdo do `.env`. Isso resulta em chave ausente
dentro do container LiteLLM e falha em chamadas ao Claude.

**Diagnóstico:**

```bash
# Verificar se a variável está vazia no shell
echo "KEY=[${ANTHROPIC_API_KEY}]"

# Confirmar o valor que o compose usaria
docker compose config | grep ANTHROPIC_API_KEY
```

**Correção:**

```bash
# Opção 1: desexportar antes de subir os containers
unset ANTHROPIC_API_KEY && docker compose up -d

# Opção 2: passar explicitamente do .env
ANTHROPIC_API_KEY=$(grep '^ANTHROPIC_API_KEY=' .env \
  | cut -d= -f2-) docker compose up -d litellm
```

**Verificação:**

```bash
docker compose exec litellm sh -c 'echo "KEY=[${ANTHROPIC_API_KEY:0:20}]"'
# Deve exibir: KEY=[sk-ant-api03-...]
```

---

## Segurança do Chat de Usuário Final

### API Key no URL

O link governado do Catálogo inclui a API key como parâmetro
de URL (`?key=sk-govai-...`). Isso é suficiente para
desenvolvimento e demos internas.

Para produção com dados sensíveis, adote estas práticas:

1. **Crie API keys de escopo limitado** para chat de usuário
   final — separadas das keys usadas por integrações backend.
   Revogue e rotacione periodicamente via /v1/admin/api-keys.

2. **Use HTTPS obrigatório** — sem HTTPS, a key fica exposta
   em logs de proxy e de CDN. O nginx.conf.template do projeto
   já configura TLS; nunca exponha o chat via HTTP em produção.

3. **Considere um proxy de sessão** para produção de alta
   segurança: o frontend obtém um token de sessão efêmero
   (30 min) via endpoint autenticado, em vez de usar a key
   diretamente na URL. Esta feature está no roadmap.

4. **Monitore uso por key** via /v1/admin/audit-logs —
   filtre por api_key_id para detectar uso anômalo.

---

## Running the Official Claude Code Runner (FASE 9)

The Official runtime (`claude_code_official`) uses the real Anthropic
Claude Code CLI. To enable it:

1. **Export a valid ANTHROPIC_API_KEY:**
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   ```

2. **Start the sidecar container:**
   ```bash
   docker compose --profile official up -d claude-code-runner
   ```

3. **Verify availability:**
   ```bash
   curl -s http://localhost:3000/v1/admin/runtimes -H "Authorization: Bearer $TOKEN" \
     -H "x-org-id: $ORG" | jq '.[] | select(.slug=="claude_code_official")'
   ```
   Should show `available: true`.

4. **Run the E2E validation:**
   ```bash
   ANTHROPIC_API_KEY=sk-ant-... bash tests/integration/test-claude-code-official-e2e.sh
   ```

If ANTHROPIC_API_KEY has no credits or the CLI changes its output format,
the E2E test will fail with a clear message showing what's missing.

---

## Multi-Replica Deployments (FASE 9)

For k8s or any deployment with >1 API replica, set:

```yaml
STREAM_REGISTRY_MODE: distributed
```

This enables Redis pub/sub for the architect approval bridge so that
cancel/respond messages reach the replica that owns the live gRPC stream,
regardless of which replica processed the HTTP request or BullMQ job.

Without this flag, approvals and cancellations only work when the BullMQ
worker that picks up the job is the same process that owns the stream
(which is always true in single-instance dev but never guaranteed in
multi-replica production).

See `docs/ADR-012-distributed-stream-registry.md` for the full design.
