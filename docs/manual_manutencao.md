# Manual de Operação e Manutenção: GOVERN.AI

Este documento visa instruir a equipe de SRE (Site Reliability Engineering) e SecOps (Security Operations) nas rotinas operacionais (Day 2) da plataforma GOVERN.AI.

## 1. Monitoramento Básico (Observabilidade)
A GOVERN.AI exporta ativamente logs textuais convencionais (pstdout) e métricas baseadas na stack do Prometheus/Grafana.

### Endpoint Prometheus
A qualquer momento, colete dados sobre o cluster (Latência LiteLLM, Quotas financeiras parciais da organização cliente e número de falhas via OPA Engine).
```bash
curl http://localhost:3000/metrics
```
Adicione este endpoint como target (Job) no seu `prometheus.yml`. As métricas expostas por padrão sob o prefxo `govai_` incluem:
- `govai_http_requests_total`: Total de requisições de agentes servidas.
- `govai_llm_tokens_total`: Volume transacionado financeiramente.

### Observabilidade Langfuse (Telemetry Worker)
Se a integração via `LANGFUSE_PUBLIC_KEY` e `LANGFUSE_SECRET_KEY` (no `.env`) estiver ativa, todos os spans de inteligência artificial (inclusive as conversões internas do motor Rag para Busca Vetorial) serão exportados via API assíncronicamente graças ao worker `telemetry.worker`. Para debug avançado de Prompts em massa e RTT (Round Trip Times), prefira o dashboard externo SaaS da Langfuse ao invés do console do contêiner Fastify principal.

## 2. Acesso à Quarentena e Logs Auditáveis
Incidentes com PIIs (identidade bancária ou emails escapados) gerarão alertas assíncronos que estarão visíveis no Admin Panel.
Para acessar a documentação fiscal das retenções:

### Logs Auditáveis Imutáveis
Acesse periodicamente o repositório **Audit Logs** na interface Administrativa (porta `:3001` > Logs).
Essas colunas contêm um UUID de Assinatura Eletrônica (HMAC). Logs contendo *Válida* estão íntegros e não podem ser apagados do Database sem que a auditoria da trilha perceba sua violação na árvore dependente Criptográfica (Crypto-shredding protocol).

### Human-In-The-Loop (Quarentena HITL)
Vá ao sub-modulo "Approvals" no Admin Panel local. Transações `PENDING_APPROVAL` têm um TTL automático de 48h. Elas aguardam um clique manual de **"Approve"** (o que permite o reenvio nativo da query em stand-by) ou **"Reject"** (que informa bloqueio ao Client/Agente via API 403 Forbidden simulada em polling, caso estejam desenhados para isso via Client Polling).

*O "Expiration Worker" que orbita o Redis automaticamente varre transações perdidas, mudando status pra REJECTED se expiradas.*

## 3. TroubleShooting Frequente

### Erro: `Redis is not ready`/`Rate Limit Offline`
- **Sintoma:** Bloqueios súbitos em massa com `429 Too Many Requests`. O SSO não deixa ninguém entrar ou a API chaveia as keys `x-api-key`.
- **Causa:** O Redis (`govai-platform-redis-1`) atingiu timeout ou limite de RAM evictions (`OOM`).
- **Solução:** `docker compose restart redis` garante a limpeza. Contudo, logs efêmeros (webhooks e telemetry logs da BullMQ pendentes) se perderão.

### Erro: `Motor SPAcY pt_core_news` falhando na NLP Engine do Presidio
- **Sintoma:** O Presidio Container reinicia infinitamente ou reporta status 500 no Roteamento Fastify (API do NodeJS).
- **Causa:** Conectividade de rede da VM durante o Build não baixou com sucesso o package binário Giga `pt_core_news_sm`.
- **Solução:** Remova o conteiner `govai-platform-presidio` e force a recompilação via `docker compose build --no-cache presidio`.

### Onde e como Exportar CSV (Compliance B2B 4.557)?
Por norma do BACEN, exportações contínuas são obrigatórias semestral ou anualmente para Governança Ativa. 
Use a interface `Reports` na UI Admin (`http://.../reports`). O botão renderiza todo o "Storytelling" Jurídico do banco baseando os cálculos na cota e no `Total de Rejeites (OPA Violations) / Total Executions`. Esse PDF é certificado pelo backend. Use o CSV se a entidade reguladora exigir a árvore completa (Raw Export) dos Hash Signatures HMAC.

## 4. Updates (Pipeline de Atualização do Software GovAI)

Para aplicar patches de correção à infraestrutura nativa:

```bash
# 1. Puxe da master remota (GitHub)
git pull origin main

# 2. Re-compile containers afetados silenciosamente
docker compose build api admin-ui

# 3. Reimbolse-os sem matar dependências (Up d faz auto-restart dos diffs)
docker compose up -d

# 4. Caso o Patch note tenha uma Migration SQL Nova ("014_feature.sql")
docker exec govai-platform-api-1 bash scripts/migrate.sh
```
