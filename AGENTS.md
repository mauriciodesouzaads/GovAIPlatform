# GovAI Platform — Automated Agent Instructions

## Before making any change
1. Run npm test — ensure 421+ tests pass
2. Check git status — commit or stash pending changes
3. Read the relevant source file before editing

## Security rules (never violate)
- Never add fallback values to secrets (no || 'default')
- Never use message raw in RAG — always safeMessage
- Never bypass RLS without SET ROLE platform_admin + RESET ROLE
- Never commit .env files or API keys

## After making changes
1. Run npm test — zero regressions
2. Run npm run lint — zero TypeScript errors
3. If docker changes: docker compose build --no-cache api
4. Verify with curl -s http://localhost:3000/health
