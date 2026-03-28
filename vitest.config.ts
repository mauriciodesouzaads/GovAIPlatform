import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration.
 *
 * Integration tests (those requiring a live PostgreSQL + Redis) are excluded
 * from the default `npm test` run when DATABASE_URL is not set.
 * This prevents CI/unit-test runs from failing due to missing infrastructure
 * while preserving full coverage when the stack is running.
 *
 * To run all tests including integration:
 *   DATABASE_URL=postgresql://... npm test
 *
 * To run only integration tests:
 *   DATABASE_URL=postgresql://... npx vitest run --reporter=verbose \
 *     src/__tests__/governance.flow.test.ts \
 *     src/__tests__/governance.integration.test.ts \
 *     src/__tests__/security.tenant-isolation.test.ts \
 *     src/__tests__/compliance.guarantees.test.ts \
 *     src/__tests__/consultant.plane.test.ts
 */

const integrationTestPatterns = [
    'src/__tests__/governance.flow.test.ts',
    'src/__tests__/governance.integration.test.ts',
    'src/__tests__/security.tenant-isolation.test.ts',
    // Sprint E-FIX: testes de garantia com banco real (requerem DATABASE_URL)
    'src/__tests__/compliance.guarantees.test.ts',
    'src/__tests__/consultant.plane.test.ts',
    // Sprint F: Shield Core com banco real
    'src/__tests__/shield.core.test.ts',
    // Sprint F2a / Shield Complete: Collector + Risk Engine requerem DATABASE_URL
    'src/__tests__/shield.collector.test.ts',
    'src/__tests__/shield.risk-engine.test.ts',
    // Sprint S1-R: Network Collector + Multisource Resolution
    'src/__tests__/shield.network-collector.test.ts',
    'src/__tests__/shield.multisource-resolution.test.ts',
    // Sprint S2: Finding Workflow & Consultant Value
    'src/__tests__/shield.workflow.test.ts',
    // Sprint S3: Enterprise Hardening
    'src/__tests__/shield.collector-health.test.ts',
    'src/__tests__/shield.posture-history.test.ts',
    'src/__tests__/shield.export.test.ts',
    // Sprint A1: Architect Domain
    'src/__tests__/architect.domain.test.ts',
    // Sprint A4: Delegation Router — requires DATABASE_URL
    'src/__tests__/architect.delegation.test.ts',
];

const hasDatabase = Boolean(process.env.DATABASE_URL);

// Vitest default excludes — always preserved so node_modules tests don't run
const defaultExcludes = [
    '**/node_modules/**',
    '**/dist/**',
    '**/.{idea,git,cache,output,temp}/**',
    '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
    // Playwright E2E tests — run via `cd admin-ui && npx playwright test`, not vitest
    'admin-ui/e2e/**',
];

export default defineConfig({
    test: {
        // Integration tests only run when DATABASE_URL is set.
        // This keeps `npm test` fast and clean in environments without a DB.
        exclude: hasDatabase
            ? defaultExcludes
            : [...defaultExcludes, ...integrationTestPatterns],
        environment: 'node',
        globals: false,
        testTimeout: 30_000,
        hookTimeout: 15_000,
        reporters: ['verbose'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov', 'html'],
            reportsDirectory: './coverage',
            thresholds: {
                lines: 70,
                functions: 70,
                branches: 60,
                statements: 70,
            },
            include: [
                'src/lib/**',
                'src/routes/admin.routes.ts',
                'src/routes/assistants.routes.ts',
                'src/routes/approvals.routes.ts',
                'src/services/execution.service.ts',
                'src/jobs/api-key-rotation.job.ts',
            ],
            exclude: [
                'node_modules/**',
                'dist/**',
                'src/__tests__/**',
                'src/lib/opa/**/*.wasm',
                'vitest.config.*',
                '**/*.d.ts',
                'src/workers/**',
                'src/lib/rag.ts',
                'src/routes/reports.routes.ts',
            ],
        },
    },
});
