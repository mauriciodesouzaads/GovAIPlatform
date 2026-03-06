# 🏛️ GOVERN.AI Platform
### Corporate Governance & Security Layer for AI Agents

![GovAI Flow](./docs/assets/flow.png)

**GOVERN.AI** is a zero-trust governance platform designed to protect corporate AI interactions. It acts as an intelligent firewall between your users/applications and Large Language Models (LLMs), ensuring every request is inspected for data leaks, policy violations, and prompt injections before reaching the AI provider.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5.0-black?logo=fastify)](https://www.fastify.io/)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-blue?logo=postgresql)](https://www.postgresql.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker)](https://www.docker.com/)
[![Tests](https://img.shields.io/badge/Tests-186%2F186-brightgreen?logo=vitest)](https://vitest.dev/)

---

## 💎 Pilares de Defesa e Auditoria

A plataforma opera em um modelo de **Defesa em Profundidade**, onde cada interação percorre um pipeline rigoroso de segurança:

1.  **🛡️ OPA Engine (4 Estágios)**: 
    *   **Estágio 1: DLP Semântico**: Identificação de PII (CPF, Cartões, Emails) via regex e NLP (spacy/Presidio).
    *   **Estágio 2: Blacklist**: Bloqueio de tópicos proibidos configuráveis por Agente.
    *   **Estágio 3: Injection Prevention**: Motor WASM nativo detectando tentativas de bypass de instruções.
    *   **Estágio 4: HITL (Human-in-the-Loop)**: Quarentena de 48h para termos de alto risco financeiro.
2.  **🔐 Isolamento Multi-Tenant (RLS)**: Aplicação estrita de Row-Level Security no PostgreSQL, garantindo que um tenant nunca acesse dados de outro, mesmo em falhas de aplicação.
3.  **⚖️ Trilha de Auditoria Imutável**: Logs selados com HMAC-SHA256 e criptografados com AES-256-GCM (BYOK), permitindo auditoria forense e conformidade regulatória (BCB 4.557/17).
4.  **💰 Controle FinOps**: Gestão de quotas em tempo real com Hard/Soft Caps para evitar estouro de orçamento Cloud.

---

## 📐 Fluxo de Interação

O diagrama acima ilustra o ciclo de vida de uma requisição:
- **User App** solicita execução via API Key segura.
- **GovAI Gateway** intercepta, valida tokens, aplica o motor OPA/DLP e verifica quotas.
- **Audit Log** registra a intenção (criptografada e assinada).
- **AI Models** recebem apenas o prompt blindado e sanitizado.
- **Results** retornam ao usuário com rastreabilidade total (Trace ID).

---

## 📂 Estrutura do Repositório (Arvore de Projeto)

```text
govai-platform/
├── admin-ui/                # Frontend Administrativo (Next.js 16)
│   ├── src/app/             # Router e Páginas (Dashboard, Logs, Assistants)
│   ├── components/          # UI Components (Cards de FinOps, Gráficos)
│   └── public/              # Assets estáticos
├── src/                     # Backend Core (Fastify + TypeScript)
│   ├── server.ts            # Orquestrador e Registro de Plugins
│   ├── routes/              # Definição de Endpoints (Admin, Assistants, SSO)
│   ├── lib/                 # Motores de Governança
│   │   ├── opa-governance.ts # Integração OPA WASM (4 estágios)
│   │   ├── dlp-engine.ts    # Detetores de PII e Hook Presidio
│   │   ├── crypto-service.ts # AES-256-GCM + BYOK Logic
│   │   ├── finops.ts        # Enforcement de Quotas e Custos
│   │   └── rag.ts           # Motor RAG com pgvector
│   ├── workers/             # Processamento Assíncrono (BullMQ)
│   │   ├── audit.worker.ts  # Persistência Criptografada de Logs
│   │   └── telemetry.worker.ts # Exportação para Langfuse
│   └── __tests__/           # Suite de Testes (186 casos de teste)
├── presidio/                # Microserviço NLP (Python/FastAPI)
├── docs/                    # Documentação Técnica e Manuais
│   ├── assets/              # Imagens de Arquitetura e Fluxo
│   ├── dossie_tecnico.md    # Visão para C-Level e Arquitetos
│   └── manifesto_seguranca.md # Garantias Técnicas de Hardening
├── scripts/                 # Utilitários de Setup e Migração
├── *.sql                    # Evolução de Schema (Migrations 011-021)
├── docker-compose.yml       # Orquestração de 6 containers
└── README.md                # Este documento
```

---

## 🚀 Como Iniciar

### 1. Deploy Rápido
```bash
git clone https://github.com/mauriciodesouzaads/GovAIPlatform.git
cd GovAIPlatform
cp .env.example .env
# Configure suas chaves no .env (GEMINI_API_KEY, etc.)
docker compose up --build -d
```

### 2. Inicialização do Banco
```bash
docker exec govai-platform-api-1 bash scripts/migrate.sh
```

### 3. Acesso Padrão
- **Admin UI**: `http://localhost:3001` (User: `admin@govai.com` / Pass: `admin`)
- **API Spec**: `http://localhost:3000/v1/docs/openapi.json`

---

## ✅ Certificação de Prontidão (Audit 2026)

A plataforma foi validada em cenário real (clean-wipe), garantindo:
- **100%** de isolamento em testes de RLS.
- **Zero** vazamento de PII em prompts auditados.
- **Resiliência** contra ataques de injeção em motor OPA WASM.

---

## 👤 Autor

**Maurício de Souza**  
Senior Software Architect | Cloud Security Specialist  
[GitHub Profile](https://github.com/mauriciodesouzaads)

---
*License: MIT — Professional Enterprise Software for Governance & AI Safety.*
