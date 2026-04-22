---
from_level: 3
to_level: 1
locale: pt-BR
version: 1.0.0
---

# Você está reduzindo o nível de proteção para Fluxo Livre (Nível 1)

## Esta é uma redução significativa de controles. Leia com muito cuidado.

Ao sair do Nível 3 (Blindagem Máxima), você está **desativando dois conjuntos de controles** de uma vez: classificação de ferramentas + segregação de responsabilidades.

## O que permanece ativo no Nível 1

- DLP bloqueando prompts e respostas com dados sensíveis.
- Monitoramento automático de custo e limite.
- Auditoria completa de cada interação com registro imutável.
- Políticas de negação executadas automaticamente.

## O que deixa de existir

- **Classificação de ferramentas em tempo de execução**: agentes (Claude Code, OpenClaude) voltam a usar ferramentas nativamente — não há mais pausa no nível da GovAI para ferramentas destrutivas.
- **Segregação de responsabilidades**: publicação de políticas, avaliações de risco e aprovação de exceções passam a permitir que uma mesma pessoa solicite e aprove a própria ação.
- **Não-conformidade com SOC 2** para os controles que dependem de SoD (CC6.1, CC7.2, CC8.1).

## Impacto esperado

- Execuções de agentes voltam a ser contínuas e rápidas.
- Equipes de risco/compliance precisam ser notificadas — se sua organização passa por auditoria (SOC 2, ISO 27001, etc.), registre formalmente a decisão e a justificativa.
- Qualquer integração externa que consome a API da GovAI e esperava respostas com estado "aguardando aprovação" deixará de recebê-las — revise os callers.

## Esta mudança fica registrada

Ao confirmar, sua identidade, o horário exato e o texto deste aviso ficarão registrados em um evento imutável da plataforma. Esse registro torna explícita a decisão organizacional de reduzir significativamente os controles.

---

Para voltar ao Nível 2 ou 3, você passará por outro aviso de mudança.
