# SNAPSHOT_SCOPE — GovAI GRC Platform Audit Snapshot

This document defines the canonical file selection rules and size constraints for
audit snapshots produced by `scripts/generate_audit_zip.sh`.

---

## Constraints

| Constraint     | v1 (baseline) | v2 (extended) |
|---------------|---------------|---------------|
| Max files     | 120           | 130           |
| Max size      | 35 MB         | 35 MB         |
| Format        | `.zip`        | `.zip`        |

---

## Included Scopes

### Backend (`src/`)

| Path pattern                        | Rationale                                      |
|------------------------------------|------------------------------------------------|
| `src/index.ts`                     | Entry point — server boot, plugin registration |
| `src/app.ts`                       | Fastify app factory                            |
| `src/services/execution.service.ts`| Critical pipeline — governance + LLM dispatch |
| `src/lib/schemas.ts`               | Zod schemas — API input validation             |
| `src/lib/opa-governance.ts`        | OPA policy evaluation engine                  |
| `src/lib/dlp-engine.ts`            | DLP / PII detection and masking                |
| `src/lib/shield.ts`                | Shield facade — re-exports all service modules |
| `src/lib/shield-*.service.ts`      | Shield domain service files (5 modules)        |
| `src/routes/shield.routes.ts`      | Shield route orchestrator                      |
| `src/routes/shield-admin.routes.ts`| Admin routes (32 endpoints)                   |
| `src/routes/shield-consultant.routes.ts` | Consultant read-only routes             |
| `src/routes/*.routes.ts`           | All other domain routes                        |
| `src/lib/*.ts`                     | Core library modules                           |
| `src/workers/*.ts`                 | BullMQ workers                                 |

### Migrations (`migrations/`)

All files matching `migrations/0*.sql` — sequential migration history.

### Tests (`src/__tests__/`)

Core test files covering security, execution, DLP/HITL, and integration paths.
See `docs/TEST_MANIFEST.md` for the authoritative list.

### Admin UI (`admin-ui/src/`)

| Path pattern                        | Rationale                                      |
|------------------------------------|------------------------------------------------|
| `admin-ui/src/app/*/page.tsx`      | All admin UI pages                             |
| `admin-ui/src/components/*.tsx`    | Shared components (Sidebar, AuthProvider, etc.)|
| `admin-ui/src/lib/api.ts`          | API endpoint definitions                       |
| `admin-ui/package.json`            | Dependency manifest                            |

### Scripts & Config

| File                               | Rationale                                      |
|------------------------------------|------------------------------------------------|
| `scripts/audit_project_state.sh`   | Canonical audit doc generator                  |
| `scripts/migrate.sh`               | Migration runner                               |
| `scripts/test-migrations-clean.sh` | Migration integrity checker                    |
| `package.json`, `tsconfig.json`    | Project manifests                              |
| `vitest.config.ts`                 | Test runner configuration                      |

### Documentation

| File                               | Rationale                                      |
|------------------------------------|------------------------------------------------|
| `docs/CURRENT_STATE.md`            | Canonical project state (auto-generated)       |
| `docs/TEST_MANIFEST.md`            | Test coverage manifest (auto-generated)        |
| `docs/PRODUCT_SURFACE.md`          | API surface reference (auto-generated)         |
| `docs/OPERATIONS.md`               | Runbook for ops team                           |
| `docs/PRODUCTION_HARD_GATES.md`    | Non-negotiable security requirements           |
| `docs/SNAPSHOT_SCOPE.md`           | This file                                      |
| `docs/ADR-*.md`                    | Architecture Decision Records                  |
| `README.md`                        | Project README (auto-generated)                |

---

## Excluded Scopes

The following are explicitly excluded from audit snapshots:

- `node_modules/`, `.next/`, `dist/`, `build/` — generated artefacts
- `.env`, `.env.*` — secrets (never committed, never snapshotted)
- `*.log` — volatile runtime output
- `admin-ui/.next/` — Next.js build cache
- `coverage/` — test coverage HTML reports
- `docs/assets/` subdirectory unless explicitly named

---

## Regenerating a Snapshot

```bash
# Standard snapshot (≤ 120 files, ≤ 35 MB)
bash scripts/generate_audit_zip.sh

# Extended snapshot (≤ 130 files, ≤ 35 MB)
bash scripts/generate_audit_zip.sh --v2
```

Snapshots are named `govai_audit_snapshot_YYYYMMDD.zip` (v1) and
`govai_audit_snapshot_YYYYMMDD_v2.zip` (v2).

---

*This document is maintained manually. Update it when the snapshot scope changes.*
