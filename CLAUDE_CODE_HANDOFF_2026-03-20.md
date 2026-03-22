# Claude Code Handoff — GovAI GRC Platform (2026-03-20)

## Objetivo
Este documento existe para impedir regressões e perda de contexto no desenvolvimento contínuo. Ele resume **o que já foi corrigido**, **o que ainda permanece pendente** e **quais hard gates de produção não podem mais ser violados**.

## Instrução mandatória
Não use mocks, placeholders, simulações, pseudocódigo, TODO/FIXME/HACK em fluxos críticos. Não reintroduza tokens em query string, fallback arbitrário de tenant (`LIMIT 1`), bypass de publicação, schema divergente do runtime, ou artefatos sujos no pacote de entrega.

## Correções já aplicadas nesta linha de trabalho
1. **API key auth runtime**
   - `src/server.ts`: autenticação por API key passou a validar `expires_at` diretamente em `api_key_lookup`, sem depender de `api_keys` sob RLS.
   - `src/routes/assistants.routes.ts`: revogação agora preenche `revoked_at` e `revoke_reason`.

2. **OIDC/SSO**
   - `src/routes/oidc.routes.ts`: JWT não vai mais em query string. O callback grava um código efêmero no Redis e o frontend troca esse código em `/v1/auth/oidc/session`.
   - `040_org_sso_lookup.sql`: tenant é resolvido por `org_sso_lookup`, não por fallback arbitrário.
   - `041_runtime_and_release_hardening.sql`: `organizations.sso_tenant_id` e `org_sso_lookup.org_id` agora são únicos.

3. **Identidade local e platform admin**
   - `039_identity_and_publish_hardening.sql`: `users.role` agora aceita `platform_admin`; emails locais precisam ser globalmente únicos em produção.
   - `src/server.ts`: existe `requirePlatformAdmin`.
   - `src/routes/admin.routes.ts`: foram expostas rotas globais explícitas de plataforma (`/v1/admin/platform/organizations`, `/v1/admin/platform/users`) em vez de misturar visualização tenant e global na mesma rota.

4. **Password flows**
   - `src/routes/admin.routes.ts`: `POST /v1/admin/change-password` agora valida a senha atual de verdade.
   - `src/routes/admin.routes.ts`: `POST /v1/admin/reset-password` usa token one-time guard em Redis e reaproveita a política forte de senha do backend.
   - `src/lib/schemas.ts`: política forte centralizada em `StrongPasswordSchema` e usada por change/reset.

5. **RAG / multi-tenant documents**
   - `037_documents_add_org_id.sql`: adiciona `org_id` em `documents`.
   - `src/lib/rag.ts` e `src/routes/assistants.routes.ts`: ownership da KB passou a ser validado antes da ingestão.
   - `041_runtime_and_release_hardening.sql`: trigger `ensure_document_kb_org_match()` impede `documents.org_id` incompatível com `knowledge_bases.org_id`.

6. **Publish / homologação**
   - `038_fix_version_publish_flow.sql` + `039_identity_and_publish_hardening.sql`: publicação formal usa `assistant_publication_events` com `checklist_jsonb`.
   - `src/routes/assistants.routes.ts`: bypass `publish: true` foi bloqueado; criação de versão deve permanecer draft; publicação deve passar por `/approve`.

7. **Frontend auth/session**
   - `admin-ui/src/lib/auth-storage.ts`: token foi migrado para `sessionStorage` com fallback de leitura temporário para `localStorage` apenas para migração.
   - `admin-ui/src/lib/api.ts`, `AuthProvider.tsx`, `login/page.tsx`, `compliance/page.tsx`: atualizados para o helper novo.

8. **Migrations / CI**
   - `scripts/migrate.sh`: agora aplica migrations sem abrir transação externa por cima de migrations que já possuem `BEGIN/COMMIT`; tracking só é escrito após sucesso real.
   - `.github/workflows/ci-cd.yml`: endurecido para incluir build do frontend e falhar duro em deploy/migration críticos.

## Pendências ainda abertas (não perder de vista)
1. **Frontend ainda usa token acessível a JS**
   - Melhor que `localStorage`, mas ainda não é o ideal para painel administrativo. O alvo final continua sendo sessão mais segura (ex.: cookie `httpOnly` ou arquitetura equivalente sem expor bearer persistente ao JS).

2. **SSO precisa de validação integrada real**
   - Validar Microsoft + Okta em ambiente limpo, incluindo claims, mapeamento tenant e criação/atualização de usuário.

3. **Testes reais ainda precisam fechar o ciclo**
   - Adicionar/rodar testes de integração para: API key auth, OIDC, reset de senha, ingestão RAG e approve publish.

4. **Runner de migrations**
   - O script foi corrigido para não aninhar transações, mas Claude deve validar todas as migrations em banco limpo do zero e em banco já parcialmente migrado.

## Hard gates para Claude Code
- Não reintroduzir query string com JWT/token.
- Não usar `LIMIT 1` para escolher tenant/organização.
- Não usar `as any` em fluxos centrais de auth/governança.
- Não manter schema divergente do runtime.
- Não permitir caminho alternativo de publicação fora do approve formal.
- Não empacotar `.env`, `.git`, `node_modules`, `.next`, `dist`, `coverage`, backups ou relatórios operacionais no artefato de entrega.

## Ordem recomendada para continuar
1. Validar migrations 035–041 em banco limpo.
2. Rodar smoke tests reais de login local, reset inicial, OIDC Microsoft/Okta e API key auth.
3. Fechar testes de integração de publish/homologação.
4. Endurecer definitivamente o modelo de sessão do painel.
5. Fazer nova auditoria go/no-go antes de qualquer release.
