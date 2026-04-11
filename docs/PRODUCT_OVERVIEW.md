# GovAI GRC Platform — Visão Geral do Produto

## O Problema

Empresas reguladas (bancos, seguradoras, saúde, governo) estão adotando IA generativa mas enfrentam 3 desafios:

1. **Compliance regulatório**: EU AI Act, LGPD Art. 20, BACEN 4.557, ISO 42001, CNJ 615 exigem governança de IA — e a maioria das empresas não tem ferramentas para isso.
2. **Shadow AI**: funcionários usam ChatGPT, Gemini, Claude sem conhecimento da TI — criando risco de vazamento de dados e não-conformidade.
3. **Falta de rastreabilidade**: quando o auditor pergunta "mostre todas as decisões que essa IA tomou nos últimos 6 meses", ninguém consegue responder.

## A Solução

O GovAI é um **sistema de registro para IA** — assim como o ServiceNow é para TI. Três produtos integrados:

### 🛡️ GOV.AI Gateway
Pipeline de execução com 9 etapas de segurança. Toda interação com IA passa pelo Gateway, que:
- Mascara dados pessoais automaticamente (CPF, email, telefone) com DLP configurável
- Bloqueia tentativas de jailbreak
- Pausa execuções sensíveis para aprovação humana (HITL)
- Registra tudo em audit trail imutável com assinatura SHA-256

### 📚 Catálogo de Agentes
Lifecycle completo: rascunho → revisão → produção → aposentado. Cada assistente tem:
- Ficha técnica (Model Card) com limitações, vieses e responsáveis
- Avaliação de risco com 25 perguntas e score automático
- Controle de versão com diff visual de prompts

### 🔍 Shadow AI Shield
Detecta uso não autorizado de IA na organização. Dashboard com score de postura de segurança.

---

## Compliance Integrado

O GovAI mapeia **33 controles** de 5 frameworks regulatórios e avalia automaticamente quais a organização já atende:

| Framework | Região | Controles | Auto-avaliados |
|-----------|--------|-----------|----------------|
| EU AI Act | UE | 8 | 6 |
| LGPD | BR | 7 | 5 |
| BACEN Res. 4.557 | BR | 6 | 5 |
| ISO/IEC 42001 | Internacional | 6 | 4 |
| CNJ Res. 615 | BR | 6 | 4 |
| **Total** | | **33** | **24 automáticos** |

---

## Monitoramento Contínuo

Dashboard em tempo real com:
- Execuções/hora, violações/hora, latência p95
- Alertas configuráveis (threshold de latência, taxa de violação, custo diário)
- Trends de 30 dias com ranking de assistentes
- Notificações Slack/Teams por tipo de evento

---

## DLP Configurável

- 5 detectores nativos (CPF, email, telefone, nomes, cartão de crédito)
- Detectores custom (regex e lista de palavras-chave)
- 3 ações: mascarar, bloquear, alertar
- Regras por assistente (ex: Jurídico pode ver CPF, FAQ não)

---

## Independência de Provedor

O GovAI funciona com **qualquer LLM** — OpenAI, Anthropic, Google, Groq, Mistral, Azure, Ollama (local). O cliente troca de provedor sem mudar código. Para ambientes air-gapped, suporta modelos locais via Ollama/vLLM.

---

## Diferencial vs Concorrência

| Critério | GovAI | CredoAI | Holistic AI |
|----------|-------|---------|-------------|
| Gateway de execução | ✅ Pipeline 9-estágios | ❌ | ❌ |
| DLP configurável | ✅ mask/block/alert | ❌ | Parcial |
| Audit trail imutável | ✅ HMAC-SHA256 | Parcial | Parcial |
| HITL (aprovação humana) | ✅ Nativo | ❌ | ❌ |
| Shadow AI detection | ✅ Shield | ❌ | ✅ |
| Multi-provider LLM | ✅ 100+ providers | N/A | N/A |
| Compliance frameworks | ✅ 5 frameworks, 33 controles | ✅ | ✅ |
| Risk assessment wizard | ✅ 25 perguntas, PDF export | ✅ | ✅ |
| Self-hosted / air-gapped | ✅ Docker | ❌ SaaS only | ❌ SaaS only |
| Preço | Competitivo | Enterprise ($$$) | Enterprise ($$$) |

---

## Arquitetura

```
[Usuário] → [API Gateway (9 estágios)] → [LiteLLM Proxy] → [Qualquer LLM]
                    ↓                            ↓
              [PostgreSQL]              [Slack/Teams Alerts]
              [Audit Logs]              [Langfuse Traces]
              [Redis Cache]
```

6 containers Docker. Deploy em 30 minutos. Suporta Kubernetes.

---

## Próximos Passos

- **SDK TypeScript/Python** — integração em 3 linhas de código
- **SIEM Streaming** — export para Splunk/Datadog via Kafka/SQS
- **Marketplace** — templates pré-configurados de assistentes
- **Certificação Digital** — assinatura digital de relatórios de auditoria
