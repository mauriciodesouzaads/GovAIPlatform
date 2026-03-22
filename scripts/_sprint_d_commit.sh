#!/bin/bash
set -e
git add 045_catalog_registry.sql scripts/migrate.sh scripts/seed.sql src/routes/assistants.routes.ts src/__tests__/routes.coverage.test.ts src/__tests__/catalog.lifecycle.test.ts
git commit -m "feat(sprint-d): Catalog Registry — lifecycle formal de capacidades

- 045_catalog_registry.sql: lifecycle_state, risk_level, owner_email,
  capability_tags em assistants; capability_runtime_bindings com RLS;
  catalog_reviews — trilha imutavel de revisoes (trigger BEFORE UPDATE/DELETE)
- assistants.routes: GET /catalog com filtros (lifecycle_state, risk_level, owner_id, search)
- assistants.routes: PUT /:id/metadata, submit-for-review, catalog-review, suspend, archive
- assistants.routes: GET/POST/DELETE /:id/runtime-bindings
- Guardrail: publicacao exige lifecycle_state = approved antes de promover a official
- seed.sql: demo assistant com lifecycle_state = official + description + risk_level
- routes.coverage.test: mock SQL dispatcher atualizado para guardrail lifecycle_state
- 8 novos testes (catalog.lifecycle.test.ts); total: 542 testes, 35 migrations

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
git push origin main
git log --oneline -3
rm -- "\$0"
