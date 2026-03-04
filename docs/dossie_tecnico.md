# Dossiê Técnico: GOVERN.AI Platform

## 1. Visão Executiva e Propósito
A **GOVERN.AI Platform** é uma plataforma corporativa avançada de Governança B2B para Agentes Virtuais (LLMs). O sistema atua como um "Gatekeeper" zero-trust: nenhuma requisição chega a uma inteligência artificial (OpenAI, Gemini, Anthropic) sem antes passar por um rigoroso motor de inspeção de 4 estágios. 

**Objetivo Central:** Prevenir vazamento de dados corporativos ou bancários (PII/PHI), mitigar ataques de injeção de prompt e fornecer uma trilha de auditoria criptográfica imutável em conformidade com o **Banco Central (Resolução 4.557/17)** e a **LGPD**.

## 2. Arquitetura do Sistema
O projeto foi construído em uma arquitetura de micro-serviços modularizada utilizando **Docker Compose**.

### 2.1 Componentes Principais
1. **API Gateway (Fastify / Node.js 20):** Roteador central assíncrono projetado para altíssimo throughput com baixo overhead de memória. Orquestra a autenticação, o motor OPA, o RAG e despacha para LLMs.
2. **Motor NLP Semântico (Presidio / Python 3.11):** Um micro-serviço satélite FastAPI contendo o Microsoft Presidio carregado com modelos `spaCy` em Português (`pt_core_news_sm`). Realiza reconhecimento de entidades nomeadas (NER) e pontuação de probabilidade para encontrar dados que escapam às Expressões Regulares padrão (RegEx).
3. **Database (PostgreSQL 15 + pgvector):** Armazena configurações, logs, chaves de API, e vetores embedados. Aplica **RLS (Row Level Security)** nativo para garantir o multitenant seguro no nível do BD.
4. **Cache & Fila de Eventos (Redis 7 + BullMQ):** Sistema de pub/sub e memória efêmera para Rate Limiting, filas background de Auditoria e webhook distribuído.
5. **AI Proxy (LiteLLM):** Roteia as chamadas para LLMs garantindo um "vendor lock-in free". Permite trocar entre fornecedores (OpenAI, Google) alterando apenas uma string de ambiente.
6. **Admin UI (Next.js 16 / React 19):** Interface visual avançada construída sobre a engine do Turbopack, operando como o portal de segurança, FinOps (Gestão Financeira), e compliance para o C-Level.

### 2.2 Fluxo de Execução Governável (Lifecycle of a Request)
1. **Origem:** O sistema cliente aciona o endpoint `/v1/execute/:assistant_id`.
2. **Auth & FinOps:** O sistema valida a API Key JWT e verifica as cotas de consumo financeiro (Hard/Soft Caps) armazenadas no Redis.
3. **OPA Stage 1 - DLP (Data Loss Prevention):** O prompt do usuário é verificado contra 9 detectores RegEx (ex: CPF, Cartões de Crédito Luhn, PIX, E-mails) e contra o motor semântico NLP (Presidio). Se dados expostos são encontrados, a requisição é `FLAGGED` (redigida) ou `BLOCKED`.
4. **OPA Stage 2 - Blacklist:** Busca de tópicos proibidos previamente configurados no Banco de Dados para o Agente.
5. **OPA Stage 3 - Prompt Injection:** Análise heurística buscando quebras de jailbreak (ex: "ignore all previous instructions").
6. **OPA Stage 4 - Human-In-The-Loop (HITL):** Caso o prompt acione gatilhos de alto risco financeiro (ex: palavras como "transferência", "PIX", "banco"), a requisição entra no estado `PENDING_APPROVAL`. Fica congelada numa fila persistente (Redis Queue) por 48 horas aguardando um Administrador logar fisicamente no Admin UI e aprovar.
7. **RAG Injection (Opcional):** Se aprovado pelos 4 estágios do OPA, o vetor do prompt é injetado no BD via index `HNSW` do `pgvector`. O contexto semântico correspondente corporativo é agrupado à requisição.
8. **LLM Invokation:** A mensagem "limpa" (Blindada) e carregada de contexto via RAG atinge finalmente a API LLM designada através do `LiteLLM Proxy`.
9. **Auditoria Assíncrona:** A resposta é entregue instantâneamente. Em background, o `Audit Worker` (BullMQ) serializa a operação, aplica uma criptografia simétrica AES-256-GCM (BYOK) baseada na chave mestra do tenant e injeta no BD uma assinatura imutável via HMAC-SHA256 para o Cartório Digital.

## 3. Pilares de Segurança Detalhados

### 3.1 Trilha de Auditoria com Verificação Criptográfica (Caixa Negra)
Todos os logs criados nas camadas `EXECUTION_SUCCESS` ou `POLICY_VIOLATION` não são meramente salvos, eles são **"selados"**.
* Utiliza-se um secret root central (`SIGNING_SECRET`).
* Cada linha salva na tabela particionada `audit_logs` contém uma assinatura Hash. 
* Periodicamente, ou através de exports (PDF de Compliance Due Diligence), o sistema valida essa assinatura. Se o dado de uma linha tiver sido alterado por um DBA de forma maliciosa via script manual de banco de dados, o selo HMAC será quebrado informando a fraude (`TAMPERED`).

### 3.2 BYOK (Bring Your Own Key) & Isolamento por Inquilinos (Tenants)
Para operações onde os dados possam não apenas conter logs, mas PIIs armazenados intencionalmente, a GovernAI opera de forma multitenant:
* Os UUIDs isolam as entidades ao nível das visões SQL (RLS - Row Level Security).
* Cada tenant (`organization_id`) pode provisionar uma chave `ORG_MASTER_KEY` exclusiva AES-256 no banco.
* O sistema fornece suporte à tática "Crypto-Shredding": num encerramento B2B severo, a GOVERN.AI exclui a `ORG_MASTER_KEY`; num bilionésimo de segundo, terabytes de dados históricos tornam-se decifravaelmente ininteligíveis provando uma exclusão irrevogável mandatada pela diretriz de oblívio da LGPD.

### 3.3 Single Sign-On B2B
A interface conta com suporte out-of-the-box para fluxos Single-Sign on corporativos (OpenID Connect / OIDC). Está compatibilizado para integração em grandes corporações com Entra ID (Azure AD), Auth0 ou Okta.
* Possui **JIT Provisioning:** o perfil B2B não precisa ser criado previamente no GovAI; na primeira interação OAuth2 originária da Azure, a porta Fastify auto-proporciona a entrada.
* **Rate Limits Distribuidos:** Para mitigar Denial-of-Service por bruta force no login via botnets, os rate-limitings baseados tanto em Auth quanto IPs são centralizados num cluster Redis.

## 4. Infraestrutura como Código (Docker/Compose)
O sistema levanta com `docker-compose up`:
- `api` — Imagem construída em Node.js (Alpine slim).
- `admin-ui` — Imagem construída no formato Standalone Build do Next.js 16 para zero-dependencies.
- `database` — Imagem híbrida Postgres `pgvector` oficial da AWS/Postgresql Community. 
- `litellm` — Imagem BerriAI com suporte a múltiplas versões e proxies de load balancer.
- `presidio` — Backend em Python focado em cálculos de IA não genéricos (NER e SpaCy).

## 5. Portal de Compliance Financeiro (FinOps/Cost Control)
- Ferramenta nativa na Stack Administrativa gerando observabilidade analítica para Custos e Consumo de Tokens (LLM Ledgers). Relacionados às tabelas do Redis como caches de Quota e `estimated_cost_usd` derivados na runtime; fornecendo não só predição financeira, como a inibição hard-cap automática cortando serviço da API KEY se o cap USD mensal for atingido pelo cliente logado.

*Documento gerado como base técnica oficial.*
