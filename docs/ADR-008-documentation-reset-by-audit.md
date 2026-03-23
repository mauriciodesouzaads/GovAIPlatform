# ADR-008 — Documentation Reset by Audit

**Status:** Accepted
**Sprint:** S3 — Shield Enterprise Hardening
**Data:** 2026-03-22

---

## Contexto

O projeto acumulou vários documentos de estado voláteis criados manualmente durante sprints anteriores:

- `PROJECT_STATUS.md` — contagens manuais que desatualizavam a cada commit
- `PROJECT_STATE.md` — duplicava informações do README
- `TECHNICAL_REPORT.md` — relatório ponto-a-ponto sem versionamento canônico
- `AUDIT_MANIFEST.md` — lista de arquivos gerada manualmente
- `CLAUDE_CODE_HANDOFF_2026-03-20.md` — handoff de sessão específico
- `CHANGELOG_AUDIT_FIXES_2026-03-20.md` — log de fix de auditoria

Além disso, os docs canônicos (`README.md`, `docs/TEST_MANIFEST.md`, `docs/OPERATIONS.md`) tinham números divergentes entre si por serem atualizados manualmente a cada sprint.

## Decisão

**Fonte única da verdade: `bash scripts/audit_project_state.sh`**

O script lê o repositório real e produz números factuais:

1. Contagem de migrations via `scripts/migrate.sh` (sem dedução manual)
2. Contagem de arquivos de teste via `find src/__tests__`
3. Separação padrão/integração via `vitest.config.ts` (`integrationTestPatterns`)
4. Contagem de rotas via grep em `shield.routes.ts`
5. Presença de módulos via `check_file()`
6. Verificação de segurança: `set_config(..., true)` em código Shield

Os docs canônicos são regenerados a partir da saída do script após cada sprint. Nunca editados manualmente com números.

## Docs canônicos (regeneráveis)

| Arquivo | Conteúdo |
|---------|----------|
| `README.md` | Overview, quick start, feature table, test commands |
| `docs/CURRENT_STATE.md` | Estado atual do repositório por sprint |
| `docs/TEST_MANIFEST.md` | Lista completa de arquivos e suítes de teste |
| `docs/OPERATIONS.md` | Comandos operacionais, migrations, seed |
| `docs/PRODUCT_SURFACE.md` | Superfície de produto — domínios, rotas, invariantes |

## Docs permanentes (nunca deletar)

| Arquivo | Motivo |
|---------|--------|
| `docs/ADR-*.md` | Registro histórico de decisões arquiteturais — imutável |
| `docs/RUNBOOKS.md` | Procedimentos de resposta a incidentes operacionais |
| `docs/PRODUCTION_HARD_GATES.md` | Gates obrigatórios para deploy em produção |
| `CHANGELOG.md` | Histórico de versões semânticas |
| `API.md` | Referência da API pública |

## Consequências

**Positivo:**
- Números sempre derivados do repositório — impossível divergir
- Docs fáceis de regenerar após qualquer sprint
- Sem "document rot" acumulado

**Negativo / Tradeoff:**
- Docs canônicos perdem detalhes narrativos de sprints anteriores (mitigado: ADRs preservam a narrativa)
- O script exige que `vitest.config.ts` use `integrationTestPatterns` como fonte da verdade

## Regra de ouro

> Nunca escreva um número em um doc canônico à mão.
> Se o número não sai de `bash scripts/audit_project_state.sh`, ele não pertence ao doc.
