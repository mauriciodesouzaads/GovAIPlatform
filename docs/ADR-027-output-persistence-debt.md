# ADR-027 — Persistência de outputs entre rebuilds

**Status:** Accepted as known debt
**Data:** 2026-04-28
**Etapa:** FASE 14.0/6a₂.D
**Relacionado:** ADR-026 (RAG), 6a₂.C (workspace + outputs)

## Contexto

A etapa 6a₂.C implementou captura de outputs do agente após
`RUN_COMPLETED`: o hook `captureWorkItemOutputs` copia arquivos
gerados pelo runner para `/var/govai/work-item-outputs/<org>/<wi>/`
antes do cleanup do workspace efêmero, e registra metadata em
`work_item_outputs`. Endpoints `/v1/admin/runtime/work-items/:id/files`
e `/files/:fileId` expõem download autenticado.

Durante validação ao vivo da 6a₂.C-fix, descobriu-se que o PDF
capturado na validação anterior (work_item 39e4a9fe, 1493 bytes)
retornava HTTP 410 Gone após rebuild docker da api. O metadata em
`work_item_outputs` permaneceu, mas o arquivo físico em
`storage_path` desapareceu.

## Causa raiz

`/var/govai/work-item-outputs/` é diretório dentro do container api
mas **não está declarado como volume Docker persistente** no
`docker-compose.yml`. A cada `docker compose build api`, o filesystem
do container é recriado — a "permanent copy" de outputs se perde junto.

Comparativo com volumes que persistem:

| Path | Volume Docker | Persiste rebuild? |
|---|---|---|
| `qdrant_data` | ✅ named volume | ✅ |
| `skills_storage` (6a₂.C) | ✅ named volume | ✅ |
| `govai_workspaces` | ✅ named volume | ✅ (mas wiped pelo cleanupWorkspace no fim de cada run) |
| `rag_storage` (6a₁) | ✅ named volume | ✅ |
| `/var/govai/work-item-outputs/` (6a₂.C) | ❌ in-container | ❌ |

A criação do diretório no `Dockerfile` (linha 65–67 do api Dockerfile)
garante apenas que ele exista no momento do start — não que sobreviva
a rebuilds. O equivalente para `rag_storage` funciona porque o nome de
mount no compose aponta para um named volume; o de
`work-item-outputs` aponta para o filesystem do container.

## Impacto

| Cenário | Severidade |
|---|---|
| Dev local com rebuilds frequentes | 🟡 Médio |
| Produção K8s com PVCs externos | 🟢 Baixo (volumes externos sobrevivem) |
| Demos para clientes | 🔴 Alto se o output é gerado e o container reinicia antes do cliente baixar |
| HITL / aprovação tardia | 🔴 Alto se aprovação leva dias e api restart no meio |

## Decisão

**Aceitar como débito conhecido para 6e (hardening de produção).**
Não corrigir agora porque:

1. Não bloqueia desenvolvimento de UI (6b/6c).
2. Em produção real (K8s/Swarm) é resolvido com PVC externo, sem
   mudança de código.
3. Fix correto envolve coordenação cross-camada (compose + cron) e
   merece etapa dedicada.

A coluna `expires_at` em `work_item_outputs` (migration 096) já está
preparada para o cron worker que vai garbage-collect outputs
expirados — esse pedaço da arquitetura está correto, só falta wirar.

## Plano de remediação (6e)

1. Migration `0XX`: nada novo (schema já preparado em 096).
2. `docker-compose.yml`: adicionar
   ```yaml
   volumes:
     outputs_storage:
       driver: local
   ```
   e mount em api: `outputs_storage:/var/govai/work-item-outputs`.
3. Cron worker que varre
   `work_item_outputs WHERE expires_at < NOW()` e remove arquivos
   físicos + linhas de metadata. Reaproveitar BullMQ (já em uso no
   runtime worker) com job `gc-expired-outputs` rodando a cada 1h.
4. UI da 6b/6c: tratar HTTP 410 com mensagem amigável
   ("Arquivo expirado — gere novamente"). O endpoint já retorna 410
   corretamente quando o arquivo sumiu (defesa de
   `runtime-admin.routes.ts`), só falta polish no consumidor.

## Não-decisão

Não vamos cobrar do cliente nem do operador a regeneração manual de
outputs perdidos. Se o use case exigir persistência longa (ex:
parecer jurídico que precisa ser auditável por 5 anos), o fluxo
correto é **anexar o output a um Work Item arquivado em storage de
objetos (S3/MinIO)** — outra etapa, separada de
`work_item_outputs` que segue sendo "outputs efêmeros, TTL curto".

## Por que não corrigir agora junto com 6a₂.D

A 6a₂.D é a etapa de **publicação** (push consolidado + ADR). Adicionar
um volume Docker novo + cron worker mexe em compose, em scripts/
entrypoint.sh (criação do dir com chown correto na primeira mount),
em workers, e potencialmente em retention-archive.job. Isso é uma
etapa autônoma, não um ajuste cosmético. Documentar o débito agora
e voltar a ele em 6e é mais honesto do que esticar a 6a₂.D.
