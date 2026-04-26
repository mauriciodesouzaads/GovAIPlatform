# ADR-026: RAG real com Qdrant + retrieval transparente em dispatchRuntime

## Status: Accepted — FASE 14.0/6a₁ (commits 96f71e4 + cascade hotfix)

## Context

A plataforma já tinha um RAG legacy desde init.sql:

- `knowledge_bases` 1:1 com `assistants` (uma KB por agente)
- `documents` com `content TEXT` inline + `embedding vector(768)` em
  pgvector com índice HNSW
- Embeddings via `gemini-embedding-001` (768-dim) chamado direto
  por `src/lib/rag.ts:generateEmbedding`
- Caminho de uso: `/v1/execute/:assistantId` → LiteLLM, com a
  função `searchWithTokenLimit` injetando contexto relevante na
  chamada ao LLM

Esse caminho atende o cenário **chat governado direto-ao-LLM** (LLM
chama uma resposta única e o RAG enriquece o prompt). Não atende
três casos novos que 14.0 introduziu:

1. **Modo Agente** (5b.2) — agente roda no runner (Claude Code /
   OpenClaude / Aider) por minutos a horas, faz tool calls, lê e
   escreve arquivos. O contexto precisa ir no system prompt do
   runner, não em uma chamada LiteLLM síncrona.
2. **Múltiplas KBs por agente** — um Jurídico precisa de "casos de
   2024" + "jurisprudência STF" + "pareceres internos" simultâneos.
   1:1 não escala.
3. **Documentos enterprise** — PDFs de 200 páginas, .docx
   regulatórios. O modelo `documents.content TEXT inline` pesa o
   banco e perde estrutura (pagecount, tabelas).

## Decision

Construir um pipeline novo de RAG sobre **Qdrant** (vetor),
**estendendo** as tabelas legacy ao invés de substituí-las, e
acoplar um **hook transparente** em `dispatchWorkItem` que injeta
contexto recuperado na instrução enviada ao runner.

### Decisões arquiteturais

#### 1. Qdrant on-premise, não Cloud

Qdrant via container Docker com volume persistente
(`qdrant_data`), portas 6333 (REST) + 6334 (gRPC) bind-loopback.
Cliente: `@qdrant/js-client-rest` REST.

Por que não Qdrant Cloud / Pinecone / Weaviate Cloud:

- Compliance: GovAI vende governança de dados; um vetor RAG
  contém o equivalente em informação à fonte. Mandar para SaaS
  externo viola o argumento.
- Custo: a primeira escala (1M chunks) cabe num container
  que roda na mesma rede que o `api`.
- Latência: rede de host, não internet pública.

#### 2. Estender `knowledge_bases` + `documents` em vez de criar `rag_*`

Migration 094 ALTER TABLE em vez de CREATE TABLE rag_*.

Razão: `src/lib/rag.ts` + `execution.service.ts:570` ainda chamam
`searchWithTokenLimit` para o caminho LLM-direto, e essa rota usa
`knowledge_bases.assistant_id` + `documents.embedding`. Renomear ou
duplicar criaria divergência conceitual ("a documentação fala de
KBs, mas tem dois conjuntos") e impediria adoção gradual.

A 094 ADD COLUMN preserva o pipeline legacy intato (não toca
`assistant_id`, `content`, `embedding`); o pipeline novo usa as
colunas adicionadas (`qdrant_collection_name`, `embedding_provider`,
`extraction_status`, `sha256`, `storage_path`, `dlp_scan_result`,
`chunk_count`) + tabelas auxiliares (`document_chunks`,
`assistant_knowledge_bases`, `retrieval_log`).

Em 6a₂/6b consolidamos: ou `searchWithTokenLimit` migra para o
hook novo (uma fonte de verdade) ou `documents.embedding` vira
deprecated com flag de feature.

#### 3. Multi-tenant via collection-name, não filtro

Cada `(org, KB)` ganha sua própria coleção Qdrant:

```
govai_org_<uuid_compact>_<kb_uuid_compact>
```

Não usamos `filter: { org_id: ... }` em queries. Se a aplicação
calcular o nome da coleção errado, a busca sai vazia — falha
SEGURA. Filtros de payload são opcionais (zero impacto em
multi-tenancy).

Trade-off: um tenant com 100 KBs gera 100 coleções no Qdrant.
Aceitável até ~10K coleções por instância (limite Qdrant
recomendado), o que dá 100 tenants × 100 KBs cada — fora da
escala atual em ordens de magnitude.

#### 4. Provider-agnostic embeddings com fallback para mock

`src/lib/embeddings.ts` exporta `EmbeddingProvider` com 3 impls:

- `gemini` (default) — usa `GEMINI_API_KEY` que já estava ativa,
  768-dim alinhado com o pgvector legacy. O API REST do Gemini é
  estável, sem SDK.
- `openai` — `text-embedding-3-small` 1536-dim, opcional via
  `OPENAI_EMBEDDINGS_API_KEY`. Usa axios, sem SDK pesado.
- `mock` — vetores L2-normalizados deterministic-seed-based. Não
  produz similaridade semântica genuína, mas é suficiente para
  reality-checks e CI sem keys externas.

Anthropic NÃO oferece embeddings API. Voyage AI seria a opção
"da família Claude"; não foi integrada nesta etapa porque o
roster atual cobre o caso. Adicionar Voyage é uma quarta classe
implementando `EmbeddingProvider` quando alguém pedir.

Quando o provider configurado tem sua key faltando, o factory
emite warning e retorna o mock — runtime degrada gracefully em
vez de crashar no boot.

#### 5. Hook transparente em dispatchWorkItem (sem mexer em proto/runners)

O proto `ChatRequest` (openclaude.proto) tem só `message`. Não há
campo `system_prompt` nem `rag_context`. Adicionar um campo novo
exige sincronizar 4 cópias de proto (api + 3 runners) e bumping
versões.

Em vez disso, o hook injeta contexto **prepending** no
`instruction` que vai como `message`:

```
<system_prompt do assistant_versions.prompt>

## Contexto recuperado

[Documento 1 · score 0.873]
<chunk>

---

[Documento 2 · score 0.812]
<chunk>

## Task: <título>
<descrição>
### Instructions
<mensagem do usuário>

## Skills Aplicáveis
<bindings>
```

Vantagens:
- Zero mudança em runners (eles veem o mesmo string que sempre
  receberam).
- Modo Livre + agentes sem KBs vinculadas: hook é no-op trivial
  (cedo retorno se `assistant_knowledge_bases` está vazio).
- Falhas de retrieval (Qdrant down, embedding rate-limit) são
  best-effort — runner roda sem contexto enriquecido em vez de
  crashar.

Desvantagem: o "system prompt" do agente vai dentro do
message-do-usuário do ponto de vista do runner. O modelo trata
ambos como input; em prática isso funciona porque o template
começa com seções (`##`) que o modelo entende como instruções.
Em 6a₂, se necessário, podemos extender o proto e fazer split
real.

#### 6. Pipeline inline (não BullMQ)

Upload → extract → DLP scan → chunk → embed → upsert no Qdrant
roda **inline** dentro da rota POST. A rota responde 202 Accepted
imediatamente com `document_id` + `status: 'pending'`, depois o
processamento continua em background dentro do mesmo processo
node, com errors persistidos em `documents.extraction_status='failed'`.

Por que não BullMQ:
- BullMQ ainda não está wired para RAG (está só para runtime
  dispatch). Adicionar uma fila nova só faria sentido com volume
  que justifique paralelização (ainda não temos).
- A signature da função (`processDocumentInline(params)`) é
  idêntica ao que um job worker consumiria. Trocar para
  `runtimeQueue.add('process-document', params)` é uma linha.
- Em desenvolvimento + reality-checks, inline é mais fácil de
  diagnosticar (todo log fica no api log).

Risco aceito: se o api crashar mid-pipeline, o documento fica em
`status='extracting'` para sempre. Mitigação para 6a₂: watchdog
similar ao do runtime worker que recupera órfãos.

#### 7. DLP scanner separado (regex, não Presidio NLP)

`src/lib/dlp-document-scanner.ts` é distinto de
`src/lib/dlp-engine.ts`. Razões:

- **Performance**: Presidio NLP em uma página de PDF é
  ~10s/documento. Reality-check sobe para minutos. Documentos
  inteiros pedem regex rápido.
- **Action policy**: chat prompts fazem MASK e seguem; documentos
  fazem ALLOW (sem PII) ou BLOCK (CPF/CNPJ/cartão). Mascarar um
  documento parcialmente cria chunks de sensibilidade mista que
  o retrieval não consegue raciocinar.

Em 6a₂, se necessário, podemos rodar Presidio NLP em background
como segunda camada (não-blocking) para detectar PII semântico.

## Consequences

### Positivas

- Caminho separado para Modo Agente sem regredir caminho legacy.
- 768-dim alinhado entre Qdrant e pgvector → migração futura é
  cópia de vetores, não re-embed.
- Hook é cosmético na função do runner — zero risk de quebrar
  runtime existente.
- `assistant_knowledge_bases` (many-to-many) destrava casos
  enterprise (1 KB compartilhada por vários agentes).
- DLP block na ingestão ao invés de só na consulta — documentos
  com CPF nunca chegam ao vetor.
- `retrieval_log` audita cada retrieval (zero hits inclusive),
  útil para tunar `min_score` por org.

### Negativas / dívida

- Dois pipelines RAG coexistindo (`rag.ts` legacy + `qdrant.ts`
  novo) por várias etapas. Em 6b/6c devemos consolidar.
- `documents` tem dois FKs ao mesmo `knowledge_bases` (`kb_id` +
  `knowledge_base_id`). Hotfix 095 tornou ambos `ON DELETE
  CASCADE` para evitar 23503. Em 6a₂ podemos ou (a) deprecar
  `kb_id` (drop FK + drop column quando legacy migrar) ou (b)
  marcar `knowledge_base_id` como GENERATED ALWAYS AS (kb_id).
- Pipeline inline limita escalabilidade — uma org com upload em
  massa monopoliza o api process. Refator para BullMQ quando
  volume justificar.
- Mock embedding provider produz similaridade artificial. CI
  passa, mas reality-check humano em dev sem GEMINI_API_KEY vê
  retrieval irrelevante. Documentar no .env.example (já está).

## Alternatives considered

- **Substituir `documents.embedding` direto** — bloqueado: o
  caminho `/v1/execute` legacy seria interrompido sem migração
  paralela.
- **Vetor inline em `document_chunks`** — duplica armazenamento
  com pgvector + perde a vantagem de Qdrant em busca de larga
  escala. Decidi por separação: metadata em PG, vetor em Qdrant.
- **Inline retrieval no runner** — runners receberiam um SDK do
  Qdrant. Fragmenta a stack (4 lugares para configurar URLs e
  keys) e exige mudança de proto. Hook centralizado na api é
  mais simples.
- **Embedding via LiteLLM** — testei mentalmente: LiteLLM proxia
  embeddings de OpenAI mas cobra ida-e-volta extra na rede. O
  axios direto para Gemini/OpenAI é simpler para o caso isolado
  de embeddings (não há policy/governance a aplicar — DLP roda
  ANTES, não no embedding).

## Verificação

`tests/integration/test-rag-end-to-end.sh` (21/21) cobre:
- Qdrant up
- Migration 094 + colunas + CHECKs
- KB CRUD
- Upload markdown → status pipeline → ready
- Qdrant collection populada
- Search single-KB + cross-KB
- Linking assistant↔KB
- Hook → retrieval_log entry
- DLP block em CPF
- DELETE document cascadeia para Qdrant
- DELETE KB cascadeia (após hotfix 095)
- 5b.2 zero regressão

## Hotfix 095

Migration 094 não atualizou o FK legacy `documents.kb_id` para
`ON DELETE CASCADE`. DELETE knowledge_bases falhava com 23503.
095 dropa e recria o constraint com cascade. Sem risco de dados
porque ambos os FKs apontam para a mesma linha de
`knowledge_bases` — não há "double cascade" em PostgreSQL.

## Não nesta sub-etapa (6a₂ / 6b)

- UI de KB / documents / link manager
- Skills híbrido (text instructions + binary tools no skill)
- Container runner gordo (LSP, ferramentas de código)
- Shared workspace de outputs entre runs
- Worker BullMQ para o pipeline de upload
- Watchdog para órfãos de extraction_status='extracting'
- Consolidação dos dois pipelines RAG
- Voyage AI provider (se demanda surgir)
