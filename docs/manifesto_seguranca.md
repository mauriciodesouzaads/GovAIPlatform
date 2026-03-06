# 🛡️ Manifesto de Segurança: GovAI Platform
**Data de Emissão:** 06 de Março de 2026  
**Status:** VALIDADO (Production Ready)  

A **GovAI Platform** foi construída sob o paradigma de **"Zero-Trust AI Governance"**. Este manifesto detalha os 5 pilares técnicos que garantem a integridade, privacidade e conformidade da plataforma em ambientes de missão crítica.

---

## 1. Isolamento Multi-Tenant Virtualizado (RLS)
Diferente de sistemas que dependem apenas da lógica da aplicação para filtrar dados, a GovAI implementa o **Row Level Security (RLS)** nativo no PostgreSQL 15.
- **Role de Runtime**: O servidor utiliza a role `govai_app`, que possui permissão de leitura restrita.
- **Escopo Atómico**: Cada transação SQL é precedida pela definição de `app.current_org_id`. Isso garante que, mesmo em caso de erro na camada do Node.js, um cliente JAMAIS terá acesso físico aos registros de outro.

## 2. Motor de Governança OPA de 4 Estágios
Implementamos o **Open Policy Agent (OPA)** utilizando binários WebAssembly (WASM) para execução de alta performance e à prova de injeção.
1. **DLP Semântico**: Combinação de 9 detetores RegEx com NLP (Microsoft Presidio) para identificar PII/PHI.
2. **Blacklist Dinâmica**: Bloqueio de tópicos sensíveis configurados por organização.
3. **Prompt Injection Prevention**: Heurísticas avançadas contra ataques de "jailbreak".
4. **Human-in-the-Loop (HITL)**: Pendência de aprovação humana para ações de alto risco financeiro/operacional.

## 3. Cartório Digital & Auditoria Imutável
Cada interação com a IA gera um log de auditoria que é assinado digitalmente.
- **Assinatura HMAC-SHA256**: Cada entrada no log possui um selo criptográfico baseado em uma chave mestra.
- **Anti-Tampering**: Se um registro for alterado diretamente no banco de dados, o selo é quebrado, sinalizando fraude na próxima auditoria ou export de conformidade.

## 4. Caixa Negra & BYOK (Bring Your Own Key)
Privacidade total através de criptografia simétrica avançada.
- **AES-256-GCM**: Dados sensíveis e logs de execução são criptografados em repouso.
- **Crypto-Shredding**: A exclusão da chave mestra do tenant (`ORG_MASTER_KEY`) torna todos os dados históricos instantaneamente indecifráveis, cumprindo o direito ao esquecimento da LGPD.

## 5. Resiliência Operacional & FinOps
Governança financeira acoplada à segurança.
- **Token Budgeting**: Controle estrito de consumo via Redis.
- **Hard/Soft Caps**: Bloqueio automático de execução se o limite orçamentário for atingido.
- **Rate Limiting Distribuído**: Proteção anti-brute force em endpoints de Auth e SSO.

---
*Este manifesto atesta que a plataforma cumpre os requisitos técnicos da Resolução BCB 4.557/17 e as melhores práticas de IA Segura (OWASP Top 10 for LLMs).*
