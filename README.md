<!-- GENERATED — bash scripts/audit_project_state.sh — 2026-03-28 05:41 UTC -->
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
| Architect | ✗ | não implementado |

---

## Migrations

- **Total:** 47
- **Intervalo:** 011–057 (excluindo 050)

---

## Testes

| Suíte | Arquivos | Testes |
|-------|----------|--------|
| Padrão (sem DATABASE\_URL) | 50 | 568 |
| Integração (requer DATABASE\_URL) | 16 | — |
| **Total** | **66** | — |

```bash
DATABASE_URL='' npx vitest run  # suíte padrão
```

---

## Como rodar

```bash
npm install && cp .env.example .env
docker compose up -d
bash scripts/migrate.sh
npm run build && npm start
# Admin UI
cd admin-ui && npm ci && npm run build && npm start
```

---

## Regenerar docs

```bash
bash scripts/audit_project_state.sh
```
