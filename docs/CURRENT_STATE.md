# GovAI GRC Platform — Estado Atual

> Gerado automaticamente em 2026-04-11 03:30 UTC por `scripts/generate-docs.sh`

## Métricas do Projeto

| Métrica | Valor |
|---------|-------|
| Migrations | 62 |
| Arquivos de rota | 20 |
| Endpoints HTTP | ~122 |
| Páginas UI | 24 |
| Workers BullMQ | 5 |
| Services | 1 |
| Libs compartilhadas | 39 |
| Componentes React | 15 |
| Testes automatizados | 70 |
| Containers Docker | 6 |
| Tabelas (migrations) | 64 |
| INSERTs no seed | 65 |

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
/webhooks
```

## Módulos de Rota (Backend)

```
admin.routes
approvals.routes
architect.routes
assistants.routes
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
webhook.routes
```

## Migrations (últimas 15)

```
058_rls_nullif_remediation.sql
059_exit_perimeter_tracking.sql
060_risk_scoring_and_evidence.sql
061_review_tracks_and_semver.sql
062_catalog_favorites.sql
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
```

## Containers Docker

```
  database
  redis
  litellm
  presidio
  api
  admin-ui
  pgdata
  redisdata
  govai-net
```

## Versão

- Tag: v1.0.0-rc1
- Commit: 9512f5a
- Branch: main
