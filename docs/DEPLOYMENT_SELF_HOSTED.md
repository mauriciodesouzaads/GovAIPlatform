# GovAI Platform — Self-Hosted Deployment Guide

## Pré-requisitos

- Docker Engine 24+ e Docker Compose v2
- 8 GB RAM mínimo (16 GB recomendado)
- 20 GB de espaço em disco livre
- Pelo menos uma API key de LLM (ver seção 4.5)

## 1. Clone e configuração inicial

```bash
git clone <repo-url> govai-platform
cd govai-platform
cp .env.example .env
```

## 2. Configuração do .env

Edite `.env` com suas credenciais. Os campos obrigatórios são:

- `DB_PASSWORD`, `DB_APP_PASSWORD`, `REDIS_PASSWORD`
- `JWT_SECRET`, `SIGNING_SECRET` (mín. 32 chars cada)
- Pelo menos uma API key de LLM (ver seção 4.5)

## 3. Build e inicialização

```bash
docker compose up -d
```

O stack aguarda healthchecks em cadeia: database → redis → litellm → presidio → api → admin-ui.
Aguarde ~60 segundos na primeira inicialização.

## 4. Verificação

```bash
# API health
curl http://localhost:3000/health

# Admin UI
open http://localhost:3001
```

Credenciais padrão de demo: `admin@govai.com` / `GovAI2026@Admin`

---

### 4.5 Configuração de Provedores LLM

O GovAI funciona com qualquer provedor de LLM do mercado via LiteLLM proxy. O código NUNCA chama um provedor diretamente — sempre passa pelo LiteLLM que roteia para o provedor configurado. Isso significa que o cliente escolhe o provedor sem mudar código.

**Configuração padrão:** Groq como principal (rápido, tier gratuito), Anthropic como fallback automático. O LiteLLM faz failover transparente quando o Groq retorna rate limit (429).

**Para usar outro provedor:** edite o `litellm-config.yaml` e adicione um entry com `model_name: govai-llm`:

```yaml
  - model_name: govai-llm
    litellm_params:
      model: azure/gpt-4o  # ou openai/gpt-4o, mistral/mistral-large, ollama/llama3, vllm/meta-llama, etc.
      api_key: os.environ/AZURE_API_KEY
      api_base: https://seu-endpoint.openai.azure.com  # se necessário
```

**Provedores suportados:** OpenAI, Anthropic, Google (Gemini), Azure OpenAI, AWS Bedrock, Groq, Mistral, Cohere, Ollama (local), vLLM (local), Together AI, Replicate, Hugging Face, e 100+ outros via LiteLLM.

**Para adicionar modelo local (air-gapped):** use Ollama ou vLLM como serviço Docker separado e aponte o `api_base` para ele. Nenhum dado sai da rede.

```yaml
  - model_name: govai-llm
    litellm_params:
      model: ollama/llama3.2
      api_base: http://ollama:11434  # serviço Docker na mesma rede
```

**Importante:** as API keys devem estar no arquivo `.env` — nunca nas variáveis de ambiente do shell ao rodar `docker compose up`. O serviço litellm usa `env_file: .env` diretamente para evitar que variáveis vazias do shell sobrescrevam os valores corretos.

---

## 5. Estrutura de serviços

| Serviço   | Porta | Descrição                        |
|-----------|-------|----------------------------------|
| api       | 3000  | Backend Fastify (API REST)       |
| admin-ui  | 3001  | Frontend Next.js                 |
| litellm   | 4000  | Proxy LLM com failover           |
| database  | 5432  | PostgreSQL 15 + pgvector         |
| redis     | 6379  | Cache e filas BullMQ             |
| presidio  | 5001  | Análise semântica DLP (NLP)      |

## 6. Produção

Para produção, use `docker-compose.prod.yml` que inclui:

- Digests imutáveis de imagens (não tags flutuantes)
- Nginx reverse proxy com TLS
- Restrição de ports (sem exposição direta)
- Grafana + AlertManager para observabilidade

Consulte `docs/OPERATIONS.md` para runbooks de operações.
