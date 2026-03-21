# GovAI Platform — Runbooks Operacionais

## RB-01 — Falha no provider LLM (502 em /v1/execute)

**Sintoma:** endpoint `/v1/execute` retorna HTTP 502

**Diagnóstico:**
```bash
curl http://localhost:4000/health
docker logs govaigrcplatform-litellm-1 --tail=20
```

**Causas comuns e ações:**

| Causa | Diagnóstico | Ação |
|-------|------------|------|
| Rate limit Groq | Log: `429 Too Many Requests` | Aguardar 60s ou verificar console.groq.com/usage |
| Key Groq inválida | Log: `401 Unauthorized` | Atualizar `GROQ_API_KEY` no `.env` + `docker compose up -d --force-recreate litellm` |
| Container LiteLLM caído | `docker compose ps` mostra `Exit` | `docker compose up -d litellm` |
| AI_MODEL inválido | Log: `No model found` | Verificar `AI_MODEL` no `.env` e modelo em `litellm-config.yaml` |

**Nota:** após atualizar variáveis no `.env`, usar `--force-recreate` — `restart` não recarrega o `.env`.

---

## RB-02 — Admin não consegue fazer login

**Sintoma:** HTTP 401 ou 500 em `/v1/admin/login`

**Diagnóstico:**
```bash
docker logs govaigrcplatform-api-1 --tail=20
docker exec govaigrcplatform-database-1 psql -U postgres -d govai_platform \
  -c "SELECT email, requires_password_change, status FROM users WHERE email='admin@orga.com';"
```

**Ação — resetar senha:**
```bash
# 1. Gerar hash bcrypt (use aspas simples para evitar problemas com @ no zsh)
docker exec govaigrcplatform-api-1 node -e \
  'require("bcrypt").hash("NovaSenha123Abc",12).then(console.log)'

# 2. Atualizar banco com o hash gerado
docker exec govaigrcplatform-database-1 psql -U postgres -d govai_platform \
  -c "UPDATE users SET password_hash='<HASH>', requires_password_change=false WHERE email='admin@orga.com';"

# 3. Limpar rate limit Redis (se login estava bloqueado por tentativas)
REDIS_PASS=$(grep '^REDIS_PASSWORD=' .env | cut -d= -f2)
docker exec govaigrcplatform-redis-1 redis-cli -a "$REDIS_PASS" \
  KEYS '*login*' | xargs -r docker exec -i govaigrcplatform-redis-1 redis-cli -a "$REDIS_PASS" DEL

# 4. Reiniciar API (opcional — apenas se o container estiver em estado degradado)
docker compose restart api
```

---

## RB-03 — Fila HITL congestionada

**Sintoma:** aprovações acumulando, usuários recebendo HTTP 202 mas sem resolução

**Diagnóstico:**
```bash
# Obter token admin
TOKEN=$(python3 -c "
import urllib.request, json
req = urllib.request.Request('http://localhost:3000/v1/admin/login',
  json.dumps({'email':'admin@orga.com','password':'GovAI2026@Admin'}).encode(),
  {'Content-Type':'application/json'})
print(json.loads(urllib.request.urlopen(req).read())['token'])
")

curl http://localhost:3000/v1/admin/approvals \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

**Ações:**
1. Revisar e processar manualmente em `http://localhost:3001/approvals`
2. Se worker da API estiver travado: `docker compose restart api`
3. Verificar Redis:
   ```bash
   REDIS_PASS=$(grep '^REDIS_PASSWORD=' .env | cut -d= -f2)
   docker exec govaigrcplatform-redis-1 redis-cli -a "$REDIS_PASS" DBSIZE
   ```
4. Approvals expiradas são limpas automaticamente pelo expiration worker (cron interno)

---

## RB-04 — Container da API em loop de restart

**Sintoma:** `docker compose ps` mostra `api` em `Restarting`

**Diagnóstico:**
```bash
docker logs govaigrcplatform-api-1 --tail=50
```

**Causas comuns:**

| Causa | Sintoma no log | Ação |
|-------|---------------|------|
| Variável de ambiente ausente | `Error: JWT_SECRET must be set` | Verificar `.env` e `docker compose up -d --force-recreate api` |
| Migration não aplicada | `relation "xxx" does not exist` | `./scripts/migrate.sh` |
| Porta 3000 em uso | `EADDRINUSE: address already in use` | `lsof -i :3000` e matar processo conflitante |
| DATABASE_URL inválida | `ECONNREFUSED` | Verificar se container `database` está healthy: `docker compose ps` |

---

## RB-05 — Migrations falhando no deploy

**Sintoma:** `./scripts/migrate.sh` retorna erro

**Diagnóstico:**
```bash
# Ver últimas migrations aplicadas
docker exec govaigrcplatform-database-1 psql -U postgres -d govai_platform \
  -c "SELECT name, applied_at FROM _migrations ORDER BY applied_at DESC LIMIT 5;"

# Verificar qual migration falhou (aplicar com verbose)
docker exec -i govaigrcplatform-database-1 psql -U postgres -d govai_platform \
  -v ON_ERROR_STOP=1 < <migration_file>.sql
```

**Ação — aplicar migration individualmente:**
```bash
# Exemplo: aplicar 041_runtime_and_release_hardening.sql
docker exec -i govaigrcplatform-database-1 psql -U postgres -d govai_platform \
  -v ON_ERROR_STOP=1 < 041_runtime_and_release_hardening.sql
```

**Validar migrations em banco limpo (antes de deploy):**
```bash
./scripts/test-migrations-clean.sh
```
