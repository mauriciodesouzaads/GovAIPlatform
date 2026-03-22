# Audit Fixes Applied — 2026-03-20

## Backend
- API key authentication now validates `expires_at` directly from `api_key_lookup`, removing the broken dependency on `api_keys` under RLS.
- Added strong password policy reuse for first-login reset and authenticated password change.
- Reworked `/v1/admin/change-password` into a real authenticated password change flow with current-password verification and row-count enforcement.
- Local login now resolves `user_lookup` and `users` case-insensitively by email.
- OIDC callbacks no longer place JWTs in query strings.
- OIDC now resolves organization through an explicit public lookup table (`org_sso_lookup`) instead of arbitrary tenant fallback.
- OIDC frontend session bootstrap now uses one-time authorization codes stored in Redis.
- OIDC user provisioning now binds to a resolved org and either reuses or provisions a user deterministically.
- Assistant version creation no longer allows direct publish bypass; publication must go through the formal homologation route.
- Assistant homologation now records immutable publication events with checklist evidence and actor identity.
- Assistant listing now excludes already-published draft versions from `draft_version_id` resolution.
- RAG ingestion now validates that the requested KB belongs to the authenticated organization before vectorization.
- `ingestDocument()` now enforces KB ownership at the service layer as well.

## Database / Migrations
- Added `039_identity_and_publish_hardening.sql`:
  - allows `platform_admin` in the application role constraint
  - adds case-insensitive uniqueness for local user emails
  - normalizes `user_lookup` to lowercase emails
  - adds `checklist_jsonb` to `assistant_publication_events`
- Added `040_org_sso_lookup.sql`:
  - public lookup table for pre-context SSO tenant resolution
  - trigger-based synchronization from `organizations`

## Frontend
- Login page now exchanges a one-time `auth_code` for a JWT instead of reading JWT from the URL.
- Removed placeholder comment from first-login password reset flow.
- Simplified client session model to bearer-only for the admin UI.
- `AuthProvider` now validates stored tokens against `/v1/admin/me` instead of relying on stale client-side decode only.
- Assistant UI now uses the formal homologation endpoint instead of publishing directly during version creation.
- “Nova Versão” flow now creates a draft instead of auto-publishing.

## CI/CD
- Pipeline now builds the frontend in the main lint/build gate.
- Migration execution in CI now fails hard with `ON_ERROR_STOP=1`.
- Removed permissive deploy behavior that previously tolerated migration/deploy failures.

## Governance
- Added `docs/PRODUCTION_HARD_GATES.md` with explicit prohibitions against mocks, placeholders, token-in-URL, arbitrary tenant fallback, partial runtime/schema divergence and dirty release artifacts.

## Backend / Auth / Runtime (2nd hardening pass)
- `adminRoutes` now exposes explicit platform-only routes (`/v1/admin/platform/organizations`, `/v1/admin/platform/users`) under `requirePlatformAdmin`, instead of relying on unreachable implicit branches.
- API key revocation now persists `revoked_at` and `revoke_reason`, improving credential auditability.

## Database / Migrations (2nd hardening pass)
- Added `041_runtime_and_release_hardening.sql`:
  - enforces uniqueness of non-local SSO identities (`sso_provider`, `sso_user_id`)
  - enforces uniqueness of `organizations.sso_tenant_id` and `org_sso_lookup.org_id`
  - adds a trigger to ensure `documents.org_id` always matches `knowledge_bases.org_id`
- `scripts/migrate.sh` now applies migrations without wrapping them in a conflicting outer transaction and now includes migrations 035–041 in the ordered list.

## Frontend / Session (2nd hardening pass)
- Added `admin-ui/src/lib/auth-storage.ts` and moved admin token handling to session-scoped storage helpers.
- `api.ts`, `AuthProvider`, `login` and `compliance` pages now read/write auth tokens through the centralized helper instead of direct `localStorage` access.

## Handoff / Governance (2nd hardening pass)
- Added `CLAUDE_CODE_HANDOFF_2026-03-20.md` documenting completed fixes, remaining work, hard gates and continuation order for Claude Code.
