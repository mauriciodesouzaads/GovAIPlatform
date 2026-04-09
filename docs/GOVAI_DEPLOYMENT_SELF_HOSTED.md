# GovAI GRC Platform — Guia de Implantação Self-Hosted
## Prova de Conceito (PoC) — 30 Dias

**Versão:** 1.0  
**Data:** Abril 2026  
**Classificação:** Restrito — Uso pelo time de infraestrutura do cliente  
**Suporte:** suporte@govai.com.br

---

## 1. Visão Geral

O GovAI GRC Platform é uma plataforma de governança de inteligência artificial que opera inteiramente na infraestrutura do cliente. Nenhum dado sai do perímetro da sua organização. A plataforma é composta por 6 serviços containerizados que se comunicam em uma rede Docker interna isolada.

### Arquitetura de serviços

| Serviço | Função | Porta interna | Imagem base |
|---------|--------|---------------|-------------|
| **database** | PostgreSQL 15 + pgvector | 5432 | pgvector/pgvector:pg15 |
| **redis** | Cache, filas, rate limiting | 6379 | redis:7-alpine |
| **litellm** | Proxy LLM multi-provider | 4000 | ghcr.io/berriai/litellm |
| **presidio** | Detecção de PII (spaCy PT-BR) | 5001 | Custom (Python/FastAPI) |
| **api** | Backend Fastify (TypeScript) | 3000 | Custom (Node 20 Alpine) |
| **admin-ui** | Interface web (Next.js 14) | 3001 | Custom (Node 20 Alpine) |

### Fluxo de dados

```
Navegador do usuário
    │
    ▼
[admin-ui :3001] ──HTTP──▶ [api :3000]
                               │
                    ┌──────────┼──────────┐
                    ▼          ▼          ▼
              [database]   [redis]   [litellm :4000]
               :5432       :6379         │
                                         ▼
                                   Provider LLM externo
                                   (Groq / Anthropic / Google)
```

Apenas a porta do admin-ui (3001) e opcionalmente a porta da API (3000) precisam ser expostas. Todos os demais serviços se comunicam exclusivamente pela rede Docker interna.

---

## 2. Requisitos de Infraestrutura

### Hardware mínimo (PoC até 50 usuários)

| Recurso | Mínimo | Recomendado |
|---------|--------|-------------|
| CPU | 4 vCPU | 8 vCPU |
| RAM | 8 GB | 16 GB |
| Disco | 40 GB SSD | 100 GB SSD |
| Rede | 10 Mbps saída (para LLM provider) | 50 Mbps |

O serviço Presidio (detecção de PII) consome aproximadamente 1.5 GB de RAM ao carregar os modelos spaCy em português. Planeje a memória levando isso em consideração.

### Hardware para produção (100+ usuários)

| Recurso | Recomendado |
|---------|-------------|
| CPU | 16 vCPU |
| RAM | 32 GB |
| Disco | 500 GB SSD (audit logs crescem com uso) |
| Rede | 100 Mbps |

### Software

| Requisito | Versão mínima |
|-----------|---------------|
| Sistema Operacional | Ubuntu 22.04 LTS / RHEL 8+ / Amazon Linux 2023 |
| Docker Engine | 24.0+ |
| Docker Compose | v2.20+ (plugin integrado ao Docker) |
| Git | 2.30+ |
| curl | Qualquer versão recente |
| Acesso à internet | Necessário APENAS para pull de imagens Docker e chamadas ao provider LLM |

### Acesso de rede (saída)

A plataforma precisa de acesso de saída (egress) para:

| Destino | Porta | Motivo | Obrigatório? |
|---------|-------|--------|--------------|
| api.groq.com | 443 | Provider LLM (Groq) | Sim (se usar Groq) |
| api.anthropic.com | 443 | Provider LLM (Anthropic) | Sim (se usar Anthropic) |
| generativelanguage.googleapis.com | 443 | Provider LLM (Google) | Sim (se usar Google) |
| ghcr.io, docker.io | 443 | Pull de imagens Docker | Apenas no deploy |
| graph.microsoft.com | 443 | Shield — detecção Shadow AI via M365 | Opcional (Shield) |
| admin.googleapis.com | 443 | Shield — detecção Shadow AI via Google | Opcional (Shield) |

Nenhuma porta de entrada (ingress) precisa estar aberta além da porta do admin-ui para os navegadores dos usuários.

---

## 3. Preparação do Servidor

### 3.1 Instalar Docker

```bash
# Ubuntu 22.04 / 24.04
sudo apt update
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Verificar instalação
docker --version   # Espera: Docker version 24.0+
docker compose version   # Espera: Docker Compose version v2.20+

# Adicionar usuário ao grupo docker (evita sudo em cada comando)
sudo usermod -aG docker $USER
newgrp docker
```

### 3.2 Criar diretório da aplicação

```bash
sudo mkdir -p /opt/govai
sudo chown $USER:$USER /opt/govai
cd /opt/govai
```

### 3.3 Clonar o repositório

```bash
git clone https://github.com/mauriciodesouzaads/GovAIPlatform.git .
```

Se o servidor não tem acesso ao GitHub, transfira o repositório como arquivo ZIP:

```bash
# Na máquina com acesso:
git clone https://github.com/mauriciodesouzaads/GovAIPlatform.git
cd GovAIPlatform && zip -r govai-platform.zip . -x ".git/*"

# No servidor:
cd /opt/govai
unzip govai-platform.zip
```

---

## 4. Configuração

### 4.1 Arquivo de ambiente

Copie o template e edite:

```bash
cp .env.example .env
chmod 600 .env   # Apenas o owner pode ler
```

Abra o arquivo `.env` com seu editor preferido e configure as variáveis abaixo.

### 4.2 Variáveis obrigatórias

| Variável | Descrição | Exemplo |
|----------|-----------|---------|
| `GROQ_API_KEY` | Chave de API do provider LLM. Obtenha em console.groq.com | `gsk_abc123...` |
| `DB_PASSWORD` | Senha do superuser PostgreSQL. Gere uma senha forte. | `Kj8$mP2!nQ5vR9xW` |
| `DB_APP_PASSWORD` | Senha do usuário da aplicação (govai_app). Diferente da anterior. | `Yt4@fH7#bL3cN6zA` |
| `REDIS_PASSWORD` | Senha do Redis. | `Xm9!pK2$wE5jR8vD` |
| `SIGNING_SECRET` | Segredo para assinatura HMAC dos audit logs. Mínimo 32 caracteres. | `sua-chave-hmac-com-pelo-menos-32-caracteres-aleatorios` |
| `JWT_SECRET` | Segredo para assinatura de tokens JWT. Mínimo 32 caracteres. Diferente do anterior. | `sua-chave-jwt-com-pelo-menos-32-caracteres-aleatorios` |

Para gerar senhas e segredos fortes:

```bash
# Gerar senha de 24 caracteres alfanuméricos + especiais
openssl rand -base64 32 | tr -d '=/+' | head -c 24

# Gerar segredo de 48 caracteres para SIGNING_SECRET e JWT_SECRET
openssl rand -hex 24
```

### 4.3 Variáveis opcionais

| Variável | Descrição | Default |
|----------|-----------|---------|
| `AI_MODEL` | Modelo LLM padrão | `groq/llama-3.3-70b-versatile` |
| `LITELLM_KEY` | Chave interna do LiteLLM proxy | `local-dev-litellm-key` |
| `SMTP_HOST` | Servidor SMTP para alertas por email | (desativado) |
| `SMTP_PORT` | Porta SMTP | `587` |
| `SMTP_USER` | Usuário SMTP | (desativado) |
| `SMTP_PASS` | Senha SMTP | (desativado) |
| `MICROSOFT_TENANT_ID` | Tenant ID do Microsoft 365 (para Shield) | (desativado) |
| `MICROSOFT_CLIENT_ID` | Client ID do app registration Azure AD | (desativado) |
| `MICROSOFT_CLIENT_SECRET` | Client secret do app registration | (desativado) |
| `GOOGLE_ADMIN_EMAIL` | Email do admin Google Workspace (para Shield) | (desativado) |
| `GOOGLE_ADMIN_TOKEN` | Token de serviço Google Admin SDK | (desativado) |

### 4.4 Configuração do Shield (detecção de Shadow AI)

O Shield detecta ferramentas de IA não autorizadas via integração com Microsoft 365 e/ou Google Workspace. A configuração é opcional para o PoC — o produto funciona sem ela, mas o Shield não terá dados de detecção automática.

**Para Microsoft 365:**

1. No Azure Portal, registre um aplicativo (App Registration)
2. Conceda permissão Application: `Directory.Read.All`, `Application.Read.All`
3. Crie um client secret
4. Preencha no .env: `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`

**Para Google Workspace:**

1. No Google Cloud Console, ative a Admin SDK API
2. Crie uma Service Account com delegação de domínio
3. Conceda escopo: `https://www.googleapis.com/auth/admin.directory.user.readonly`
4. Preencha no .env: `GOOGLE_ADMIN_EMAIL`, `GOOGLE_ADMIN_TOKEN`

### 4.5 Configuração de provedores LLM alternativos

O arquivo `litellm-config.yaml` define quais modelos LLM estão disponíveis. O padrão inclui Groq (Llama 3.3), Anthropic (Claude) e Google (Gemini). Para usar outros provedores, edite o arquivo:

```bash
vi litellm-config.yaml
```

Para usar apenas Groq (configuração mais simples para PoC):

```yaml
model_list:
  - model_name: govai-llm
    litellm_params:
      model: groq/llama-3.3-70b-versatile
      api_key: os.environ/GROQ_API_KEY
```

Para adicionar Anthropic ou Google, adicione blocos adicionais com as respectivas API keys como variáveis de ambiente no `.env`.

---

## 5. Deploy

### 5.1 Construir as imagens

```bash
cd /opt/govai
docker compose build
```

Tempo estimado: 5-10 minutos na primeira execução (download de imagens base + instalação de dependências). Execuções subsequentes são mais rápidas por cache.

### 5.2 Iniciar os serviços

```bash
docker compose up -d
```

### 5.3 Aguardar inicialização

A inicialização completa leva aproximadamente 2 minutos. O serviço Presidio (detecção de PII) é o mais lento porque precisa carregar modelos de linguagem natural em português.

Acompanhe o progresso:

```bash
# Monitorar status dos containers
watch docker compose ps

# Monitorar logs da API (migrations + seed)
docker compose logs -f api
```

Você deve ver no log da API:

```
[1/3] Running migrations...
✅ Todas as migrations finalizadas com sucesso.
[2/3] Applying demo seed (conditional)...
[SEED] Database is empty — applying demo seed...
✅ seed.sql aplicado.
[3/3] Starting API server...
Server listening on 0.0.0.0:3000
```

### 5.4 Verificar que todos os serviços estão saudáveis

```bash
docker compose ps
```

Resultado esperado:

```
NAME                    STATUS              PORTS
govai-database-1        Up (healthy)        5432/tcp
govai-redis-1           Up (healthy)        6379/tcp
govai-litellm-1         Up (healthy)        4000/tcp
govai-presidio-1        Up (healthy)        5001/tcp
govai-api-1             Up (healthy)        3000/tcp
govai-admin-ui-1        Up                  0.0.0.0:3001->3001/tcp
```

Todos os 6 serviços devem estar "Up". Os serviços com healthcheck mostram "(healthy)".

### 5.5 Verificar endpoints

```bash
# API health
curl -s http://localhost:3000/health | python3 -m json.tool
# Esperado: {"status":"ok","db":"connected","redis":"connected","litellm":"connected"}

# Admin UI
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001
# Esperado: 200
```

### 5.6 Acessar a interface

Abra no navegador: `http://<IP-DO-SERVIDOR>:3001`

Credenciais iniciais (demo):

| Email | Senha | Papel |
|-------|-------|-------|
| admin@orga.com | GovAI2026@Admin | Administrador |
| compliance@orga.com | GovAI2026@Admin | Compliance Officer (DPO) |
| dev@orga.com | GovAI2026@Admin | Operador técnico |
| ciso@orga.com | GovAI2026@Admin | CISO |

**IMPORTANTE:** Troque todas as senhas no primeiro acesso. As credenciais acima são exclusivamente para avaliação inicial.

---

## 6. Configuração para Produção

### 6.1 TLS/HTTPS

Para produção, configure um reverse proxy com TLS na frente do admin-ui. Exemplo com Nginx:

```nginx
# /etc/nginx/sites-available/govai
server {
    listen 443 ssl http2;
    server_name govai.suaempresa.com.br;

    ssl_certificate     /etc/ssl/certs/govai.crt;
    ssl_certificate_key /etc/ssl/private/govai.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # Interface web
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # API (necessário para o chat governado e integrações)
    location /v1/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name govai.suaempresa.com.br;
    return 301 https://$server_name$request_uri;
}
```

### 6.2 Volumes persistentes

O docker-compose.yml já configura volumes para PostgreSQL e Redis. Para produção, garanta que esses volumes estejam em disco SSD com backup:

```yaml
volumes:
  pgdata:
    driver: local
    driver_opts:
      type: none
      device: /data/govai/postgres   # Monte em disco dedicado
      o: bind
  redisdata:
    driver: local
    driver_opts:
      type: none
      device: /data/govai/redis
      o: bind
```

### 6.3 Backup do banco de dados

Configure backup diário automatizado:

```bash
# /opt/govai/scripts/backup.sh
#!/bin/bash
BACKUP_DIR="/data/backups/govai"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

docker compose exec -T database pg_dump -U postgres govai_platform \
  | gzip > "$BACKUP_DIR/govai_${TIMESTAMP}.sql.gz"

# Manter apenas os últimos 30 backups
ls -t "$BACKUP_DIR"/govai_*.sql.gz | tail -n +31 | xargs rm -f 2>/dev/null

echo "[BACKUP] govai_${TIMESTAMP}.sql.gz criado em $BACKUP_DIR"
```

```bash
chmod +x /opt/govai/scripts/backup.sh

# Agendar no cron (diário às 02:00)
echo "0 2 * * * /opt/govai/scripts/backup.sh >> /var/log/govai-backup.log 2>&1" | crontab -
```

### 6.4 Restauração de backup

```bash
# Parar a API (manter banco rodando)
docker compose stop api admin-ui

# Restaurar
gunzip -c /data/backups/govai/govai_20260408_020000.sql.gz \
  | docker compose exec -T database psql -U postgres govai_platform

# Reiniciar
docker compose up -d
```

### 6.5 Monitoramento

A API expõe métricas Prometheus em `/metrics`. Para integrar com seu stack de monitoramento:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'govai-api'
    static_configs:
      - targets: ['<IP-DO-SERVIDOR>:3000']
    metrics_path: '/metrics'
```

Métricas disponíveis: requisições por segundo, latência P95, erros por tipo, tokens consumidos, uso de quota por organização.

---

## 7. Troubleshooting

### Problema: API não inicia — "migration failed"

**Causa:** Migrations que alteram políticas de segurança (RLS) requerem superuser PostgreSQL. O script de migração já trata isso automaticamente desde a versão atual.

**Verificação:**
```bash
docker compose logs api | grep -i "error\|failed\|migration"
```

**Solução:** Se houver falha em migration específica:
```bash
# Aplicar migration manualmente como superuser
docker compose exec database psql -U postgres -d govai_platform -f /app/<MIGRATION_FILE>.sql

# Reiniciar API
docker compose restart api
```

### Problema: Presidio demora mais de 2 minutos para iniciar

**Causa:** O Presidio baixa modelos spaCy na primeira execução. Em redes com largura de banda limitada ou proxy corporativo, isso pode levar mais tempo.

**Verificação:**
```bash
docker compose logs presidio | tail -20
```

**Solução:** Aumente o `start_period` do healthcheck do Presidio no docker-compose.yml:
```yaml
presidio:
  healthcheck:
    start_period: 180s   # Aumente de 60s para 180s
```

Se o proxy corporativo bloqueia o download, baixe os modelos manualmente e monte como volume:
```bash
# Em máquina com acesso
docker run --rm -v presidio_models:/models python:3.11 \
  pip install spacy && python -m spacy download pt_core_news_lg -t /models

# Monte o volume no docker-compose.yml
presidio:
  volumes:
    - presidio_models:/app/models
```

### Problema: LiteLLM health check mostra "disconnected"

**Causa:** O endpoint /health da API verifica o LiteLLM via HTTP. O LiteLLM pode retornar respostas grandes (50KB+) que causam timeout, mesmo estando funcional.

**Verificação:**
```bash
# Verificar diretamente se o LiteLLM está respondendo
curl -s http://localhost:4000/health | head -c 200
```

**Impacto:** Nenhum. É um falso negativo no health check. As execuções de LLM funcionam normalmente. O status "disconnected" no /health da API pode ser ignorado se o curl acima retornar resposta.

### Problema: Chat governado não responde

**Causa provável:** A GROQ_API_KEY não está configurada ou é inválida.

**Verificação:**
```bash
# Testar chamada LLM diretamente
curl -s http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LITELLM_KEY" \
  -d '{"model":"govai-llm","messages":[{"role":"user","content":"teste"}]}' | head -c 200
```

**Solução:** Verifique a GROQ_API_KEY no .env, confirme que não expirou, e reinicie o LiteLLM:
```bash
docker compose restart litellm
```

### Problema: Dados aparecem vazios na interface

**Causa:** O seed de dados demo não executou ou falhou parcialmente.

**Verificação:**
```bash
docker compose exec database psql -U postgres -d govai_platform -c \
  "SELECT COUNT(*) as orgs FROM organizations;
   SELECT COUNT(*) as assistants FROM assistants;
   SELECT COUNT(*) as findings FROM shield_findings;
   SELECT COUNT(*) as logs FROM audit_logs;"
```

**Solução:** Se as contagens são zero, re-execute o seed manualmente:
```bash
docker compose exec api sh -c "cd /app && sh scripts/seed.sh"
```

### Problema: Permissão negada ao acessar http://IP:3001

**Causa:** Firewall do servidor bloqueando a porta 3001.

**Solução:**
```bash
# Ubuntu (UFW)
sudo ufw allow 3001/tcp

# RHEL/CentOS (firewalld)
sudo firewall-cmd --add-port=3001/tcp --permanent
sudo firewall-cmd --reload
```

Para produção com TLS, abra apenas a porta 443 e use o reverse proxy Nginx descrito na seção 6.1.

---

## 8. Atualizações

Para atualizar a plataforma para uma nova versão:

```bash
cd /opt/govai

# 1. Backup antes de atualizar
./scripts/backup.sh

# 2. Baixar nova versão
git pull origin main

# 3. Reconstruir imagens
docker compose build --no-cache

# 4. Aplicar atualização (migrations rodam automaticamente)
docker compose down
docker compose up -d

# 5. Verificar
docker compose ps
curl -s http://localhost:3000/health
```

As migrations são idempotentes e aplicadas automaticamente na inicialização. Dados existentes são preservados.

---

## 9. Desinstalação

Para remover completamente a plataforma e todos os dados:

```bash
cd /opt/govai

# Parar e remover containers + volumes (APAGA TODOS OS DADOS)
docker compose down -v

# Remover imagens
docker compose down --rmi all

# Remover diretório
cd / && sudo rm -rf /opt/govai
```

---

## 10. Suporte

| Canal | Contato | SLA |
|-------|---------|-----|
| Email técnico | suporte@govai.com.br | 24h úteis |
| Emergência (produção) | +55 (XX) XXXXX-XXXX | 4h |
| Portal de documentação | docs.govai.com.br | — |

Para reportar problemas, inclua:
1. Saída de `docker compose ps`
2. Saída de `docker compose logs api --tail 50`
3. Saída de `curl http://localhost:3000/health`
4. Descrição do comportamento observado vs esperado

---

*GovAI GRC Platform — Documentação de Implantação Self-Hosted v1.0*  
*Documento gerado em Abril 2026. Uso restrito ao time de infraestrutura do cliente durante o período de PoC.*
