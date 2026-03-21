# ADR-001 — Decisão: Sem SSE/Streaming no pipeline de execução governada

**Status:** Aceito
**Data:** 2026-03-21
**Contexto:** Sprint B — GOV.AI Core Hardening

---

## Contexto

Durante o diagnóstico do Sprint B, foi identificado que não existe implementação
real de SSE (`text/event-stream`) ou streaming no endpoint `/v1/execute`. A UI
e a documentação não fazem promessa explícita de streaming, mas a ausência de
uma decisão formal criava ambiguidade.

---

## Decisão

**Não implementar SSE/streaming no endpoint `/v1/execute`.**

Manter o modelo request-response síncrono como única interface do pipeline de
execução governada.

---

## Justificativa técnica

O pipeline de execução governada executa as seguintes etapas em sequência **sobre
a resposta completa** antes de liberar qualquer dado ao cliente:

| Etapa | Razão para bloquear streaming |
|-------|-------------------------------|
| **OPA policy evaluation** | Requer o prompt completo para avaliar regras |
| **DLP scan (Presidio NLP)** | Análise semântica sobre o texto completo (entidades PII cruzam tokens) |
| **HMAC signature** (`IntegrityService.signPayload`) | Assina o payload completo — impossível assinar fragmentos |
| **Audit log imutável** | O registro de auditoria deve conter input + output completo antes de ser gravado |
| **FinOps (token accounting)** | Contagem de tokens só está disponível após resposta completa do LiteLLM |
| **Telemetria LGPD-compliant** | `telemetry_pii_strip` requer DLP sobre a completion completa |

Implementar SSE exigiria **redesign completo do pipeline**: acumular o stream,
rodar DLP e assinatura sobre o buffer completo, e só então transmitir — o que
eliminaria o benefício percebido do streaming (latência de first token).

---

## Alternativas consideradas

### Opção A — SSE buffered (stream falso)
Acumular o stream internamente, rodar todo o pipeline, depois enviar como SSE.
**Rejeitado:** Adiciona complexidade de protocolo sem reduzir latência real.
A latência para o usuário seria idêntica ao modelo síncrono atual.

### Opção B — SSE sem DLP/assinatura na completion
Transmitir tokens em tempo real, executar DLP/assinatura apenas no prompt.
**Rejeitado:** Viola o requisito regulatório de auditoria. A completion pode
conter PII gerado pelo modelo (alucinações de dados sensíveis) que não seria
detectado e seria exposto ao cliente sem sanitização.

### Opção C — Endpoint `/stream` separado sem governança completa
Criar `/v1/execute/:id/stream` sem DLP e assinatura.
**Rejeitado:** Cria duas superfícies de ataque — usuários poderiam usar o
endpoint de stream para bypassar a política de governança.

---

## Consequências

- **Latência:** Mantida como está. P95 atual < 3s para Groq llama-3.3-70b.
- **UX:** A Admin UI usa polling para status de execuções assíncronas (HITL).
  Para execuções síncronas, a resposta retorna em uma única chamada HTTP.
- **Documentação:** README.md e API.md não prometem streaming. Esta ADR
  formaliza que streaming não fará parte do contrato de API v1.
- **Revisão futura:** Se um cliente exigir streaming, a abordagem correta é
  um modo "preview" sem governança completa, separado do pipeline auditável,
  com documentação explícita das garantias reduzidas.

---

## Referências

- `src/services/execution.service.ts` — pipeline de execução atual
- `src/lib/dlp-engine.ts` — DLP semântico sobre texto completo
- `src/lib/governance.ts` — `IntegrityService.signPayload`
- OPA policy enforcement: `src/lib/opa-governance.ts`
