# Stream Handler Investigation — 2026-04-22 21:13

## Commit
```
7252408 fix(runtime): orphaned work_items + related — FASE 13.5a1
```

## Resumo de 1 parágrafo

O handler `/v1/admin/chat/send/stream` funciona perfeitamente — quando chamado via curl, retorna 200 + SSE válido em sub-segundo e entrega streaming completo. **O bug é 100% do lado do browser: falta de CORS headers na resposta hijackeada.** `reply.hijack()` no Fastify bypassa o pipeline `onSend` em que o `@fastify/cors` injeta `Access-Control-Allow-Origin`. Sem esse header, Chrome rejeita a resposta cross-origin (api:3000 → admin-ui:3001) e o `fetch()` lança `TypeError: Failed to fetch`. curl ignora CORS (não é browser), por isso todos os testes server-side passam.

## Reprodução via curl (PASSO 2)

- **Resultado:** recebeu `HTTP/1.1 200 OK` + Content-Type: `text/event-stream; charset=utf-8` + body com frames `data: {...}\n\n` completos (chunks + `{"done":true,...}`).
- **Tempo:** 718 ms para 442 bytes (stream completo de "Quatro.").
- **Header line exato:** `HTTP/1.1 200 OK`
- **Body recebido:**
    ```
    data: {"chunk":"Quatro."}

    data: {"done":true,"usage":{"completion_tokens":4,...},"traceId":"...","signature":"...","assistantId":"...","assistantName":"Análise de Crédito"}
    ```

**Conclusão imediata:** o handler não trava. Repro negativo no server-side.

## Loopback interno (PASSO 3)

Executado de dentro do container `api`:

- **TCP 127.0.0.1:3000:** (probe `/dev/tcp` não funciona no busybox do container — sem informação), mas:
- **`curl http://127.0.0.1:3000/health`:** **20 ms**, 200, JSON válido.
- **`curl http://127.0.0.1:3000/v1/execute/...` com demo key:** **530 ms**, 200, LLM respondeu `It seems like you're testing the connection...`.
- **Portas escutando:** `0.0.0.0:3000` ativo.

→ Loopback 100% operacional. **H1 (loopback travando) REJEITADA.**

## Logs do api durante hang (PASSOs 4-5)

**Linhas capturadas:** 91 durante uma request com `Origin: http://localhost:3001`.

A request **completou com sucesso** em 3.35s: 115+ chunks entregues, `{"done":true,...}` final enviado. Logs mostram padrão normal de execução:

```
/v1/admin/chat/send/stream               → 200  (responseTime: 3342ms)
/v1/execute/00000000-0000-0000-0002-...  → 200  (loopback, from 127.0.0.1)
```

**Nenhuma exception, nenhum ECONN, nenhum ETIMEDOUT, nenhum erro.** O processo NÃO está travando — ele completa o streaming corretamente no server-side.

→ **Não há hang no backend.** O "Failed to fetch" do browser não é pós-resposta; é da negociação de CORS.

## Handler estrutura (PASSOs 6-7)

### `/chat/send` (JSON, **funciona no browser**)

- Usa loopback? **SIM**
- URL: `http://127.0.0.1:3000/v1/execute/${body.assistant_id}` (`chat.routes.ts:72`)
- Método: `axios.post(...)` + `reply.status(...).send(result.data)` normal
- **`reply.hijack()`? NÃO.** Resposta volta pelo pipeline Fastify completo.

### `/chat/send/stream` (SSE, **falha no browser**)

- Usa loopback? **SIM**
- URL: `http://127.0.0.1:3000/v1/execute/${body.assistant_id}` (`chat.routes.ts:216`)
- Método: `axios.post(...)` seguido de chunking manual via `reply.raw.write(...)`
- **`reply.hijack()`? SIM** (linha 199).
- Headers escritos manualmente em `reply.raw.writeHead(200, { Content-Type, Cache-Control, Connection, X-Accel-Buffering })` — **sem CORS**.

### Diferença crítica

Ambos usam o MESMO loopback, o MESMO pipeline interno (`/v1/execute` via 127.0.0.1:3000). A única diferença estrutural é:

- `/chat/send` → Fastify completa a resposta, **`onSend` do `@fastify/cors` injeta `Access-Control-Allow-Origin`**.
- `/chat/send/stream` → `reply.hijack()` retira o reply do pipeline. O plugin CORS nunca é chamado. Headers escritos por `reply.raw.writeHead(...)` NÃO incluem CORS.

Prova side-by-side com `Origin: http://localhost:3001` na request:

```
# /chat/send response headers (works in browser)
HTTP/1.1 200 OK
vary: Origin
access-control-allow-origin: http://localhost:3001
access-control-allow-credentials: true

# /chat/send/stream response headers (FAILS in browser)
HTTP/1.1 200 OK
(NO access-control-allow-origin)
(NO access-control-allow-credentials)
(NO vary)
```

→ **Root cause isolada.**

## Accept header (PASSO 8)

| Accept | HTTP | Body | Comportamento |
|---|---|---|---|
| `text/event-stream` | 200 | 943 bytes de SSE | Funciona |
| *omitido* | 200 | 1560 bytes de SSE | Funciona |

Sem diferença relevante. Accept não é o problema.

## Middleware check (PASSO 9)

- `@fastify/cors` registrado em `server.ts:185` com `origin: [http://localhost:3000, http://localhost:3001, http://localhost:3002, ADMIN_UI_ORIGIN]` + `credentials: true`.
- Hook global: só 1 em `server.ts:316` (não relacionado a CORS/SSE).
- `reply.hijack()` aparece apenas em `chat.routes.ts` (linha 199). Nenhum outro endpoint do projeto usa hijack.

Nenhum hook espúrio. O problema é estritamente: **CORS plugin escreve via onSend, hijack cancela onSend, CORS headers não saem.**

## Causa raiz identificada

**Hipótese confirmada:** nova — chamá-la de **H4**: `reply.hijack()` em rota SSE contorna o pipeline onSend do Fastify, onde o `@fastify/cors` normalmente injeta os headers `Access-Control-Allow-*`. Sem esses headers, o browser Chrome (e qualquer UA que respeite CORS) bloqueia a resposta cross-origin e lança `TypeError: Failed to fetch` no JS.

**Evidência (reproduz em 4 linhas):**

```bash
# com Origin header, ambos deveriam retornar ACAO:
curl -s -D - -o /dev/null -H "Origin: http://localhost:3001" -H "Authorization: Bearer $T" \
     -H "Content-Type: application/json" -X POST \
     http://localhost:3000/v1/admin/chat/send        -d '{"assistant_id":"...","message":"a"}' \
     | grep -i access-control    # → access-control-allow-origin: http://localhost:3001 ✓

curl -s -D - -o /dev/null -H "Origin: http://localhost:3001" -H "Authorization: Bearer $T" \
     -H "Content-Type: application/json" -X POST \
     http://localhost:3000/v1/admin/chat/send/stream -d '{"assistant_id":"...","message":"a"}' \
     | grep -i access-control    # → (vazio — MISSING) ✗
```

## Recomendação de fix (para próximo prompt)

### Opção A (recomendada — 4 linhas em `chat.routes.ts`)

Antes de `reply.hijack()`, ler o origin do request, validar contra a allow-list do CORS plugin, e mergir os headers CORS manualmente dentro do `writeHead`:

```typescript
// Antes: reply.hijack()
const origin = request.headers.origin as string | undefined;
const allowOrigins = new Set(['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002', process.env.ADMIN_UI_ORIGIN].filter(Boolean));
const corsHeaders: Record<string, string> = origin && allowOrigins.has(origin)
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        'Vary': 'Origin',
    }
    : {};

reply.hijack();
reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsHeaders,
});
```

**Custo:** ~10 linhas, zero risco (só adiciona headers quando origin é válido).
Esconder a lista em uma constante compartilhada com o `cors.register(...)` em `server.ts` se quiser DRY; não é obrigatório.

### Opção B (alternativa, mais invasiva)

Usar `@fastify/sse` ou emitir via `reply.send()` com stream em vez de `reply.hijack()`. Mantém o pipeline Fastify completo, CORS funciona sozinho. Mas: maior refactor, e `reply.raw.write(...)` em loop já é o padrão atual do projeto.

**Preferida:** **A**, porque isola o fix no único endpoint afetado, não muda semântica de nenhum outro handler, e preserva o padrão `reply.hijack()` do FASE 6 SSE.

## Bônus — 2 melhorias ortogonais que podem vir junto

Não são necessárias para fechar o bug, mas fazem sentido na mesma PR:

1. **Extrair a allow-list CORS para constante em `src/lib/cors-config.ts`** para que `server.ts:185` e o novo bloco em `chat.routes.ts` leiam da mesma fonte. Evita drift.
2. **Adicionar OPTIONS preflight explícito para `/v1/admin/chat/send/stream`**. `@fastify/cors` já trata preflight em rotas normais, mas para SSE o browser pode disparar um preflight com `Content-Type: application/json` — confirmar que o `preflightContinue: false` default do plugin já responde. Se não, `fastify.options(...)` explícito.

## Anexos

- `/tmp/stream_headers.txt` + `/tmp/stream_body.txt` — PASSO 2 (repro curl)
- `/tmp/api_full.log` — PASSO 5 (91 linhas capturadas durante request)
- `/tmp/send_headers.txt` + `/tmp/stream_headers2.txt` — PASSO 7 (side-by-side CORS diff)
- `/tmp/h_a.txt` + `/tmp/h_b.txt` + `/tmp/b_a.txt` + `/tmp/b_b.txt` — PASSO 8 (Accept variants)

Todos preservados no filesystem para inspeção direta.

---

## Resolution — FASE 13.5a2

Fix A (recommended) was applied:

- **New file** `src/lib/cors-config.ts` exposes `getCorsAllowOrigins()` and `buildCorsHeaders(origin)` as the single source of truth for CORS policy. Both consumed by `server.ts` (plugin register) and `chat.routes.ts` (hijacked SSE writeHead).
- **`server.ts`** switched `fastify.register(cors, { origin: [...] })` to `origin: getCorsAllowOrigins()`.
- **`chat.routes.ts`** computes `const corsHeaders = buildCorsHeaders(request.headers.origin)` before `reply.hijack()` and spreads it into the `reply.raw.writeHead(200, { ... })` options.

No logic changes. No handler semantics changes. Just headers.

### Verification

- New unit tests in `src/__tests__/chat-stream-cors.test.ts` — 6/6.
- New integration test `tests/integration/test-chat-stream-cors.sh` — 4/4
  (baseline `/chat/send`, allowed Origin → ACAO echoed, evil Origin → no
  ACAO, SSE body completes with `done=true`).
- Browser retest (manual): Chat Governado → mensagem normal responde
  com texto do LLM sem "SERVIÇO INDISPONÍVEL".

Bug dead. Pipeline green.
