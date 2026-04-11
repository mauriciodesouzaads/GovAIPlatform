# GovAI GRC Platform — Estado Atual

> Gerado automaticamente em 2026-04-11 15:25 UTC por `scripts/generate-docs.sh`

## Métricas do Projeto

| Métrica | Valor |
|---------|-------|
| Migrations | 67 |
| Arquivos de rota | 23 |
| Endpoints HTTP | ~124 |
| Páginas UI | 25 |
| Workers BullMQ | 6 |
| Services | 1 |
| Libs compartilhadas | 42 |
| Componentes React | 15 |
| Testes automatizados | 158 |
| Containers Docker | 7 |
| Tabelas (migrations) | 68 |
| INSERTs no seed | 75 |

## Páginas da UI

```
/
/api-keys
/approvals
/architect
/assistants
/catalog
/chat/[assistantId]
/compliance
/compliance-hub
/consultant
/evidence/[assistantId]
/exceptions
/login
/logs
/organizations
/playground
/policies
/reports
/risk-assessment/[assistantId]
/settings
/settings/dlp
/settings/notifications
/shield
/skills
/webhooks
```

## Módulos de Rota (Backend)

```
admin.routes
approvals.routes
architect.routes
assistants.routes
chat.routes
compliance-hub.routes
consultant.routes
dlp.routes
model-card.routes
monitoring.routes
notification-channels.routes
oidc.routes
platform.routes
policies.routes
reports.routes
risk-assessment.routes
settings.routes
shield-admin.routes
shield-consultant.routes
shield.routes
skills.routes
webhook.routes
workflow-templates.routes
```

## Migrations (últimas 15)

```
063_review_tracks_customizable.sql
064_retention_config_and_archive.sql
065_mcp_tool_call_actions.sql
066_drop_old_audit_action_check.sql
067_compliance_frameworks.sql
068_model_cards.sql
069_risk_assessments.sql
070_alert_thresholds.sql
071_dlp_rules.sql
072_notification_channels.sql
073_architect_openclaude.sql
074_catalog_skills_and_templates.sql
075_delegation_config.sql
076_architect_runtime_tracking.sql
077_architect_work_item_events.sql
```

## Containers Docker

```
  database
  redis
  litellm
  presidio
  api
  admin-ui
  openclaude-runner
  pgdata
  redisdata
  openclaude_workspaces
```

## Versão

- Tag: v1.0.0-rc1-7-gfdc4107
- Commit: fdc4107
- Branch: main
