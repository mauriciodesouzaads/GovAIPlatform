---
from_level: 3
to_level: 2
locale: pt-BR
version: 1.0.0
---

# Você está reduzindo o nível de proteção para Conformidade (Nível 2)

## Esta é uma redução parcial de controles. Leia com atenção.

Ao sair do Nível 3 (Blindagem Máxima), você está **desativando a classificação de ferramentas em tempo de execução e a pausa para autorização humana**.

A segregação de responsabilidades em ações formais **continua ativa** — este movimento não quebra SoD.

## O que permanece ativo no Nível 2

- DLP bloqueando prompts e respostas com dados sensíveis.
- Monitoramento automático de custo e limite.
- Auditoria completa de cada interação com registro imutável.
- Políticas de negação executadas automaticamente.
- **Segregação de responsabilidades** em publicação de políticas, avaliações de risco e aprovação de exceções.

## O que deixa de existir

- **Classificação de ferramentas em tempo de execução**: agentes (Claude Code, OpenClaude) voltam a usar ferramentas nativamente.
- **Pausa para autorização humana** em ferramentas destrutivas (escrita em disco, execução de comandos, acesso à rede): não haverá mais espera no nível da GovAI — a aprovação do runtime será considerada suficiente.

## Impacto esperado

- Execuções de agentes voltam a ser contínuas e rápidas.
- Ainda há SoD em ações formais, mantendo parte da conformidade com SOC 2 (CC7.2, CC8.1).
- Integrações externas que esperam o estado "aguardando aprovação" para ferramentas destrutivas deixarão de recebê-lo — revise os callers.

## Esta mudança fica registrada

Ao confirmar, sua identidade, o horário exato e o texto deste aviso ficarão registrados em um evento imutável da plataforma. Esse registro deixa explícita a decisão de relaxar os controles de tool-use sem perder SoD.

---

Para voltar ao Nível 3 ou descer ainda mais, você passará por outro aviso.
