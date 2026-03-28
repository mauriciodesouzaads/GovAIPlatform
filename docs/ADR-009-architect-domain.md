# ADR-009 — Architect Domain: Federated Control Plane Design

**Status:** Aceito
**Data:** 2026-03-28
**Contexto:** Sprint A1–A3 — Architect Domain Foundation e Hardening

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

- `src/lib/architect.ts` — domain service functions A–Q
- `src/routes/architect.routes.ts` — 18 endpoints do domínio Architect
- `055_architect_domain.sql` — schema base (5 tabelas + RLS + triggers)
- `056_architect_execution_hint.sql` — coluna advisory execution_hint
- `src/services/execution.service.ts` — padrão de chamada LiteLLM
- ADR-001: decisão de não-streaming que se aplica igualmente ao Architect
