# Production Hard Gates

## Proibido em qualquer fluxo crítico
- mocks, placeholders, simulações, pseudocódigo
- JWT/token em query string
- fallback arbitrário de tenant (`LIMIT 1`)
- TODO/FIXME/HACK em auth, autorização, publish, billing, compliance, DLP, RAG, migrations ou CI/CD
- schema divergente do runtime real
- bypass de governança/publicação
- artefatos sujos no pacote de entrega

## Release só passa se
- backend compilar em ambiente limpo
- frontend compilar em ambiente limpo
- migrations aplicarem do zero e incrementalmente
- smoke tests reais de login, reset, OIDC, API key e publish passarem
- pacote final não contiver `.env`, `.git`, `node_modules`, `.next`, `dist`, `coverage`, backups ou relatórios operacionais
