# GitHub Actions — Secrets Obrigatórios

Este documento descreve os secrets que devem ser configurados em
**Settings → Secrets and variables → Actions** do repositório GitHub
antes de executar o pipeline CI/CD.

---

## Secrets Obrigatórios

### `SIGNING_SECRET`

**Uso:** Assinatura HMAC-SHA256 de audit logs imutáveis (`audit_logs_partitioned`).  
**Onde é usado:** `src/lib/governance.ts` → `IntegrityService.sign()` e `verify()`  
**Requisito mínimo:** 32 caracteres (64 chars hex recomendado)  
**Gerar:**

```bash
openssl rand -hex 32
```

**Impacto se ausente:** `server.ts` chama `process.exit(1)` na inicialização. Testes unitários que usam `IntegrityService` falham com `Cannot read SIGNING_SECRET`.

---

### `JWT_SECRET`

**Uso:** Assinatura e verificação de tokens JWT de sessão de usuário (`@fastify/jwt`).  
**Onde é usado:** `src/server.ts` → `app.register(fastifyJwt, { secret: JWT_SECRET })`  
**Requisito mínimo:** 32 caracteres (64 chars hex recomendado)  
**Gerar:**

```bash
openssl rand -hex 32
```

**Impacto se ausente:** Login retorna JWT inválido. Todos os endpoints autenticados retornam 401.

---

### `ORG_MASTER_KEY`

**Uso:** Chave mestra BYOK para criptografia envelope de DEKs (Data Encryption Keys) em `run_content_encrypted`.  
**Onde é usado:** `src/lib/kms.ts` → `LocalKmsAdapter` — wrapping/unwrapping de DEKs com AES-256-GCM  
**Formato:** Exatamente 64 caracteres hexadecimais (32 bytes = 256 bits)  
**Gerar:**

```bash
openssl rand -hex 32
```

**Impacto se ausente:** Execuções de assistentes que armazenam conteúdo criptografado falham. O job `unit-tests` usa o valor de fallback `000...0001` seguro para desenvolvimento.

---

## Secrets Opcionais (CI)

| Secret | Descrição | Fallback em CI |
|---|---|---|
| `GEMINI_API_KEY` | Chave da API Google Gemini (LLM) | Skipped (testes sem LLM real) |
| `LITELLM_KEY` | Chave do proxy LiteLLM | Skipped |
| `PROD_API_URL` | URL da API de produção para build da Admin UI | `https://api.govai-platform.com` |

---

## Como Configurar

1. Acesse o repositório no GitHub
2. Vá em **Settings** → **Secrets and variables** → **Actions**
3. Clique em **New repository secret**
4. Adicione cada secret com o nome exato (maiúsculas, com underscores)

```
SIGNING_SECRET   = <saída do openssl rand -hex 32>
JWT_SECRET       = <saída do openssl rand -hex 32>
ORG_MASTER_KEY   = <saída do openssl rand -hex 32>
```

---

## Comportamento sem Secrets Configurados

Os jobs `unit-tests` e `integration-tests` têm fallback para valores de desenvolvimento:

```yaml
SIGNING_SECRET: ${{ secrets.SIGNING_SECRET || 'dev-signing-secret-must-be-at-least-32-chars-x' }}
JWT_SECRET:     ${{ secrets.JWT_SECRET     || 'dev-jwt-secret-must-be-at-least-32-chars-xxxx' }}
ORG_MASTER_KEY: ${{ secrets.ORG_MASTER_KEY || '000...0001' }}
```

**Estes fallbacks são seguros para CI mas NÃO devem ser usados em produção.**  
Em produção, configure os secrets reais no GitHub ou no vault da infraestrutura.

---

## Rotação de Secrets

- `SIGNING_SECRET`: rotacionar a cada 90 dias ou após suspeita de comprometimento  
- `JWT_SECRET`: rotacionar invalida todos os tokens ativos — planejar janela de manutenção  
- `ORG_MASTER_KEY`: rotação requer re-criptografia de todos os DEKs em `run_content_encrypted` — use o `KEY_ROTATION_DAYS` scheduler

Referência: `src/jobs/key-rotation.job.ts`
