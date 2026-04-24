# ADR-009 — Architect Domain: Federated Control Plane Design

**Status:** **Superseded by FASE 14.0 Etapa 1 — the workflow domain described here was removed in its entirety.**
**Data original:** 2026-03-28
**Supersedido em:** 2026-04-24
**Contexto:** Sprint A1–A3 — Architect Domain Foundation e Hardening

> **Nota histórica (FASE 14.0 Etapa 1):** o domínio workflow descrito abaixo
> (demand_cases → problem_contracts → architecture_decision_sets →
> workflow_graphs) foi removido em 14.0/1. O nome "Architect" agora carrega
> apenas o sentido de **delegation runtime** — o caminho [OPENCLAUDE] /
> [CLAUDE_CODE] / [AIDER] → architect_work_items. A cadeia de entidades
> workflow não existe mais em código; resta apenas um spine mínimo em
> `workflow_graphs` (singleton `marker='auto_delegation'`) até Etapa 2
> renomear a tabela e dropar a coluna `workflow_graph_id`.

---

## Contexto

O domínio Architect precisa transformar demandas ambíguas de clientes em
contratos de problema estruturados, decisões arquiteturais e work items
delegáveis. Múltiplas abordagens de design foram consideradas antes de
chegar ao modelo atual.

O desafio central é: como um control plane de governança de IA pode
organizar e governar a própria arquitetura das soluções de IA, sem criar
um segundo sistema paralelo fora da cadeia de auditoria?

---

## Decisão 1 — Cadeia de entidades imutável

A cadeia de entidades é:

```
demand_case → problem_contract → architecture_decision_set
  → workflow_graph → architect_work_items
```

**Justificativa:** A cadeia forward-only com imutabilidade em estados terminais
garante auditabilidade. Uma vez que um `problem_contract` é aceito, não pode
ser modificado — decisões são tomadas sobre fatos estáveis, não sobre alvos
em movimento. Triggers PostgreSQL `BEFORE UPDATE/DELETE` garantem isso na
camada de banco de dados, não apenas na aplicação.

---

## Decisão 2 — Propriedade do control plane

O Architect control plane é interno à GovAI Platform.
RAG, conectores MCP, Claude Code, Agno e outros motores de execução são
workers/adapters — eles são integrados, não construídos.

**Justificativa:** O valor do Architect está no raciocínio estruturado,
governança de decisões e trilhas de evidência — não em executar código.
"Construa o cérebro organizador; integre os braços executores."

Isso também evita um segundo serviço Python/FastAPI antes que a cadeia de
governança (RLS, OPA, DLP, audit) esteja presente nesse runtime.

---

## Decisão 3 — Chamadas LLM exclusivamente via gateway GOV.AI

Todas as invocações LLM dentro do domínio Architect devem passar pelo
gateway LiteLLM, não diretamente para nenhuma API de provedor.

**Justificativa:** Consistência com o pipeline DLP, OPA e audit que o restante
da plataforma impõe. Chamadas diretas à API bypassam os controles de
governança. A função `generateArchitectDocument` foi corrigida na Sprint A3
para usar `${LITELLM_URL}/chat/completions` com formato OpenAI-compatível
(`choices[0].message.content`) em vez de `api.anthropic.com/v1/messages`.

---

## Decisão 4 — execution_hint é advisory, não enforced

O campo `architect_work_items.execution_hint` é nullable e indica qual
executor deve processar um work item. O control plane **nunca** roteia
baseado nele — essa responsabilidade é da camada de delegação (Sprint A4).

**Justificativa:** Lógica de roteamento prematura cria acoplamento a workers
específicos antes que os adapters estejam estáveis. O hint é adicionado na
Sprint A3 como preparação para A4, mas sem enforcement.

Valores válidos: `mcp | agno | human | claude_code | internal_rag`

---

## Decisão 5 — Geração de documentos é Markdown-first

A geração de ADR produz Markdown estruturado, não arquivos binários Office.
Claude Agent Skills (docx/pptx) serão integrados em um sprint futuro como
camada de renderização opcional.

**Justificativa:** Markdown é auditável como texto, diffável no git e
renderizável em qualquer lugar. Arquivos binários requerem configuração da
Skills beta API que ainda não está no stack.

---

## Alternativas Rejeitadas

### Serviço Python/FastAPI greenfield para o Architect
**Rejeitado:** A stack de governança (RLS, OPA, DLP, audit) está em TypeScript.
Dividir o control plane entre linguagens adiciona complexidade operacional
sem benefício: dois serviços, dois schemas de DB, dois deploys.

### Agno como runtime core desde o início
**Rejeitado:** Agno é Python e exigiria um segundo serviço, segundo schema de
DB e segundo deployment — antes que work items sequer existissem. O padrão
correto é: primeiro o modelo de dados e control plane, depois os adapters.

### Chamadas diretas à API Anthropic
**Rejeitado na Sprint A3** em favor do gateway LiteLLM para consistência de
governança. Toda chamada LLM deve passar pelo pipeline DLP+OPA+audit.

### Roteamento de work items baseado em execution_hint no control plane
**Rejeitado para Sprint A3:** Criar lógica de roteamento antes que os adapters
(MCP, Agno, Claude Code) estejam integrados seria premature optimization
e criaria dead code ou acoplamento frágil.

---

## Consequências

- **Positivo:** auditabilidade completa de intake até evidência
- **Positivo:** pontos de extensão limpos para a camada de adapter (Sprint A4)
- **Positivo:** invariantes de governança enforced na camada de DB via triggers
- **Negativo:** geração de documentos requer LiteLLM rodando (sem fallback local)
- **Neutro:** `execution_hint` cria uma migration quando a lógica de roteamento
  for adicionada na Sprint A4

---

## Referências

- `src/lib/architect.ts` — domain service functions A–R
- `src/routes/architect.routes.ts` — 20 endpoints do domínio Architect
- `055_architect_domain.sql` — schema base (5 tabelas + RLS + triggers)
- `056_architect_execution_hint.sql` — coluna advisory execution_hint
- `057_architect_work_item_execution.sql` — colunas de delegação (dispatched_at, dispatch_attempts, execution_context)
- `src/lib/architect-delegation.ts` — delegation router + adapters (internal_rag, human, agno stub)
- `src/services/execution.service.ts` — padrão de chamada LiteLLM
- ADR-001: decisão de não-streaming que se aplica igualmente ao Architect

---

## Sprint A4–A5 Addendum

### Decision 6 — Concurrency: SELECT FOR UPDATE SKIP LOCKED

`dispatchWorkItem` uses `SELECT FOR UPDATE SKIP LOCKED` to prevent double-dispatch
in concurrent environments. SKIP LOCKED (not plain FOR UPDATE) ensures concurrent
callers skip locked rows rather than blocking, enabling graceful parallel operation.
Callers that receive the 'locked' result simply skip the item — it is being handled
by another worker. This pattern avoids deadlocks and queue stalls under load.

### Decision 7 — Agno as optional, flag-gated external runtime

The Agno adapter is introduced as a stub in Sprint A5. Activation requires
`AGNO_ENABLED=true` and a running Agno service at `AGNO_ENDPOINT`. The control plane
never requires Agno to function — it remains optional infrastructure. The stub records
the payload that would be sent to Agno in `execution_context` and keeps the work item
in 'pending' state, allowing operators to inspect the payload before enabling the
live integration.

### Decision 8 — Case summary as evidence-backed report

`generateCaseSummary` produces a structured report from the live state of the case
chain and records it as an evidence record (`ARCHITECT_CASE_SUMMARY_GENERATED`).
This closes the evidence loop: every significant Architect operation generates
auditable evidence. The summary includes completion percentage, work item metrics,
approved decision option, and confidence score — providing a single-call view of
case health for auditors and operators.
