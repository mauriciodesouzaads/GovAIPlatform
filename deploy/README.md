# GovAI Platform — Guia de Deploy

Este documento descreve como fazer o deploy do GovAI Platform em quatro plataformas diferentes.

---

## Pré-requisitos Comuns

1. **Secrets configurados** — copie `.env.prod.example` para `.env.prod` e preencha todos os valores
2. **Certificados SSL** — obrigatório em produção (Let's Encrypt, ACM, etc.)
3. **GEMINI_API_KEY** válida — obter em [Google AI Studio](https://aistudio.google.com/app/apikey)
4. **Banco de dados** com pgvector suportado (PostgreSQL 15+)

Geração de secrets:
```bash
openssl rand -hex 32   # → JWT_SECRET, SIGNING_SECRET, METRICS_API_KEY
openssl rand -hex 32   # → ORG_MASTER_KEY (CRÍTICO: guarde em Vault)
openssl rand -base64 32  # → DB_PASSWORD, DB_APP_PASSWORD, REDIS_PASSWORD
```

---

## Opção 1 — VPS (Ubuntu 22.04)

Servidor único com Docker Compose. Recomendado para até ~500 usuários.

### Requisitos
- VPS com Ubuntu 22.04 LTS, mínimo 4 vCPU / 8 GB RAM / 80 GB SSD
- Portas 80 e 443 abertas
- Acesso SSH com chave pública

### Deploy Inicial

```bash
# 1. No servidor: criar diretório e copiar .env.prod
ssh user@your-server.com
sudo mkdir -p /opt/govai-platform
sudo nano /opt/govai-platform/.env.prod   # preencha com seus valores

# 2. Certificados SSL (Let's Encrypt via certbot)
sudo apt-get install -y certbot
sudo certbot certonly --standalone \
  -d api.yourdomain.com \
  -d admin.yourdomain.com \
  --email your-email@yourdomain.com --agree-tos
sudo mkdir -p /etc/ssl/govai
sudo cp /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem /etc/ssl/govai/cert.pem
sudo cp /etc/letsencrypt/live/api.yourdomain.com/privkey.pem /etc/ssl/govai/key.pem

# 3. Executar script de deploy
REPO_URL=https://github.com/your-org/govai-platform.git \
  sudo -E bash deploy/vps.sh
```

### Updates Posteriores

```bash
cd /opt/govai-platform
sudo REPO_URL=https://github.com/your-org/govai-platform.git \
  BRANCH=main bash deploy/vps.sh
```

### Renovação de Certificados (cron)

```bash
# Adicionar ao crontab root:
0 3 * * * certbot renew --quiet && \
  cp /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem /etc/ssl/govai/cert.pem && \
  cp /etc/letsencrypt/live/api.yourdomain.com/privkey.pem /etc/ssl/govai/key.pem && \
  docker exec govai-nginx nginx -s reload
```

---

## Opção 2 — AWS ECS + RDS

Arquitetura gerenciada com alta disponibilidade. Recomendado para produção enterprise.

### Arquitetura

```
Internet → ALB (HTTPS) → ECS Fargate Tasks
                           ├── govai-api (2+ réplicas)
                           └── govai-admin-ui (2+ réplicas)
                         → RDS PostgreSQL 15 (Multi-AZ) + pgvector extension
                         → ElastiCache Redis (Multi-AZ)
                         → ECR (imagens Docker)
```

### Pré-requisitos AWS

- AWS CLI configurada (`aws configure`)
- ECR repositories criados:
  ```bash
  aws ecr create-repository --repository-name govai-api
  aws ecr create-repository --repository-name govai-admin-ui
  aws ecr create-repository --repository-name govai-presidio
  ```
- RDS PostgreSQL 15 com extensão `pgvector`:
  ```sql
  CREATE EXTENSION IF NOT EXISTS vector;
  ```
- ElastiCache Redis 7 com autenticação

### Build e Push de Imagens

```bash
AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION=us-east-1
ECR_BASE="$AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com"

aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $ECR_BASE

# Build e push da API
docker build -t govai-api .
docker tag govai-api:latest $ECR_BASE/govai-api:latest
docker push $ECR_BASE/govai-api:latest

# Build e push do Admin UI
docker build -t govai-admin-ui \
  --build-arg NEXT_PUBLIC_API_URL=https://api.yourdomain.com \
  -f admin-ui/Dockerfile.admin ./admin-ui
docker tag govai-admin-ui:latest $ECR_BASE/govai-admin-ui:latest
docker push $ECR_BASE/govai-admin-ui:latest
```

### Task Definition (exemplo para a API)

```json
{
  "family": "govai-api",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "containerDefinitions": [{
    "name": "api",
    "image": "${ECR_BASE}/govai-api:latest",
    "portMappings": [{"containerPort": 3000}],
    "environment": [
      {"name": "NODE_ENV", "value": "production"},
      {"name": "LITELLM_URL", "value": "http://litellm-service:4000"}
    ],
    "secrets": [
      {"name": "DATABASE_URL", "valueFrom": "arn:aws:ssm:us-east-1:ACCOUNT:parameter/govai/DATABASE_URL"},
      {"name": "JWT_SECRET", "valueFrom": "arn:aws:ssm:us-east-1:ACCOUNT:parameter/govai/JWT_SECRET"}
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/govai-api",
        "awslogs-region": "us-east-1",
        "awslogs-stream-prefix": "ecs"
      }
    }
  }]
}
```

### Migrations no ECS

```bash
# Rodar como ECS Task one-off antes de atualizar o serviço
aws ecs run-task \
  --cluster govai-prod \
  --task-definition govai-migrate \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx]}"
```

---

## Opção 3 — Google Cloud Run

Deploy serverless. Escala a zero quando sem tráfego. Recomendado para ambientes com uso variável.

### Pré-requisitos

- `gcloud` CLI instalada e autenticada
- Projeto GCP com Cloud Run, Artifact Registry e Cloud SQL habilitados
- Cloud SQL PostgreSQL 15 com pgvector

### Build e Push (Artifact Registry)

```bash
PROJECT_ID=your-gcp-project-id
REGION=us-central1
AR_BASE="$REGION-docker.pkg.dev/$PROJECT_ID/govai"

# Criar repositório no Artifact Registry
gcloud artifacts repositories create govai \
  --repository-format=docker --location=$REGION

# Build e push
gcloud builds submit --tag "$AR_BASE/govai-api:latest" .
gcloud builds submit --tag "$AR_BASE/govai-admin-ui:latest" \
  --build-arg NEXT_PUBLIC_API_URL=https://api.yourdomain.com \
  ./admin-ui
```

### Deploy da API no Cloud Run

```bash
gcloud run deploy govai-api \
  --image "$AR_BASE/govai-api:latest" \
  --region $REGION \
  --platform managed \
  --allow-unauthenticated \
  --port 3000 \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 1 \
  --max-instances 10 \
  --set-env-vars NODE_ENV=production \
  --set-secrets "JWT_SECRET=govai-jwt-secret:latest,DATABASE_URL=govai-db-url:latest"
```

### Cloud SQL Proxy (para acesso ao banco)

```bash
# A API precisa do Cloud SQL Proxy sidecar ou da conexão via Cloud SQL Connector
# No Cloud Run, use a variável de ambiente INSTANCE_CONNECTION_NAME:
--add-cloudsql-instances "$PROJECT_ID:$REGION:govai-db" \
--set-env-vars "INSTANCE_CONNECTION_NAME=$PROJECT_ID:$REGION:govai-db"
```

### Migrations no Cloud Run

```bash
gcloud run jobs create govai-migrate \
  --image "$AR_BASE/govai-api:latest" \
  --region $REGION \
  --command "bash,scripts/migrate.sh" \
  --set-secrets "DATABASE_URL=govai-db-url:latest"

gcloud run jobs execute govai-migrate --region $REGION --wait
```

---

## Opção 4 — Render.com

Deploy mais simples via interface web. Recomendado para MVPs e demos.

### Configuração

1. **Criar conta** em [render.com](https://render.com) e conectar o repositório GitHub

2. **Banco de dados**: New → PostgreSQL
   - Nome: `govai-db`
   - Plano: Standard (pgvector suportado)
   - Após criar, anote a `Internal Database URL`

3. **Redis**: New → Redis
   - Nome: `govai-redis`
   - Plano: Starter
   - Anote a `Internal Redis URL`

4. **API**: New → Web Service
   - Repositório: seu fork
   - Branch: `main`
   - Build Command: `npm ci && npx tsc --noEmit`
   - Start Command: `node dist/server.js`
   - Plano: Standard
   - **Environment Variables**: adicionar todas as variáveis do `.env.prod.example`
     - `DATABASE_URL` → Internal Database URL do passo 2
     - `REDIS_URL` → Internal Redis URL do passo 3
     - Todos os outros secrets

5. **Admin UI**: New → Web Service
   - Root Directory: `admin-ui`
   - Build Command: `npm ci && npm run build`
   - Start Command: `npm run start`
   - Environment Variables:
     - `NEXT_PUBLIC_API_URL` → URL do serviço API criado no passo 4
     - `PORT=3001`

6. **Migrations**: no Dashboard do serviço API, vá em **Shell** e execute:
   ```bash
   DATABASE_URL=$DATABASE_URL bash scripts/migrate.sh
   ```

### Limitações do Render
- LiteLLM e Presidio precisam de serviços separados (Docker não suportado no plano básico)
- Para LiteLLM, use o serviço direto da API Gemini sem proxy (remova `LITELLM_URL` e use `GEMINI_API_KEY` diretamente)
- Presidio pode ser desabilitado setando `PRESIDIO_URL=""` (DLP Tier 2 ficará inativo)

---

## Checklist Pós-Deploy

- [ ] Certificados SSL válidos (sem warning no browser)
- [ ] `GET https://api.yourdomain.com/health` retorna `{"status":"ok"}`
- [ ] Login no Admin UI com `admin@orga.com` (ou usuário criado via seed)
- [ ] Dashboard mostra métricas reais
- [ ] Criar assistente + executar prompt simples (200 OK com resposta da IA)
- [ ] Prompt injection bloqueado (403 POLICY_VIOLATION)
- [ ] Audit logs registrando execuções
- [ ] Prometheus scraping `/metrics` (verificar no Grafana)
- [ ] AlertManager configurado e testado com alerta de teste

---

## Troubleshooting

| Sintoma | Causa Provável | Fix |
|---|---|---|
| API retorna 500 em `/health` | DATABASE_URL errado ou banco sem migrations | Verificar URL e rodar `migrate.sh` |
| Login retorna 401 | JWT_SECRET diferente entre restarts | Garantir JWT_SECRET consistente no `.env.prod` |
| LiteLLM 401 Unauthorized | LITELLM_KEY não coincide com master_key | Verificar `litellm-config.yaml` e `LITELLM_KEY` |
| Presidio timeout | Container não iniciou (OOM) | Aumentar memory limit ou desabilitar Presidio |
| `pgvector` não instalado | Imagem errada do Postgres | Usar `pgvector/pgvector:pg15` |
| Nginx 502 Bad Gateway | API ainda iniciando | Aguardar healthcheck passar (30s) |
