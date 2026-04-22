---
from_level: 2
to_level: 3
locale: pt-BR
version: 1.0.0
---

# Você está elevando o nível de proteção para Blindagem Máxima (Nível 3)

## O que permanece (já estava ativo no Nível 2)

- DLP bloqueia prompts e respostas com dados sensíveis.
- Monitoramento automático de custo e limite por organização.
- Auditoria completa de cada interação com registro imutável.
- Políticas de negação executadas automaticamente.
- **Segregação de responsabilidades** em publicação de políticas, avaliações de risco e exceções.

## O que será ativado agora

- **Classificação de ferramentas em tempo de execução**: toda ferramenta usada por agentes (Claude Code, OpenClaude) será classificada como leitura segura ou escrita/execução/rede.
- **Pausa para autorização humana**: ferramentas classificadas como destrutivas (escrita em disco, execução de comandos, acesso à rede) pausarão a execução e aguardarão autorização explícita de um operador.
- Modo `auto_all` / `auto_safe` continua disponível por trabalho, permitindo que o usuário pré-autorize uma execução inteira.

## Impacto na experiência

- Execuções de agentes que hoje são contínuas podem ficar em espera por minutos ou horas aguardando aprovação humana em cada ferramenta destrutiva.
- Operadores com permissão de aprovação precisam estar disponíveis durante o horário de uso.
- Integrações programáticas que disparam agentes devem estar preparadas para lidar com o estado "aguardando aprovação".

## Esta mudança fica registrada

Ao confirmar, sua identidade, o horário exato e o texto deste aviso ficarão registrados em um evento imutável da plataforma.

---

Para voltar ao Nível 1 ou 2, você passará por outro aviso de mudança.
