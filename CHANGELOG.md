# Changelog — GovAI Platform

All notable changes to this project are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and
[Semantic Versioning](https://semver.org/).

---

## [1.0.0] — 2026-03-15

### Added

#### Core Governance Pipeline
- Full governance pipeline: DLP → OPA WASM → HITL → LLM execution
- OPA WASM policy engine with OWASP LLM Top 10 coverage (144 policy tests)
- Data Loss Prevention (DLP) with Presidio NLP + Regex patterns (CPF, CNPJ, PIX, e-mail, credit card)
- Human-in-the-Loop (HITL) approval queue with BullMQ + Redis
- HMAC-signed immutable audit logs with partitioned PostgreSQL table

#### API & Backend
- 33 REST endpoints with JWT authentication + OIDC SSO (Fastify)
- Multi-tenant architecture with PostgreSQL Row-Level Security (isolated by `org_id`)
- RAG Knowledge Base with pgvector embeddings (768 dimensions, HNSW index)
- API Key management with TTL-based rotation (90-day default, BullMQ cron)
- Rate limiting per endpoint (login: 10/15min, execute: 100/1min)
- Security headers via `@fastify/helmet` (CSP, HSTS, X-Frame-Options)
- Zod schema validation on all request bodies
- Webhook notifications and telemetry workers (BullMQ)

#### Admin UI
- Next.js 14 admin interface with 9 screens
- Interactive Playground with Gemini 2.5-flash (real LLM responses)
- Playground history (last 5 executions, localStorage), latency badge, model badge
- Dashboard with real-time stats (executions, violations, pending approvals)
- Assistants management (create, publish, archive, knowledge base upload)
- HITL approval/rejection workflow UI
- Reports screen with compliance data and audit log integrity verification

#### Infrastructure & DevOps
- CI/CD pipeline with 5 GitHub Actions jobs (lint, unit tests, integration, security scan, Docker build)
- Gitleaks secret scanning in CI
- Trivy vulnerability scanning in CI
- Docker multi-stage build with non-root user (`govai`, UID 1001)
- `docker-compose.prod.yml` with resource limits, named volumes, no host port bindings
- Nginx reverse proxy config (TLS 1.2/1.3, rate limiting zones, HSTS, CSP)
- Deploy guides for VPS (Ubuntu 22.04), AWS ECS+RDS, GCP Cloud Run, Render.com
- Idempotent demo seed (`scripts/seed.sql` + `scripts/seed.sh`)
- Container entrypoint: auto-runs migrations → seed → API start

#### Testing
- 460 unit tests across 35 test files (Vitest)
- 5 E2E tests with Playwright (login, dashboard, assistants, playground, HITL)
- Coverage gates: lines ≥ 70%, functions ≥ 70%, branches ≥ 60%

### Security

- Row-Level Security on all tenant-scoped tables (`api_keys`, `assistants`, `knowledge_bases`, `pending_approvals`, `audit_logs_partitioned`)
- Superuser bypass via `SET ROLE platform_admin` (prevents RLS escape in workers)
- Bcrypt (cost 12) for password hashing; HMAC-SHA256 for API key hashing
- HMAC-SHA256 for audit log integrity signatures
- Immutable audit trigger (UPDATE/DELETE raise exception)
- OPA policy: blocks PII exfiltration, prompt injection, jailbreak attempts
- `api_key_lookup` view for zero-RLS auth resolution (P-01 fix)
- Credential scanning baseline (`.gitleaks.toml`)

### Infrastructure Changes

- PostgreSQL 15 with `uuid-ossp` and `pgvector` extensions
- Redis 7 with password auth and `maxmemory-policy allkeys-lru`
- LiteLLM proxy (Gemini 2.5-flash backend)
- Presidio Analyzer (Portuguese + English NLP entity recognition)
- Langfuse observability integration
- Prometheus + Grafana + Alertmanager stack in production compose

---

## [0.x] — Pre-release sprints (internal)

| Sprint | Focus |
|--------|-------|
| S1–S2  | Initial API scaffold, JWT auth, basic RLS |
| S3–S4  | OPA WASM integration, DLP, HITL queue |
| S5     | Admin UI, Playwright E2E, coverage gates |
| S6     | Production deploy artifacts (nginx, VPS script, GitHub Actions deploy job) |
| S7     | RAG upload pipeline, reports, Playground improvements |
| S8     | Repository rename → GovAI GRC Platform |
| S9     | Persistent seed, container entrypoint, stable demo data |
| S10    | v1.0.0 release tag, GitHub topics, CHANGELOG |
