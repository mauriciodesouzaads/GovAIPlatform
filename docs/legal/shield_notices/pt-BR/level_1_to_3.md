---
from_level: 1
to_level: 3
locale: pt-BR
version: 1.0.0
---

# Você está elevando o nível de proteção para Blindagem Máxima (Nível 3)

## O que permanece (já estava ativo no Nível 1)

- DLP bloqueia prompts e respostas com dados sensíveis (CPF, RG, cartão de crédito, dados médicos).
- Monitoramento automático de custo e limite por organização.
- Auditoria completa de cada interação com registro imutável.
- Políticas de negação executadas automaticamente.

## O que será ativado agora

- **Segregação de responsabilidades** em ações formais: publicação de políticas, avaliações de risco e exceções de segurança passarão a exigir aprovador diferente do solicitante.
- **Classificação de ferramentas em tempo de execução**: toda ferramenta usada por agentes (Claude Code, OpenClaude) será classificada como leitura segura ou escrita/execução/rede.
- **Pausa para autorização humana**: ferramentas classificadas como destrutivas (escrita em disco, execução de comandos, acesso à rede) pausarão a execução e aguardarão autorização explícita de um operador da sua organização.

## Impacto na experiência de seus usuários

- Execuções que hoje são instantâneas podem ficar em espera por minutos ou horas aguardando aprovação humana.
- Será necessário ter um operador com permissão de aprovação disponível durante o horário de uso.
- Publicação de políticas passa de 1 para 2 passos (solicitação + aprovação).
- Algumas integrações programáticas podem precisar ser adaptadas para lidar com o estado "aguardando aprovação".

## Esta mudança fica registrada

Ao confirmar, sua identidade, o horário exato e o texto deste aviso ficarão registrados em um evento imutável da plataforma. Esse registro é recuperável a qualquer momento pela auditoria e constitui evidência da decisão organizacional.

---

Para reverter, você precisará passar por outro aviso de mudança de nível.
