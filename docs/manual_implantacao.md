# Manual de Implantação e Instalação: GOVERN.AI

Este guia cobre os procedimentos técnicos para a implantação segura da plataforma Cloud/On-Premise usando a abordagem "Docker-first". O repositório já se encontra configurado para rodar em *Containers*, facilitando de ponta a ponta todas as dependências (Node, BD, Redis e Python).

---

## 1. Requisitos de Infraestrutura
**Para Ambiente Local / Testes:**
- Docker Desktop (v20+)
- Processador Multi-core (M1/M2/i5+) e 8GB de RAM mínima.

**Para Produção (Sugestão - AWS/GCP):**
- **EC2 / VM:** c6g.xlarge ou superior (4 vCPU, 8GB RAM).
- **RDS / Cloud SQL:** PostgreSQL 15 com extensão `pgvector` habilitada nativamente (túnel TLS/SSL configurado).
- **ElastiCache:** Redis 7 para o Rate Limiting e gerenciamento de filas (BullMQ).
- **Network:** Load Balancer atachado para Terminação de TLS (HTTPS port 443).

## 2. Configurando o Ambiente (`.env`)
Clone o repositório principal e copie o template para iniciar as parametrizações.

```bash
git clone https://github.com/mauriciodesouzaads/GovAIPlatform.git
cd GovAIPlatform
cp .env.example .env
```

Campos essenciais (Nunca suba este arquivo para o git!):
1. `GEMINI_API_KEY`: A chave oficial para comunicação LLM que será servida via proxy LiteLLM.
2. `SIGNING_SECRET`: Chave simétrica utilizada pelo Auth Module. Deve conter 32 caracteres gerados de preferência em um cofre cibernético (`openssl rand -hex 32`).
3. `JWT_SECRET`: Para a codificação padrão de UI Tokens (Painel de Administração).
4. `ORG_MASTER_KEY`: Somente injetada via console (BYOK) AES-256 no Dashboard na aba "Offboarding"/"Segurança" (se aplicável ao perfil `standalone`).

## 3. Subindo a Stack via Docker Compose
Na raiz do repositório, faça o build e inicie os 6 microserviços.

```bash
docker compose up --build -d
```
> O parâmetro `-d` garante que os serviços rodem em modo *detached*.

### Healthchecks Automáticos
Você pode acompanhar a estabilidade dos containers utilizando:
```bash
docker compose ps
# O status de TODOS os conteiners precisa estar contendo (healthy).
```

## 4. Bootstrapping Inicial: Migrations de Banco de Dados
A plataforma **NÃO** aplica as mudanças estruturais DDL durante a subida (o que mitiga perda acidental de dados em restarts). Sendo a primeira vez implementando o sistema no Banco PostgreSQL, rode o injetor DDL de migrações em lote pela própria CLI do Fastify API:

```bash
docker exec govai-platform-api-1 bash scripts/migrate.sh
```
Isto injetará na sequência correta: Tabela de tenants, Audit logs, API Keys particionadas, HNSW Vector embeddings para RAG, etc.

## 5. Configuração do Single Sign-On (Entra ID / Okta)
Para acessar com infraestrutura federativa de domínio (Ex: Microsoft Azure):
1. **URI de Redirect:** Nos portais Auth0/Azure, registre a URI base do seu domínio com final: `/v1/auth/sso/callback`.
2. Insira as credenciais exportadas da nuvem no `.env`:
   - `OIDC_ISSUER_URL`
   - `OIDC_CLIENT_ID`
   - `OIDC_CLIENT_SECRET`
   - `OIDC_REDIRECT_URI`
3. Reinicie a API (`docker compose restart api`). Ao acessar via `admin-ui`, um JIT (Just-In-Time) provisioning injetará o usuário permanentemente dentro da GovAI se ele for certificado com sucesso pelo IdP da Microsoft.

## 6. Smoke Tests & Acesso
- O portal de Administração e FinOps subirá blindado logicamente na porta estática `3001`: `http://localhost:3001` (na AWS, mapeie seu domínio raiz para este container).
- Todos as requisições APIs, webhooks, ou telemetrias Prometheus ficarão concentradas no Nginx ou Reverse Proxy mirando a porta `3000`.

**Credencial de Teste (Bootstrapping manual):**
Login: `admin@govai.com`
Senha: `admin`
*(Lembre-se de mudar estes valores injetáveis no `.env` sob `ADMIN_EMAIL` para impedir senhas default ativas).*
