# GovAI Platform — PROJECT STATE
## Snapshot de Baseline Local — Sprint 1

**Data/Hora:** 2026-03-10T20:34:46-03:00
**Branch:** main
**Último Commit:** 7a6311e — fix: padronização de tags Docker (lowercase) e estabilização final E2E

---

## Status da Sprint 1

### Etapas concluídas no repositório local

| Etapa | Descrição | Status |
|---|---|---|
| 1.1 | Remoção de `govai_ci_pass` hardcoded do CI/CD | ✅ Concluída e comprovada |
| 1.2 | Disciplina de secrets e `.env` (sourcing opcional) | ✅ Concluída e comprovada |
| 1.3 | Separação de ambientes dev/test/demo/prod | ✅ Concluída e comprovada |
| 1.4 | Remoção de mocks OIDC do runtime produtivo | ✅ Concluída e comprovada |
| 1.5 | Reconciliação documental com evidência real | ✅ Concluída e comprovada |

### Arquivos modificados nesta sprint (git status)
- `.env.example` — DATABASE_URL interpolação corrigida
- `.github/workflows/ci-cd.yml` — govai_ci_pass removido, Secrets injetados
- `README.md` — Claims inflados reclassificados
- `docker-compose.yml` — NODE_ENV=development explícito
- `docs/ENTERPRISE_AUDIT_REPORT_2026.md` — RESOLVIDO → Histórico, seção 1 corrigida
- `docs/manifesto_seguranca.md` — Disclaimer de intenção arquitetural adicionado
- `run_e2e_tests.sh` — sourcing de .env tornado opcional com fail-fast
- `scripts/demo-seed.sh` — sourcing de .env tornado opcional com fail-fast
- `src/lib/auth-oidc.ts` — dummy_client_id_dev removido, isMockTokenSet flag introduzido
- `src/server.ts` — audit bypass com guard NODE_ENV !== 'production'

---

## Pendências Operacionais (não bloqueiam o código, bloqueiam o aceite formal)

1. **CRÍTICO:** Configurar GitHub Secrets no repositório remoto:
   - `POSTGRES_PASSWORD`
   - `DB_APP_PASSWORD`
   - `JWT_SECRET`
   - `SIGNING_SECRET`
2. **CRÍTICO:** Executar o pipeline `e2e-security` no GitHub Actions e confirmar sucesso.
3. **MÉDIO:** Adicionar testes unitários para os 3 caminhos do decision tree OIDC (`auth-oidc.ts`).
4. **BAIXO:** `scripts/bootstrap-db.sh` — duplicata com `$DB_PASSWORD` inconsistente com o padrão `$POSTGRES_PASSWORD`.

---

## O que NÃO está neste snapshot
- `.env` (segredos locais — nunca versionado)
- `node_modules/` (dependências — instalar com `npm install`)
- `.git/` (histórico Git — usar repositório original)
- `dist/`, `.next/`, `coverage/` (artefatos de build)

## Como usar este snapshot
```bash
# 1. Descompactar
unzip govai-sprint1-local-baseline-20260310-2034.zip -d GovAIPlatform/

# 2. Instalar dependências
cd GovAIPlatform && npm install

# 3. Configurar ambiente local
bash scripts/bootstrap.sh

# 4. Subir serviços
docker compose up -d
```
