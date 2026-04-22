<!-- GENERATED — bash scripts/audit_project_state.sh — 2026-04-06 20:59 UTC -->
<!-- Não editar manualmente. Regenerar após cada sprint. -->

# GovAI Platform

**Enterprise AI Governance Gateway** — controle, governança e conformidade para LLMs corporativos.

OPA Policy Engine · DLP · HITL · Multi-tenant RLS · RAG · Shield Shadow-AI Detection

---

## O que é

GovAI Platform é um gateway de governança para IA corporativa que intercepta _todas_ as requisições
aos LLMs antes de chegarem ao provedor. Pipeline determinístico: DLP semântico (Presidio) →
OPA WASM (OWASP LLM Top 10) → HITL → audit log HMAC-signed.

Multi-tenant com PostgreSQL RLS. Admin UI em Next.js 14. Shield detecta shadow-AI usage.

---

## Domínios implementados

| Domínio | Status | Módulo principal |
|---------|--------|-----------------|
| Gateway Core | ✅ | `src/lib/governance.ts` |
| Policy Snapshots | ✅ | `src/lib/policy-snapshots.ts` |
| Evidence | ✅ | `src/lib/evidence.ts` |
| Catalog | ✅ | `src/lib/catalog.ts` |
| Consultant Plane | ✅ | `src/lib/consultant-auth.ts` |
| Shield (shadow-AI) | ✅ | `src/lib/shield.ts` (facade → 5 services) |
| Architect | ✅ | `src/lib/architect.ts` + `src/lib/architect-delegation.ts` |

---

## Migrations

- **Total:** 48
- **Intervalo:** 011–058 (excluindo 050)

---

## Testes

| Suíte | Arquivos | Testes |
|-------|----------|--------|
| Padrão (sem DATABASE\_URL) | 51 | 574 |
| Integração (requer DATABASE\_URL) | 16 | — |
| **Total** | **67** | — |

```bash
DATABASE_URL='' npx vitest run  # suíte padrão
```

---

## Como rodar

```bash
npm install && cp .env.example .env
docker compose --profile dev up -d
bash scripts/migrate.sh
npm run build && npm start
# Admin UI
cd admin-ui && npm ci && npm run build && npm start
```

Para habilitar o runtime oficial do Claude Code (aparece no selector de
Runtime do chat), defina `ANTHROPIC_API_KEY` no `.env` e suba o stack
completo:

```bash
bash scripts/dev-up-full.sh
# ou, equivalente:
docker compose --profile dev --profile official up -d
```

---

## Regenerar docs

```bash
bash scripts/audit_project_state.sh
```
