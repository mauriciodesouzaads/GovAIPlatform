---
from_level: 1
to_level: 2
locale: pt-BR
version: 1.0.0
---

# Você está elevando o nível de proteção para Conformidade (Nível 2)

## O que permanece (já estava ativo no Nível 1)

- DLP bloqueia prompts e respostas com dados sensíveis (CPF, RG, cartão de crédito, dados médicos).
- Monitoramento automático de custo e limite por organização.
- Auditoria completa de cada interação com registro imutável.
- Políticas de negação executadas automaticamente.
- Runtimes (Claude Code, OpenClaude) continuam usando ferramentas nativamente — a aprovação do runtime continua sendo a autorização aceita.

## O que será ativado agora

- **Segregação de responsabilidades** em ações formais: publicação de políticas, avaliações de risco e aprovação de exceções de segurança passarão a exigir aprovador diferente do solicitante.
- **Dois passos** para ações formais: o solicitante registra a intenção; outro usuário com papel compatível a aprova.

## Impacto na experiência

- Uso operacional do dia-a-dia (chat, execução de assistentes, uso de ferramentas) **não muda**.
- Apenas ações formais passam a exigir dois usuários distintos. Você precisa garantir que há pelo menos dois operadores com permissão de aprovação antes de ativar este nível.
- Publicação de políticas passa de 1 para 2 passos (solicitação + aprovação).

## Esta mudança fica registrada

Ao confirmar, sua identidade, o horário exato e o texto deste aviso ficarão registrados em um evento imutável da plataforma. Esse registro é recuperável a qualquer momento pela auditoria e constitui evidência da decisão organizacional.

---

Para reverter, você precisará passar por outro aviso de mudança de nível.
